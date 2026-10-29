import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, type RunId, type WorkspaceId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * A Run's tools stop working when the authority behind them ends, not when
 * its Runner gets around to winding the Run down:
 * - Stop only queues an interrupt; the engine's token must fail at once;
 * - a Workspace being deleted must lend its Runs no further tools;
 * - while the Runner, whose own reporting needs only its binding, still
 *   records how each Run ended.
 *
 * The engine holds no Host token: it is handed a Run-local proxy and a secret
 * the Host refuses. Each journey drives the engine's own proxy URL and secret
 * against the Host's real tool endpoint, and records the outcome in a
 * revocation matrix.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

interface Revocation {
  readonly capabilityTime?: {
    readonly before: number;
    readonly after: number;
    readonly replacements: number;
  };
  readonly event: string;
  readonly hostRefusesEngineToken: boolean;
  readonly before: number | "proxy-closed";
  readonly after: number | "proxy-closed";
  readonly latencyMs: number;
  readonly grant: { readonly status: string; readonly revokedReason: string | null };
  readonly runEnded: string;
  readonly detachedChildEnded?: boolean;
  readonly heldSessionAfterRefresh?: number;
}

import { heldRunCapture } from "./run-grants.test-support.js";

integration("Run tool authority", () => {
  let stack: VerticalStack | undefined;
  const temporary: string[] = [];
  const matrix: Revocation[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-run-grants-"));
    const artifact = join(directory, "revocation-matrix.json");
    await writeFile(artifact, JSON.stringify(matrix, null, 2) + "\n");
    console.info(`Run grant revocation matrix: ${artifact}`);
  });

  async function start(
    options: {
      readonly engineArguments?: readonly string[];
      readonly runCapabilityLifetimeSeconds?: number;
      readonly capabilityClock?: ManualClock;
    } = {},
  ) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-run-grants-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const captureFile = join(scratch, "capture.jsonl");
    let refreshSchedules = 0;
    stack = await startVerticalStack({
      ...(options.capabilityClock
        ? {
            runCapabilityNow: options.capabilityClock.now,
            credentialRefreshClock: {
              schedule: (callback: () => void, milliseconds: number) => {
                const cancel = options.capabilityClock!.schedule(callback, milliseconds);
                // Scheduling the next healthy refresh follows credential replacement.
                if (milliseconds === options.runCapabilityLifetimeSeconds! * 500)
                  refreshSchedules += 1;
                return cancel;
              },
            },
          }
        : {}),
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new CodexHarnessDriver({
            launch: {
              arguments: [
                fakeCodexAppServer,
                "--scenario=long-stream-held",
                "--unique-threads",
                `--release-file=${releaseFile}`,
                `--capture=${captureFile}`,
                "--capture-tokens",
                "--capture-process-id",
                ...(options.engineArguments ?? []),
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      ...(options.runCapabilityLifetimeSeconds
        ? { runCapabilityLifetimeSeconds: options.runCapabilityLifetimeSeconds }
        : {}),
      runTimeoutMs: 60_000,
    });
    const advanceCapabilityTime = async (milliseconds: number) => {
      const clock = options.capabilityClock;
      if (!clock) throw new Error("Expected a capability clock");
      const before = clock.now();
      const initialSchedules = refreshSchedules;
      const interval = options.runCapabilityLifetimeSeconds! * 500;
      for (let remaining = milliseconds; remaining > 0;) {
        const schedules = refreshSchedules;
        const step = Math.min(interval, remaining);
        clock.advanceBy(step);
        await expect.poll(() => refreshSchedules, { timeout: 30_000 }).toBeGreaterThan(schedules);
        remaining -= step;
      }
      return { before, after: clock.now(), replacements: refreshSchedules - initialSchedules };
    };
    return {
      active: stack,
      captureFile,
      release: () => writeFile(releaseFile, ""),
      advanceCapabilityTime,
    };
  }

  /** A Run held mid-turn, and the agent-tools URL and secret its engine was given. */
  async function heldRun(active: VerticalStack, workspaceId: WorkspaceId, captureFile: string) {
    const threadId = await active.createThread({
      modelSelection,
      title: "Held",
      workspaceId,
    });
    const marker = `held-run-${randomUUID()}`;
    const queued = await active.queueMessage({ text: `Keep working ${marker}`, threadId });
    if (!queued.runId) throw new Error("Expected the message to start a Run");
    let engine: { readonly token: string; readonly url: string } | undefined;
    await expect
      .poll(
        async () => {
          engine = heldRunCapture(await readFile(captureFile, "utf8").catch(() => ""), marker);
          return engine;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    return { runId: queued.runId, threadId, ...engine! };
  }

  /**
   * What the engine itself would do: open its MCP session through the proxy.
   * Refusal is the Host's 401/403, or the proxy already closed with its Run.
   */
  async function engineToolCall(held: {
    readonly token: string;
    readonly url: string;
  }): Promise<number | "proxy-closed"> {
    const response = await fetch(held.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "run-grants-journey", version: "1" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${held.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    }).catch(() => undefined);
    if (!response) return "proxy-closed";
    await response.arrayBuffer();
    return response.status;
  }

  /** One MCP message through the proxy, on the session `sessionId` names if any. */
  async function mcpMessage(
    held: { readonly token: string; readonly url: string },
    message: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ readonly sessionId: string | null; readonly status: number }> {
    const response = await fetch(held.url, {
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${held.token}`,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    await response.arrayBuffer();
    return { sessionId: response.headers.get("mcp-session-id"), status: response.status };
  }

  async function agentControl(active: VerticalStack, token: string): Promise<number> {
    const response = await fetch(new URL("/internal/v1/agent-control", active.hostOrigin), {
      body: JSON.stringify({ requestId: randomUUID(), type: "thread.list" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    await response.arrayBuffer();
    return response.status;
  }

  async function grantOf(active: VerticalStack, runId: RunId) {
    return active.host.store.database
      .selectFrom("grants")
      .select(["revokedReason", "status"])
      .where("runId", "=", runId)
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
  }

  async function runEnds(active: VerticalStack, runId: RunId): Promise<string> {
    let status = "";
    await expect
      .poll(
        async () => {
          status = (
            await active.host.store.database
              .selectFrom("runs")
              .select("status")
              .where("id", "=", runId)
              .executeTakeFirstOrThrow()
          ).status;
          return ["completed", "failed", "interrupted"].includes(status);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return status;
  }

  it("keeps a held Run's engine token visible after its token-less title process starts", async () => {
    const { active, captureFile, release } = await start();
    const workspace = await active.createWorkspace("Named work");
    const threadId = await active.createThread({
      modelSelection,
      title: "Held",
      workspaceId: workspace.id,
    });
    const marker = `held-run-${randomUUID()}`;
    const queued = await active.queueMessage({ text: `Keep working ${marker}`, threadId });
    if (!queued.runId) throw new Error("Expected the message to start a Run");
    // The Run's title and icon are named by a second app-server started once the
    // engine is bound; its token-less capture lands after the engine's token.
    let captured = "";
    await expect
      .poll(
        async () => {
          captured = await readFile(captureFile, "utf8").catch(() => "");
          const rows = captured
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  captureProcessId?: number;
                  fakeOpensteerTokens?: { agentTools?: string };
                },
            );
          const engineAt = rows.findIndex((row) => row.fakeOpensteerTokens?.agentTools);
          return (
            engineAt >= 0 &&
            rows
              .slice(engineAt + 1)
              .some(
                (row) =>
                  row.fakeOpensteerTokens &&
                  !row.fakeOpensteerTokens.agentTools &&
                  row.captureProcessId !== rows[engineAt]!.captureProcessId,
              )
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const engine = heldRunCapture(captured, marker);
    expect(engine).toBeDefined();
    expect(await agentControl(active, engine!.token)).toBe(401);
    expect(await engineToolCall(engine!)).toBe(200);
    await release();
    expect(["completed", "interrupted"]).toContain(await runEnds(active, queued.runId));
  });

  it("stops an engine's tools at Stop while its Runner records how the Run ended", async () => {
    const { active, captureFile, release } = await start();
    const workspace = await active.createWorkspace("Stopped work");
    const held = await heldRun(active, workspace.id, captureFile);
    const hostRefusesEngineToken = (await agentControl(active, held.token)) === 401;
    expect(hostRefusesEngineToken).toBe(true);
    const before = await engineToolCall(held);
    expect(before).toBe(200);

    const stoppedAt = Date.now();
    await active.interruptRun(held.threadId, held.runId);
    const after = await engineToolCall(held);
    const latencyMs = Date.now() - stoppedAt;
    expect([401, 403]).toContain(after);
    const grant = await grantOf(active, held.runId);
    expect(grant).toEqual({ revokedReason: "stopped", status: "revoked" });

    await release();
    // This fake engine finishes its held turn rather than honoring the
    // interrupt; either way the Runner's report of the end must be accepted.
    const runEnded = await runEnds(active, held.runId);
    expect(["completed", "interrupted"]).toContain(runEnded);
    matrix.push({
      after,
      before,
      event: "stop",
      grant,
      hostRefusesEngineToken,
      latencyMs,
      runEnded,
    });
  }, 180_000);

  it("keeps an engine's tools working past its first tokens' lifetime", async () => {
    const clock = new ManualClock();
    const lifetimeSeconds = 4;
    const { active, captureFile, release, advanceCapabilityTime } = await start({
      capabilityClock: clock,
      runCapabilityLifetimeSeconds: lifetimeSeconds,
    });
    const workspace = await active.createWorkspace("Long work");
    const held = await heldRun(active, workspace.id, captureFile);
    const before = await engineToolCall(held);
    expect(before).toBe(200);
    // Well past the expiry of every token the dispatch issued.
    const capabilityTime = await advanceCapabilityTime((lifetimeSeconds + 2) * 1_000);
    const afterExpiry = await engineToolCall(held);
    expect(afterExpiry).toBe(200);
    const stoppedAt = Date.now();
    await active.interruptRun(held.threadId, held.runId);
    await expect.poll(() => engineToolCall(held), { timeout: 10_000 }).not.toBe(200);
    const latencyMs = Date.now() - stoppedAt;
    const after = await engineToolCall(held);
    await release();
    const runEnded = await runEnds(active, held.runId);
    matrix.push({
      after,
      before,
      event: `stop after outliving ${lifetimeSeconds}s tokens (still ${afterExpiry} past expiry)`,
      capabilityTime,
      grant: await grantOf(active, held.runId),
      hostRefusesEngineToken: (await agentControl(active, held.token)) === 401,
      latencyMs,
      runEnded,
    });
  }, 180_000);

  it("keeps an engine's MCP session working across a token refresh", async () => {
    const clock = new ManualClock();
    const lifetimeSeconds = 4;
    const { active, captureFile, release, advanceCapabilityTime } = await start({
      capabilityClock: clock,
      runCapabilityLifetimeSeconds: lifetimeSeconds,
    });
    const workspace = await active.createWorkspace("Held session");
    const held = await heldRun(active, workspace.id, captureFile);
    const opened = await mcpMessage(held, {
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "run-grants-journey", version: "1" },
        protocolVersion: "2025-06-18",
      },
    });
    expect(opened.status).toBe(200);
    const sessionId = opened.sessionId;
    if (!sessionId) throw new Error("The Host opened no MCP session");
    expect(
      (await mcpMessage(held, { method: "notifications/initialized" }, sessionId)).status,
    ).toBe(202);
    // Past the first tokens' expiry: the proxy now presents refreshed ones on
    // the session the first ones opened.
    const capabilityTime = await advanceCapabilityTime((lifetimeSeconds + 2) * 1_000);
    const listed = await mcpMessage(held, { id: 2, method: "tools/list" }, sessionId);
    expect(listed.status).toBe(200);

    await active.interruptRun(held.threadId, held.runId);
    const after = (
      await mcpMessage(held, { id: 3, method: "tools/list" }, sessionId).catch(() => ({
        status: 0,
      }))
    ).status;
    await release();
    matrix.push({
      after: after === 0 ? "proxy-closed" : after,
      before: opened.status,
      event: `held MCP session across ${lifetimeSeconds}s token refresh`,
      capabilityTime,
      grant: await grantOf(active, held.runId),
      heldSessionAfterRefresh: listed.status,
      hostRefusesEngineToken: (await agentControl(active, held.token)) === 401,
      latencyMs: 0,
      runEnded: await runEnds(active, held.runId),
    });
  }, 180_000);

  it.each([
    { child: "a detached child", engineArguments: ["--spawn-detached"] },
    // A child that dropped the marker naming its execution is still below it.
    {
      child: "a detached child without its execution's marker",
      engineArguments: ["--spawn-detached", "--spawn-unmarked"],
    },
  ])(
    "ends everything a stopped engine started: $child",
    async ({ child, engineArguments }) => {
      const { active, captureFile } = await start({
        engineArguments: [...engineArguments, "--ignore-interrupt"],
      });
      const workspace = await active.createWorkspace("Runaway work");
      const held = await heldRun(active, workspace.id, captureFile);
      let detachedChild: number | undefined;
      await expect
        .poll(
          async () => {
            const captured = await readFile(captureFile, "utf8").catch(() => "");
            detachedChild = captured
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { fakeDetachedChild?: number })
              .findLast((line) => line.fakeDetachedChild)?.fakeDetachedChild;
            return detachedChild;
          },
          { timeout: 30_000 },
        )
        .toBeTruthy();
      const alive = () => {
        try {
          process.kill(detachedChild!, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(true);

      const stoppedAt = Date.now();
      await active.interruptRun(held.threadId, held.runId);
      const runEnded = await runEnds(active, held.runId);
      const latencyMs = Date.now() - stoppedAt;
      expect(runEnded).toBe("interrupted");
      expect(alive()).toBe(false);
      matrix.push({
        after: await engineToolCall(held),
        before: 200,
        detachedChildEnded: !alive(),
        event: `stop of an engine that ignores the interrupt and left ${child}`,
        grant: await grantOf(active, held.runId),
        hostRefusesEngineToken: (await agentControl(active, held.token)) === 401,
        latencyMs,
        runEnded,
      });
    },
    180_000,
  );

  it("stops an engine's tools once its Workspace is being deleted", async () => {
    const { active, captureFile, release } = await start();
    const workspace = await active.createWorkspace("Deleted work");
    const held = await heldRun(active, workspace.id, captureFile);
    const hostRefusesEngineToken = (await agentControl(active, held.token)) === 401;
    expect(hostRefusesEngineToken).toBe(true);
    const before = await engineToolCall(held);
    expect(before).toBe(200);

    const deletedAt = Date.now();
    const deleted = await active.api["commands.dispatch"]({
      idempotencyKey: `delete-${workspace.id}`,
      type: "workspace.delete",
      workspaceId: workspace.id,
    });
    if (!deleted.ok) throw new Error(deleted.error.message);
    const after = await engineToolCall(held);
    const latencyMs = Date.now() - deletedAt;
    expect([401, 403, "proxy-closed"]).toContain(after);

    await release();
    const runEnded = await runEnds(active, held.runId);
    const grant = await grantOf(active, held.runId);
    matrix.push({
      after,
      before,
      event: "workspace-deletion",
      grant,
      hostRefusesEngineToken,
      latencyMs,
      runEnded,
    });
  }, 180_000);
});
