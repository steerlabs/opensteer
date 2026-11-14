import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ModelSelectionSchema, heldToolCallTimeoutMs } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createHarnessRegistry, parseAgentExecutionConfig } from "@opensteer/runner";
import { isRecord } from "@opensteer/shared/isRecord";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexStdioClient } from "@opensteer/harness-codex/test-support";
import {
  qualificationAccount,
  qualificationHoldMs,
  qualifiedEngines,
  qualifiedVersion,
  shippedEnginesFirstOnPath,
} from "../agents/engine-qualification.test-support.js";
import { startVerticalStack, type VerticalStack } from "../agents/vertical-stack.test-support.js";
import { SavedLoginService } from "./saved-logins.js";

const holdEngines = qualifiedEngines.flatMap((engine) => {
  const holdMs = qualificationHoldMs[engine.driverKind];
  return holdMs === undefined ? [] : [{ ...engine, holdMs }];
});

interface NativeItem {
  readonly at: number;
  readonly method: string;
  readonly id: unknown;
  readonly type: unknown;
  readonly server: unknown;
  readonly tool: unknown;
  readonly receivedMarker: boolean;
}

describe.each(holdEngines)("$label held MCP", (engine) => {
  let stack: VerticalStack | undefined;
  let restorePath: (() => Promise<void>) | undefined;
  let runtimeCacheDirectory: string | undefined;
  beforeEach(async () => {
    if (engine.executable === "shipped") restorePath = await shippedEnginesFirstOnPath();
    runtimeCacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-held-mcp-runtime-"));
  });
  afterEach(async () => {
    try {
      await stack?.close();
    } finally {
      stack = undefined;
      await restorePath?.();
      restorePath = undefined;
      if (runtimeCacheDirectory) await rm(runtimeCacheDirectory, { force: true, recursive: true });
      runtimeCacheDirectory = undefined;
    }
  }, 60_000);

  it("receives one use_saved_login result after the old MCP deadline", async () => {
    const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
    if (!databaseUrl || !runtimeCacheDirectory)
      throw new Error("Run through pnpm test:engines with a throwaway PostgreSQL database");
    const evidenceRoot =
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-sign-in-timeouts", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    const { holdMs } = engine;
    const began = performance.now();
    const holdLifetime = new AbortController();
    const nativeItems: NativeItem[] = [];
    let enteredAt: number | undefined;
    let releasedAt: number | undefined;
    let marker = "";
    let calls = 0;
    let lastAnswer = "";
    let version: string | undefined;
    if (engine.driverKind === "codex") {
      const start = CodexStdioClient.start;
      vi.spyOn(CodexStdioClient, "start").mockImplementation((options) =>
        start({
          ...options,
          onMethodMessage: (message, bytes) => {
            const item = isRecord(message.params) ? message.params.item : undefined;
            if (isRecord(item) && ["item/started", "item/completed"].includes(message.method)) {
              nativeItems.push({
                at: performance.now(),
                method: message.method,
                id: item.id,
                type: item.type,
                server: item.server,
                tool: item.tool,
                receivedMarker:
                  marker.length > 0 && JSON.stringify(item.result ?? null).includes(marker),
              });
            }
            options.onMethodMessage(message, bytes);
          },
        }),
      );
    }
    vi.spyOn(SavedLoginService.prototype, "useSavedLogin").mockImplementation(async (input) => {
      calls += 1;
      if (calls > 1) throw new Error("The held use_saved_login call was replayed");
      enteredAt = performance.now();
      // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- Measures the real engine deadline; fake clocks cannot advance its process.
      await delay(holdMs + 1, undefined, { signal: holdLifetime.signal });
      marker = `HELD-${randomUUID()}`;
      releasedAt = performance.now();
      return {
        status: "ready",
        site: input.site,
        account: marker,
        loginRef: `lgn_${randomUUID().replaceAll("-", "")}`,
      };
    });
    try {
      version = await qualifiedVersion(engine);
      stack = await startVerticalStack({
        databaseUrl,
        catalogTimeoutMs: 180_000,
        runTimeoutMs: holdMs + 180_000,
        harnesses: createHarnessRegistry(
          parseAgentExecutionConfig(process.env).harnessExecutables,
          { nodeExecutable: process.execPath, runtimeCacheDirectory },
        ),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        harnessInstance: qualificationAccount(engine),
      });
      const model = stack.catalog.models.find((candidate) => candidate.isDefault);
      if (!model)
        throw new Error(`Engine supplied no default model. ${engine.signInGuidance ?? ""}`);

      const threadId = await stack.createThread({
        title: "Held sign-in transport qualification",
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          providerId: model.providerId,
          options: {},
        }),
      });
      const turn = await stack.sendMessage({
        threadId,

        text: `This is a fake-data transport test. Call use_saved_login exactly once with sessionId bsn_00000000-0000-4000-8000-000000000001, site https://example.test, reason Test held sign-in. This fake session does not need opening or inspecting. Wait for this same tool call to return after ${holdMs / 1_000} seconds. Do not retry it or run other tools while it is pending. The ready result's account field contains an unpredictable marker. Reply with exactly that marker after receiving it. Never browse, open files, or retrieve credentials.`,
      });
      lastAnswer = turn.assistantText;
      expect(calls).toBe(1);
      expect(enteredAt).toBeDefined();
      expect(releasedAt).toBeDefined();
      if (enteredAt === undefined || releasedAt === undefined)
        throw new Error("The held call never returned");
      expect(releasedAt - enteredAt).toBeGreaterThanOrEqual(holdMs);
      expect(marker).not.toBe("");
      // The model may say what it is doing before the call; its reply is the last line.
      expect(turn.assistantText.trim().split("\n").at(-1)).toBe(marker);
      const started = turn.events
        .filter((event) => event.type === "tool.started")
        .filter((event) => event.data.tool.name === "use_saved_login");
      // Claude restates a streamed call once with its full arguments, under the same id.
      expect(new Set(started.map((event) => event.data.callId)).size).toBe(1);
      const callId = started[0]?.data.callId;
      const completed = turn.events.filter(
        (event) => event.type === "tool.completed" && event.data.callId === callId,
      );
      expect(completed).toMatchObject([
        { data: { isError: false, output: { text: expect.stringContaining(marker) } } },
      ]);
      if (engine.driverKind === "codex") {
        const holdEnteredAt = enteredAt;
        const holdReleasedAt = releasedAt;
        const direct = nativeItems.filter(
          (item) =>
            item.method === "item/started" &&
            item.type === "mcpToolCall" &&
            item.tool === "use_saved_login",
        );
        expect(direct).toMatchObject([{ server: "opensteer-direct", id: callId }]);
        expect(
          nativeItems.filter((item) => item.method === "item/completed" && item.id === callId),
        ).toMatchObject([{ receivedMarker: true }]);
        const otherTools = nativeItems.filter(
          (item) =>
            item.method === "item/started" &&
            item.id !== callId &&
            !["userMessage", "agentMessage", "reasoning", "plan"].includes(String(item.type)),
        );
        expect(
          otherTools.filter((item) => {
            const completedAt =
              nativeItems.find((end) => end.method === "item/completed" && end.id === item.id)
                ?.at ?? Number.POSITIVE_INFINITY;
            return item.at < holdReleasedAt && completedAt > holdEnteredAt;
          }),
        ).toEqual([]);
      }
      await writeFile(
        join(evidenceRoot, `${engine.label.replaceAll(" ", "-")}-held-mcp.json`),
        JSON.stringify(
          {
            engine: engine.label,
            version,
            modelId: model.modelId,
            calls,
            holdMs,
            engineTimeoutMs: heldToolCallTimeoutMs,
            enteredAt,
            releasedAt,
            elapsedMs: releasedAt - enteredAt,
            marker,
            callId,
            runId: turn.runId,
            nativeItems,
            result: "passed",
            totalMs: performance.now() - began,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await writeFile(
        join(evidenceRoot, `${engine.label.replaceAll(" ", "-")}-held-mcp.json`),
        JSON.stringify(
          {
            engine: engine.label,
            version,
            calls,
            holdMs,
            enteredAt,
            releasedAt,
            nativeItems,
            result: "failed",
            answer: lastAnswer.slice(0, 1000),
            totalMs: performance.now() - began,
            message: error instanceof Error ? error.message : "Engine qualification failed",
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      holdLifetime.abort();
    }
  }, 720_000);
});
