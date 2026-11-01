import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ModelSelectionSchema, shippedHarnessKinds } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createHarnessRegistry, parseAgentExecutionConfig } from "@opensteer/runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startVerticalStack, type VerticalStack } from "../agents/vertical-stack.test-support.js";
import { BrowserSourceService } from "./browser-source-service.js";

const timeoutHarnessKinds = [...shippedHarnessKinds, "claude"] as const;

/** Real engines and MCP transports, with a delayed fake sign-in and no vault access. */
describe.each(timeoutHarnessKinds)("autonomous sign-in MCP timeout: %s", (driverKind) => {
  let stack: VerticalStack | undefined;
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  }, 60_000);

  const key =
    driverKind === "opencode"
      ? undefined
      : process.env[
          driverKind === "claude"
            ? "OPENSTEER_TIMEOUT_TEST_ANTHROPIC_API_KEY"
            : "OPENSTEER_TIMEOUT_TEST_OPENAI_API_KEY"
        ];
  it.skipIf(driverKind !== "opencode" && !key)(
    "receives a sign_in result after the old 60-second limit",
    async () => {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl)
        throw new Error("Run through pnpm test:engines with a throwaway PostgreSQL database");
      const evidenceRoot =
        process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
        join(tmpdir(), "opensteer-sign-in-timeouts", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      const sourceId =
        driverKind === "claude" ? "anthropic" : driverKind === "opencode" ? "opencode" : "openai";
      const began = Date.now();
      let elapsedMs = 0;
      let calls = 0;
      let lastAnswer = "";
      vi.spyOn(BrowserSourceService.prototype, "agentSignIn").mockImplementation(async (input) => {
        calls += 1;
        if (calls > 1)
          return {
            status: "ready",
            account: "t•••@example.test",
            loginRef: "lgn_" + "1".repeat(32),
            site: input.site,
          };
        const started = Date.now();
        await delay(65_000);
        elapsedMs = Date.now() - started;
        return {
          status: "ready",
          site: input.site,
          account: "t•••@example.test",
          loginRef: "lgn_" + "1".repeat(32),
        };
      });
      try {
        stack = await startVerticalStack({
          databaseUrl,
          catalogTimeoutMs: 90_000,
          runTimeoutMs: 180_000,
          harnesses: createHarnessRegistry(
            parseAgentExecutionConfig(process.env).harnessExecutables,
            {
              nodeExecutable: process.execPath,
              runtimeCacheDirectory: join(tmpdir(), "opensteer-test-runtime-cache"),
            },
          ),
          harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
          harnessInstance: {
            driverKind,
            sourceId,
            stateKind: "isolated",
            ...(key
              ? {
                  apiKey: {
                    methodId:
                      driverKind === "claude"
                        ? "claude-api-key"
                        : driverKind === "codex"
                          ? "codex-api-key"
                          : "pi-api-key",
                    value: key,
                  },
                }
              : {}),
            config: {},
          },
        });
        const model = stack.catalog.models.find((candidate) => candidate.isDefault);
        if (!model) throw new Error("Engine supplied no default model");
        const workspaceId = stack.mainWorkspaceId;
        const threadId = await stack.createThread({
          home: true,
          workspaceId,
          title: "Sign-in transport qualification",
          modelSelection: ModelSelectionSchema.parse({
            modelId: model.modelId,
            providerId: model.providerId,
            options: {},
          }),
        });
        const turn = await stack.sendMessage({
          threadId,
          workspaceId,
          text: "This is a fake-data transport test. Call sign_in with sessionId bsn_00000000-0000-4000-8000-000000000001, site https://example.test, reason Test delayed sign-in. This fake session does not need opening or inspecting. Wait for the tool result, which takes 65 seconds. It returns ready; reply exactly LOGIN-READY after you receive it. Never browse, open files, or retrieve credentials.",
        });
        lastAnswer = turn.assistantText;
        expect(calls).toBe(1);
        expect(turn.assistantText).toContain("LOGIN-READY");
        const repeated = await stack.sendMessage({
          threadId,
          workspaceId,
          text: "Continue the fake-data MCP transport test. Call sign_in with sessionId bsn_00000000-0000-4000-8000-000000000001, site https://example.test, reason Test repeated authorization. If the result says ready, reply exactly TIMEOUT-PASSED. Do not browse, open files, or retrieve credentials.",
        });
        lastAnswer = repeated.assistantText;
        expect(calls).toBe(2);
        expect(elapsedMs).toBeGreaterThanOrEqual(65_000);
        expect(repeated.assistantText).toContain("TIMEOUT-PASSED");
        await writeFile(
          join(evidenceRoot, `${driverKind}-sign-in-timeout.json`),
          JSON.stringify(
            {
              engine: driverKind,
              modelId: model.modelId,
              calls,
              elapsedMs,
              result: "passed",
              runId: turn.runId,
              repeatRunId: repeated.runId,
              fakeSite: "https://example.test",
              totalMs: Date.now() - began,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await writeFile(
          join(evidenceRoot, `${driverKind}-sign-in-timeout.json`),
          JSON.stringify(
            {
              engine: driverKind,
              calls,
              elapsedMs,
              result: "failed",
              answer: lastAnswer.slice(0, 1000),
              totalMs: Date.now() - began,
              message: error instanceof Error ? error.message : "Engine qualification failed",
            },
            null,
            2,
          ),
        );
        throw error;
      }
    },
    300_000,
  );
});
