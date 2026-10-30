import { randomUUID } from "node:crypto";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  advanceExecutionClock,
  executionDisconnected,
  executionLeaseExpiresAt,
} from "./execution-clock.test-support.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ModelSelectionSchema, type RunId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { AgentControlResponseSchema } from "@opensteer/protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { z } from "zod";
import { observeDispatchReadiness } from "./dispatch-readiness.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";
import { readCodexRunCaptures } from "./codex-capture.test-support.js";

/*
 * A Run outlives the connection that carried it. The Runner keeps executing
 * through a network blip or a Host restart, reattaches when it can, and its
 * Run ends exactly once. A lost lease or Runner process recovers its attempt
 * when the native conversation can be resumed safely.
 *
 * Every journey cuts the real connection: the Runner reaches the Host through
 * a TCP hop the test can drop or hold closed, and the Host and Runner restart
 * as their real processes would, on the same database and identity.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const gatedCodexAppServer = fileURLToPath(
  new URL("./dispatch-readiness-engine.test-support.ts", import.meta.url),
);
const captureSchema = z
  .object({
    method: z.string().optional(),
    params: z
      .object({ input: z.array(z.unknown()).optional(), threadId: z.string().optional() })
      .passthrough()
      .optional(),
    fakeOpensteerTokens: z.object({ agentTools: z.string().optional() }).optional(),
    fakeTurn: z.object({ pid: z.number() }).passthrough().optional(),
    preparationHeld: z.object({ pid: z.number() }).optional(),
    dispatchReadinessTurn: z
      .object({
        input: z.array(z.unknown()),
        releaseFile: z.string(),
        threadId: z.string(),
      })
      .optional(),
  })
  .passthrough();
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const messages = 3;
// The fake runs commands after its final answer, which opens a background/turn phase pair.
const completedStreamEventTypes = [
  "run.started",
  ...Array.from({ length: messages }, (_value, index) => [
    "reasoning.completed",
    "assistant.message",
    ...(index === messages - 1 ? ["run.phase", "run.phase"] : []),
    ...Array.from({ length: 7 }, () => ["tool.started", "tool.completed"]).flat(),
  ]).flat(),
  "run.completed",
];
const heldText = Array.from({ length: 200 }, (_value, index) => `m0t${index} `).join("");

integration("Runs that outlive their connection", () => {
  const clockMilestones: unknown[] = [];
  let stack: VerticalStack | undefined;
  const temporary: string[] = [];

  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT ??
      (await mkdtemp(join(tmpdir(), "opensteer-reattach-clocks-")));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "clock-milestones.json"),
      JSON.stringify(clockMilestones, null, 2) + "\n",
    );
    console.info(`Runner reattach clock evidence: ${directory}`);
  });

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
  }, 90_000);

  async function start(input: {
    readonly executionClock?: ManualClock;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly engineArguments?: readonly string[];
    readonly executionLeaseMs?: number;
    readonly maxConcurrentRuns?: number;
    readonly scenario?: string;
    readonly gatePreparation?: true;
  }): Promise<{
    readonly captured: () => Promise<z.infer<typeof captureSchema>[]>;
    readonly releasePreparation: () => Promise<void>;
    readonly release: () => Promise<void>;
    readonly advanceSibling: () => Promise<void>;
    readonly stack: VerticalStack;
    /** The process each turn the engine was asked for ran in, in order. */
    readonly turnPids: () => Promise<number[]>;
  }> {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-reattach-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const captureFile = join(scratch, "capture.jsonl");
    const preparationRelease = join(scratch, "preparation-release");
    let boot = 0;
    const harnesses = () => {
      boot += 1;
      const registry = new HarnessRegistry();
      registry.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [
              ...(input.gatePreparation
                ? [
                    gatedCodexAppServer,
                    `--fixture=${fakeCodexAppServer}`,
                    `--scratch=${scratch}`,
                    ...(boot > 1 ? [`--preparation-release=${preparationRelease}`] : []),
                  ]
                : [fakeCodexAppServer]),
              `--scenario=${input.scenario ?? "long-stream-held"}`,
              "--unique-threads",
              `--release-file=${releaseFile}`,
              `--capture=${captureFile}`,
              "--capture-process-id",
              ...(input.engineArguments ?? []),
            ],
            executable: process.execPath,
          },
        }),
      );
      return registry;
    };
    stack = await startVerticalStack({
      ...(input.executionClock ? { executionClock: input.executionClock } : {}),
      runnerWire: { contained: () => true },
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      ...(input.executionLeaseMs ? { executionLeaseMs: input.executionLeaseMs } : {}),
      harnessInstance: {
        config: input.config ?? {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses,
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
      runTimeoutMs: 60_000,
    });
    const captured = async () =>
      (await readCodexRunCaptures(captureFile)).map((entry) => captureSchema.parse(entry));
    const turnPids = async () =>
      (await captured()).flatMap((entry) => (entry.fakeTurn ? [entry.fakeTurn.pid] : []));
    return {
      captured,
      releasePreparation: () => writeFile(preparationRelease, ""),
      release: () => writeFile(releaseFile, ""),
      advanceSibling: () => writeFile(`${releaseFile}.sibling`, ""),
      stack,
      turnPids,
    };
  }

  async function thread(active: VerticalStack, title: string): Promise<ThreadId> {
    const workspace = await active.createWorkspace(`${title} workspace`);
    return active.createThread({ modelSelection, title, workspaceId: workspace.id });
  }

  async function ageDisconnectedLease(active: VerticalStack, clock: ManualClock, runId: RunId) {
    await waitFor(() => executionDisconnected(active), 30_000, "Host observed Runner disconnect");
    const expiry = await executionLeaseExpiresAt(active.host, runId);
    expect(expiry.getTime()).toBeGreaterThan(clock.now());
    await advanceExecutionClock(clock, active.host, expiry.getTime() - clock.now() + 5_000);
    clockMilestones.push({
      stage: "disconnected lease aged",
      runId,
      expiry,
      domainNow: clock.now(),
      completedPasses: await active.host.settleExecutionLeases(),
    });
  }

  async function run(active: VerticalStack, runId: RunId) {
    return active.host.store.database
      .selectFrom("runs")
      .select(["failure", "status"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
  }

  async function connectionGeneration(active: VerticalStack): Promise<bigint> {
    const row = await active.host.store.database
      .selectFrom("runners")
      .select("connectionGeneration")
      .executeTakeFirstOrThrow();
    return BigInt(row.connectionGeneration);
  }

  async function liveAssistant(active: VerticalStack, threadId: ThreadId) {
    const read = await active.api["thread.live.get"]({ threadId });
    if (!read.ok) throw new Error(read.error.message);
    return read.data.runs
      .flatMap((entry) => entry.progress.items)
      .find((item) => item.stream === "assistant")?.text;
  }

  async function storedRunnerEvents(active: VerticalStack, runId: RunId) {
    return active.host.store.database
      .selectFrom("workspaceEvents")
      .select(["runnerOrdinal", "type"])
      .where("runId", "=", runId)
      .where("runnerOrdinal", "is not", null)
      .orderBy("runnerOrdinal", "asc")
      .execute();
  }

  async function expectCompletedExactlyOnce(active: VerticalStack, runId: RunId): Promise<void> {
    const stored = await storedRunnerEvents(active, runId);
    expect(stored.map((row) => row.runnerOrdinal)).toEqual(stored.map((_row, index) => index));
    expect(stored.filter((row) => row.type === "run.completed")).toHaveLength(1);
    expect(stored.filter((row) => row.type === "assistant.message")).toHaveLength(messages);
  }

  it("finishes a turn whose Runner connection dropped mid-stream, exactly once", async () => {
    const outputDirectory =
      process.env.OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-execution-plane-evidence", randomUUID());
    await mkdir(outputDirectory, { recursive: true });
    const { release, stack: active } = await start({ executionLeaseMs: 60_000 });
    const threadId = await thread(active, "Network blip");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");
    const before = await connectionGeneration(active);

    active.network.drop();
    await waitFor(async () => (await connectionGeneration(active)) > before, 30_000, "reconnect");
    expect((await run(active, runId)).status).toBe("running");
    // The Runner states its streams again on the new connection.
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "live");

    await release();
    await waitFor(async () => (await run(active, runId)).status === "completed", 60_000, "done");
    await expectCompletedExactlyOnce(active, runId);
    await writeFile(
      join(outputDirectory, "runner-reattach.json"),
      JSON.stringify(
        {
          connectionGenerations: {
            after: String(await connectionGeneration(active)),
            before: String(before),
          },
          runId,
          storedRunnerEvents: (await storedRunnerEvents(active, runId)).length,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.info(`Runner reattach E2E evidence: ${outputDirectory}`);
  }, 180_000);

  it("queues recovery when a Runner stays away beyond its lease", async ({ signal }) => {
    const clock = new ManualClock();
    const { release, stack: active } = await start({
      executionLeaseMs: 12_000,
      executionClock: clock,
    });
    const threadId = await thread(active, "Lost network");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");

    active.network.block();
    await ageDisconnectedLease(active, clock, runId);
    await waitFor(
      async () => ["queued", "failed"].includes((await run(active, runId)).status),
      60_000,
      "lease recovery",
    );
    expect(await run(active, runId)).toEqual({ failure: null, status: "queued" });
    expect(await active.api["run.attempts.list"]({ runId })).toMatchObject({
      ok: true,
      data: {
        attempts: [
          expect.objectContaining({ outcome: "interrupted" }),
          expect.objectContaining({ reason: "recovery" }),
        ],
      },
    });
    const lostEvents = await storedRunnerEvents(active, runId);

    // Reattach retires the old binding and resumes this same Run before the next input.
    active.network.unblock();
    await release();
    await waitFor(
      async () => (await run(active, runId)).status === "completed",
      signal,
      "recovered",
    );
    const next = (await active.queueMessage({ text: "Again.", threadId })).runId!;
    await waitFor(async () => (await run(active, next)).status === "completed", signal, "next");
    expect((await run(active, runId)).status).toBe("completed");
    expect((await storedRunnerEvents(active, runId)).slice(0, lostEvents.length)).toEqual(
      lostEvents,
    );
    const recoveredEvents = await storedRunnerEvents(active, runId);
    expect(recoveredEvents).toHaveLength(lostEvents.length + completedStreamEventTypes.length);
    expect(recoveredEvents.slice(lostEvents.length).map((event) => event.type)).toEqual(
      completedStreamEventTypes,
    );
    await expectCompletedExactlyOnce(active, runId);
  }, 180_000);

  it("recovers at once after a lost lease, though the engine never ended the stopped turn", async () => {
    const clock = new ManualClock();
    // The engine acknowledges the interrupt and never ends the turn; waiting
    // for it would hold the conversation for this long.
    const requestTimeoutMs = 120_000;
    const {
      release,
      stack: active,
      turnPids,
    } = await start({
      config: { requestTimeoutMs },
      engineArguments: ["--ignore-interrupt"],
      executionLeaseMs: 12_000,
      executionClock: clock,
    });
    const threadId = await thread(active, "Lost lease, stuck turn");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");

    active.network.block();
    await ageDisconnectedLease(active, clock, runId);
    await waitFor(
      async () => ["queued", "failed"].includes((await run(active, runId)).status),
      60_000,
      "lease end",
    );
    expect(await run(active, runId)).toEqual({ failure: null, status: "queued" });
    const attempts = await active.api["run.attempts.list"]({ runId });
    expect(attempts).toMatchObject({
      ok: true,
      data: {
        attempts: [
          expect.objectContaining({ outcome: "interrupted" }),
          expect.objectContaining({ reason: "recovery" }),
        ],
      },
    });

    const lostEvents = await storedRunnerEvents(active, runId);
    // The Runner stops the lost engine before recovering the same conversation.
    const reconnectedAt = Date.now();
    active.network.unblock();
    const next = runId;
    await waitFor(
      async () =>
        (await turnPids()).length === 2 ||
        ["completed", "failed", "interrupted"].includes((await run(active, next)).status),
      60_000,
      "the next turn",
    );
    await release();
    await waitFor(
      async () => ["completed", "failed", "interrupted"].includes((await run(active, next)).status),
      60_000,
      "next",
    );
    expect(await run(active, next)).toEqual({ failure: null, status: "completed" });
    expect(Date.now() - reconnectedAt).toBeLessThan(requestTimeoutMs / 2);
    const [stuck, resumed] = await turnPids();
    expect(resumed).not.toBe(stuck);
    const events = await storedRunnerEvents(active, runId);
    expect(events).toHaveLength(lostEvents.length + completedStreamEventTypes.length);
    expect(events.slice(lostEvents.length).map((event) => event.type)).toEqual(
      completedStreamEventTypes,
    );
    expect(events.slice(0, lostEvents.length)).toEqual(lostEvents);
    await expectCompletedExactlyOnce(active, runId);
  }, 180_000);

  it("keeps a turn running through a Host restart and finishes it exactly once", async () => {
    const { release, stack: active } = await start({ executionLeaseMs: 60_000 });
    const threadId = await thread(active, "Host restart");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");
    const before = await connectionGeneration(active);

    await active.restartHost();
    await waitFor(async () => (await connectionGeneration(active)) > before, 30_000, "reconnect");
    expect((await run(active, runId)).status).toBe("running");

    await release();
    await waitFor(async () => (await run(active, runId)).status === "completed", 60_000, "done");
    await expectCompletedExactlyOnce(active, runId);
  }, 180_000);

  it("keeps a turn that finished while the Host was down for longer than two leases", async () => {
    const clock = new ManualClock();
    const executionLeaseMs = 12_000;
    const { release, stack: active } = await start({ executionLeaseMs, executionClock: clock });
    const threadId = await thread(active, "Host outage");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");

    // The turn ends while no Host is listening, and stays unacknowledged for
    // well over two leases: the Runner keeps its outcome, and the new Host
    // gives it a fresh lease to come back in.
    await active.restartHost({
      whileDown: async () => {
        await release();
        await waitFor(
          async () => active.settledRunEvent(runId)?.type === "run.completed",
          30_000,
          "Runner journaled completion while Host was down",
        );
        clockMilestones.push({
          stage: "offline completion settled before aging",
          runId,
          domainNow: clock.now(),
          outcome: active.settledRunEvent(runId),
        });
        await advanceExecutionClock(clock, active.host, executionLeaseMs * 2 + 3_000);
        clockMilestones.push({
          stage: "completed journal survived two leases",
          runId,
          domainNow: clock.now(),
          outcome: active.settledRunEvent(runId),
        });
      },
    });
    await waitFor(async () => (await run(active, runId)).status === "completed", 60_000, "done");
    await expectCompletedExactlyOnce(active, runId);
  }, 180_000);

  it("recovers the same turn at once when its Runner process restarts", async () => {
    const { release, stack: active } = await start({ executionLeaseMs: 60_000 });
    const threadId = await thread(active, "Runner restart");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");

    const restarted = Date.now();
    await active.restartRunner();
    await waitFor(
      async () => {
        const listed = await active.api["run.attempts.list"]({ runId });
        return (
          (listed.ok && listed.data.attempts.length === 2) ||
          ["failed", "interrupted"].includes((await run(active, runId)).status)
        );
      },
      30_000,
      "lost boot",
    );
    // Far sooner than the lease: a new boot proves the old one's work is gone.
    expect(Date.now() - restarted).toBeLessThan(30_000);
    expect((await run(active, runId)).failure).toBeNull();
    const attempts = await active.api["run.attempts.list"]({ runId });
    expect(attempts).toMatchObject({
      ok: true,
      data: {
        attempts: [
          expect.objectContaining({ outcome: "interrupted" }),
          expect.objectContaining({ reason: "recovery" }),
        ],
      },
    });

    await release();
    await waitFor(
      async () => (await run(active, runId)).status === "completed",
      60_000,
      "recovered",
    );
    await expectCompletedExactlyOnce(active, runId);
    const next = (await active.queueMessage({ text: "Again.", threadId })).runId!;
    await waitFor(async () => (await run(active, next)).status === "completed", 60_000, "next");
    const evidenceDirectory = join(tmpdir(), "opensteer-execution-plane-evidence", randomUUID());
    await mkdir(evidenceDirectory, { recursive: true });
    const artifact = join(evidenceDirectory, "runner-recovery.json");
    await writeFile(
      artifact,
      JSON.stringify(
        {
          run: await active.host.store.database
            .selectFrom("runs")
            .selectAll()
            .where("id", "=", runId)
            .executeTakeFirstOrThrow(),
          attempts: await active.host.store.database
            .selectFrom("runAttempts")
            .selectAll()
            .where("runId", "=", runId)
            .orderBy("ordinal", "asc")
            .execute(),
          inputs: await active.host.store.database
            .selectFrom("threadInputs")
            .selectAll()
            .where("runId", "=", runId)
            .execute(),
          messages: await active.host.store.database
            .selectFrom("messages")
            .selectAll()
            .where("runId", "=", runId)
            .orderBy("sequence", "asc")
            .execute(),
          notifications: active.notifications.filter((entry) => entry.runId === runId),
          events: await storedRunnerEvents(active, runId),
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.info(`Runner recovery E2E evidence: ${artifact}`);
  }, 180_000);

  it("preserves a delegated recovery through Runner preparation and a dispatch disconnect race", async () => {
    const {
      captured,
      releasePreparation,
      stack: active,
    } = await start({
      engineArguments: ["--capture-tokens"],
      executionLeaseMs: 60_000,
      gatePreparation: true,
      maxConcurrentRuns: 2,
    });
    const observation = observeDispatchReadiness(active.host.store);
    const parentId = await active.createThread({
      home: true,
      modelSelection,
      title: "Restart parent",
      workspaceId: active.mainWorkspaceId,
    });
    const spareId = await active.createThread({
      modelSelection,
      title: "Change selection while preparing",
      workspaceId: active.mainWorkspaceId,
    });
    const parentSeedRunId = (
      await active.queueMessage({ text: "Delegate a restart task.", threadId: parentId })
    ).runId!;
    await waitFor(
      async () => (await liveAssistant(active, parentId)) === heldText,
      30_000,
      "parent held",
    );
    const token = (await captured()).findLast((record) => record.fakeOpensteerTokens)
      ?.fakeOpensteerTokens?.agentTools;
    if (!token) throw new Error("Parent engine has no agent-control token");
    const proxyUrl = JSON.stringify(await captured())
      .match(/http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools/gu)
      ?.at(-1);
    if (!proxyUrl) throw new Error("Parent engine has no agent-tools proxy");
    const client = new Client({ name: "dispatch-readiness-e2e", version: "1" });
    const delegated = await (async () => {
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(proxyUrl), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }) as Transport,
        );
        const result = await client.callTool({
          name: "thread_delegate",
          arguments: {
            task: "Keep the delegated task running until its Runner restarts.",
            title: "Restart task",
            workspaceId: active.mainWorkspaceId,
          },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return AgentControlResponseSchema.parse({
          requestId: randomUUID(),
          type: "thread.delegate.result",
          result: result.structuredContent,
        });
      } finally {
        await client.close();
      }
    })();
    if (delegated.type !== "thread.delegate.result") throw new Error("Parent did not delegate");
    const { assignmentId, run: childRun, thread: childThread } = delegated.result;
    if (!childRun) throw new Error("Delegated task has no Run");
    await waitFor(
      async () => (await liveAssistant(active, childThread.id)) === heldText,
      30_000,
      "child held",
    );
    const parentTurn = (await captured()).find(
      (record) => record.dispatchReadinessTurn,
    )?.dispatchReadinessTurn;
    if (!parentTurn) throw new Error("Parent turn was not captured");
    await writeFile(parentTurn.releaseFile, "");
    await waitFor(
      async () => (await run(active, parentSeedRunId)).status === "completed",
      30_000,
      "parent idle",
    );
    expect((await run(active, childRun.id)).status).toBe("running");

    const restarting = active.restartRunner();
    void restarting.catch(() => undefined);
    await waitFor(
      async () => (await captured()).some((record) => record.preparationHeld),
      30_000,
      "replacement initialize held",
    );
    await waitFor(
      async () =>
        ["queued", "starting", "failed"].includes((await run(active, childRun.id)).status),
      30_000,
      "child recovery waits for preparation",
    );
    expect((await run(active, childRun.id)).failure).toBeNull();
    const assignment = await active.host.store.database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", assignmentId)
      .executeTakeFirstOrThrow();
    expect(assignment).toMatchObject({ status: "open", resultMessageId: null });
    const recoveryInput = await waitForValue(30_000, async () => {
      const rows = await active.host.store.database
        .selectFrom("messages")
        .selectAll()
        .where("runId", "=", childRun.id)
        .where("kind", "=", "continuation")
        .execute();
      return rows.find((message) => JSON.stringify(message.author).includes('"run-recovery"'));
    });
    const inputId = recoveryInput.id;
    const recoveringRunId = childRun.id;
    observation.observeInput(inputId);
    const command = await active.host.store.database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", recoveringRunId)
      .where("type", "=", "run.execute")
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    const resultMessage = await active.host.store.database
      .selectFrom("messages")
      .select(["author", "content", "kind"])
      .where("id", "=", inputId)
      .executeTakeFirstOrThrow();
    expect(resultMessage).toMatchObject({
      author: { cause: "run-recovery", kind: "platform" },
      kind: "continuation",
    });
    const notice = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(resultMessage.content)
      .map((part) => part.text)
      .join("\n");
    expect(notice).toContain("Opensteer restarted while you were working");
    const bootstrap = await active.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    expect(
      bootstrap.data.environments
        .find((environment) => environment.id === active.environmentId)
        ?.harnessCatalogs.find((catalog) => catalog.harnessInstanceId === active.harnessInstanceId)
        ?.status,
    ).toBe("preparing");
    await waitFor(
      async () => {
        const current = await observation.snapshot(command.id);
        expect(
          current.run.failure,
          "preparation must preserve the continuation rather than dispatch_failed",
        ).toBeNull();
        return current.run.status === "queued" && current.command.status === "pending";
      },
      30_000,
      "preparing continuation queued",
    );
    const heldSnapshots = [];
    const holdStartedAt = Date.now();
    // Absence of churn must span several real coordinator polls.
    while (Date.now() - holdStartedAt < 2_500) {
      const current = await observation.snapshot(command.id);
      expect(
        current.run.failure,
        "preparation must preserve the continuation rather than dispatch_failed",
      ).toBeNull();
      expect(current.command).toMatchObject({ id: command.id, runId: recoveringRunId });
      expect(["pending", "dispatched"]).toContain(current.command.status);
      expect(current.command.attempts).toBeLessThanOrEqual(1);
      expect(
        current.run,
        "preparation must preserve the continuation rather than dispatch_failed",
      ).toMatchObject({
        id: recoveringRunId,
        failure: null,
        bindingGeneration: null,
      });
      expect(["queued", "starting"]).toContain(current.run.status);
      expect(current.inputs).toHaveLength(1);
      expect(current.inputs[0]).toMatchObject({
        messageId: inputId,
        cancelReason: null,
        policy: "queue",
      });
      expect(["claimed", "pending"]).toContain(current.inputs[0]!.state);
      expect(current.runAttempts).toHaveLength(2);
      heldSnapshots.push(current);
      await delay(100);
    }
    const holdDurationMs = Date.now() - holdStartedAt;
    expect(heldSnapshots.at(-1)!.run.status).toBe("queued");
    expect(heldSnapshots.at(-1)!.command.status).toBe("pending");
    const heldEvents = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select(["sequence", "type", "data"])
      .where("runId", "=", recoveringRunId)
      .where("createdAt", ">=", recoveryInput.createdAt)
      .orderBy("sequence", "asc")
      .execute();
    // At most the one claim and requeue of a dispatch that raced the attach-time inspection.
    expect(heldEvents.filter((event) => event.type === "run.status").length).toBeLessThanOrEqual(2);
    expect(heldEvents.filter((event) => event.type === "run.failed")).toEqual([]);
    expect((await captured()).filter((record) => record.dispatchReadinessTurn)).toHaveLength(2);
    const frozenContext =
      heldSnapshots.find((snapshot) => snapshot.run.reportContext !== null)?.run ??
      heldSnapshots.at(-1)!.run;
    for (const snapshot of heldSnapshots) {
      if (snapshot.run.reportContext)
        expect(snapshot.run.reportContext).toEqual(frozenContext.reportContext);
      expect(snapshot.run.initialContext).toEqual(frozenContext.initialContext);
    }
    const refusals = [];
    for (const mutation of [
      {
        environmentId: active.environmentId,
        harnessInstanceId: active.harnessInstanceId,
        modelSelection,
        title: "Refuse during preparation",
        type: "thread.create" as const,
        workspaceId: active.mainWorkspaceId,
      },
      {
        harnessInstanceId: active.harnessInstanceId,
        modelSelection,
        threadId: spareId,
        type: "thread.execution.update" as const,
      },
    ]) {
      const refusal = await active.api["commands.dispatch"]({
        ...mutation,
        idempotencyKey: randomUUID(),
      });
      expect(refusal).toMatchObject({
        ok: false,
        error: { retryable: true, message: "Preparing Vertical account…" },
      });
      refusals.push({ type: mutation.type, response: refusal });
    }

    // A Runner lost while dispatch loads its context is waited for, not refused.
    const gate = observation.holdDispatch(command.id);
    const preparationReleasedAt = Date.now();
    let readyDispatchDelayMs: number;
    try {
      await releasePreparation();
      // restartRunner joins runnerReady for the replacement boot, never the old catalog.
      await restarting;
      await waitFor(gate.isEntered, 5_000, "prompt dispatch after preparation settled");
      readyDispatchDelayMs = Date.now() - preparationReleasedAt;
      active.network.block();
      await waitFor(
        async () => {
          const state = await active.api["bootstrap.get"]({});
          return (
            state.ok &&
            state.data.environments.find((environment) => environment.id === active.environmentId)
              ?.connected === false
          );
        },
        30_000,
        "runner disconnected",
      );
    } finally {
      gate.release();
    }
    await waitFor(
      async () =>
        observation
          .snapshotsFor(recoveringRunId)
          .some((retry) => JSON.stringify(retry.command.lastError).includes("Runner is offline")),
      30_000,
      "offline retry",
    );
    const offlineRetry = observation
      .snapshotsFor(recoveringRunId)
      .find((retry) => JSON.stringify(retry.command.lastError).includes("Runner is offline"))!;
    expect(offlineRetry.command).toMatchObject({
      id: command.id,
      runId: recoveringRunId,
      status: "pending",
      lastError: { message: "Runner is offline" },
    });
    expect(offlineRetry.command.attempts).toBe(heldSnapshots.at(-1)!.command.attempts + 1);
    expect(offlineRetry.run).toMatchObject({
      id: recoveringRunId,
      status: "queued",
      failure: null,
      bindingGeneration: null,
    });
    if (frozenContext.reportContext)
      expect(offlineRetry.run.reportContext).toEqual(frozenContext.reportContext);
    expect(offlineRetry.inputs).toEqual([
      {
        cancelReason: null,
        messageId: inputId,
        policy: "queue",
        runId: recoveringRunId,
        state: "claimed",
      },
    ]);
    expect(offlineRetry.runAttempts).toHaveLength(2);
    active.network.unblock();
    await waitFor(
      async () => {
        const state = await active.api["bootstrap.get"]({});
        return (
          state.ok &&
          state.data.environments.find((environment) => environment.id === active.environmentId)
            ?.connected === true
        );
      },
      30_000,
      "runner reconnected",
    );
    const reconnectedAt = Date.now();
    await waitFor(
      async () => (await liveAssistant(active, childThread.id)) === heldText,
      5_000,
      "continuation executing",
    );
    const engineStartDelayAfterReconnectMs = Date.now() - reconnectedAt;
    const deliveredTurn = (await captured()).findLast(
      (record) => record.dispatchReadinessTurn,
    )?.dispatchReadinessTurn;
    if (!deliveredTurn) throw new Error("Continuation input was not captured");
    await writeFile(deliveredTurn.releaseFile, "");
    await waitFor(
      async () => (await run(active, recoveringRunId)).status === "completed",
      60_000,
      "continuation completed",
    );
    const returned = await waitForValue(30_000, async () => {
      const state = await active.host.store.database
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", assignmentId)
        .executeTakeFirstOrThrow();
      return state.resultMessageId ? state : undefined;
    });
    expect(returned).toMatchObject({ status: "completed", resultStatus: "delivered" });
    const parentResult = await active.host.store.database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", returned.resultMessageId!)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(parentResult.content)).toContain("Task completed: Restart task");
    expect(JSON.stringify(parentResult.content)).not.toContain("Task failed");
    const parentContinuation = await waitForValue(30_000, async () =>
      active.host.store.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", parentId)
        .where("seedInputId", "=", returned.resultMessageId!)
        .executeTakeFirst(),
    );
    const parentDelivery = await waitForValue(30_000, async () =>
      (await captured())
        .flatMap((entry) => (entry.dispatchReadinessTurn ? [entry.dispatchReadinessTurn] : []))
        .find((turn) => JSON.stringify(turn.input).includes("Task completed: Restart task")),
    );
    await writeFile(parentDelivery.releaseFile, "");
    await waitFor(
      async () => (await run(active, parentContinuation.id)).status === "completed",
      60_000,
      "parent result completed",
    );
    await expectCompletedExactlyOnce(active, parentContinuation.id);
    const engineInputs = (await captured())
      .flatMap((record) => (record.dispatchReadinessTurn ? [record.dispatchReadinessTurn] : []))
      .map((turn) =>
        z
          .array(z.object({ text: z.string() }).passthrough())
          .parse(turn.input)
          .map(({ text }) => text)
          .join("\n"),
      );
    const deliveries = engineInputs.filter((input) =>
      input.includes("Opensteer restarted while you were working"),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(notice);
    expect(deliveries[0]!.split("Opensteer restarted while you were working")).toHaveLength(2);
    expect(engineInputs).toHaveLength(4);
    const resultDeliveries = engineInputs.filter((input) =>
      input.includes("Task completed: Restart task"),
    );
    expect(resultDeliveries).toHaveLength(1);
    const finalSnapshot = await observation.snapshot(command.id);
    expect(finalSnapshot.run.reportContext).toEqual(offlineRetry.run.reportContext);
    await expectCompletedExactlyOnce(active, recoveringRunId);
    const finalInput = await active.host.store.database
      .selectFrom("threadInputs")
      .select(["state", "cancelReason", "runId"])
      .where("messageId", "=", inputId)
      .executeTakeFirstOrThrow();
    expect(finalInput).toEqual({ state: "delivered", cancelReason: null, runId: recoveringRunId });
    const events = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select(["sequence", "type", "runId", "data"])
      .where("workspaceId", "=", active.mainWorkspaceId)
      .where("runId", "in", [parentSeedRunId, childRun.id, recoveringRunId])
      .orderBy("sequence", "asc")
      .execute();
    expect(
      events.filter((event) => event.runId === recoveringRunId && event.type === "run.failed"),
    ).toEqual([]);
    expect(
      events.filter((event) => event.runId === recoveringRunId && event.type === "run.completed"),
    ).toHaveLength(1);
    const evidenceDirectory = join(tmpdir(), "opensteer-e2e-artifacts", randomUUID());
    await mkdir(evidenceDirectory, { recursive: true });
    const artifact = join(evidenceDirectory, "dispatch-readiness.json");
    await writeFile(
      artifact,
      JSON.stringify(
        {
          assignmentId,
          childRunId: childRun.id,
          childThreadId: childThread.id,
          commandId: command.id,
          inputId,
          parentId,
          recoveringRunId,
          parentSeedRunId,
          childFailure: (await run(active, childRun.id)).failure,
          holdDurationMs,
          heldSnapshots,
          heldEvents,
          readyDispatchDelayMs,
          engineStartDelayAfterReconnectMs,
          events,
          retries: observation.snapshotsFor(recoveringRunId),
          refusals,
          engineInput: deliveries[0],
          engineDeliveryCount: deliveries.length,
          finalInput,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    process.stdout.write(`Dispatch readiness E2E evidence: ${artifact}\n`);
  }, 180_000);

  it("delivers a stop sent while the Runner was unreachable once it reattaches", async () => {
    const { stack: active } = await start({ executionLeaseMs: 60_000 });
    const threadId = await thread(active, "Stop while away");
    const runId = (await active.queueMessage({ text: "Write at length.", threadId })).runId!;
    await waitFor(async () => (await liveAssistant(active, threadId)) === heldText, 30_000, "held");

    active.network.block();
    await active.interruptRun(threadId, runId);
    await delay(1_000);
    expect((await run(active, runId)).status).toBe("running");
    active.network.unblock();
    await waitFor(
      async () => (await run(active, runId)).status === "interrupted",
      30_000,
      "stop delivered",
    );
  }, 120_000);

  it("delivers an answer to a Request given while the Runner was unreachable", async () => {
    const { stack: active } = await start({
      executionLeaseMs: 60_000,
      scenario: "run-scoped-approval",
    });
    const threadId = await thread(active, "Approve while away");
    await active.updateThreadAccess(threadId, "approval-required");
    const runId = (await active.queueMessage({ text: "Run the tests.", threadId })).runId!;
    const request = await waitForValue(30_000, async () =>
      active.host.store.database
        .selectFrom("requests")
        .select(["id", "presentation"])
        .where("originatingRunId", "=", runId)
        .where("status", "=", "pending")
        .executeTakeFirst(),
    );
    const presentation = request.presentation as {
      readonly options: readonly { readonly hint?: string; readonly id: string }[];
    };
    const allow = presentation.options.find((option) => option.hint !== "reject-once")!;

    active.network.block();
    const key = `respond-${randomUUID()}`;
    await testRpcData(
      active.hostOrigin,
      "commands.dispatch",
      {
        idempotencyKey: key,
        requestId: request.id,
        response: { kind: "choice", optionId: allow.id },
        type: "request.respond",
      },
      {
        headers: {
          cookie: active.sessionCookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: active.hostOrigin.origin,
        },
      },
    );
    active.network.unblock();
    await waitFor(async () => (await run(active, runId)).status === "completed", 30_000, "answer");
  }, 120_000);

  it("delivers an answer while a sibling Run in the same Workspace streams, without dropping the Runner", async () => {
    const {
      advanceSibling,
      release,
      stack: active,
    } = await start({
      executionLeaseMs: 60_000,
      maxConcurrentRuns: 2,
      scenario: "sibling-approval-race",
    });
    const workspace = await active.createWorkspace("Shared workspace");
    const streaming = await active.createThread({
      modelSelection,
      title: "Streaming",
      workspaceId: workspace.id,
    });
    const asking = await active.createThread({
      modelSelection,
      title: "Asking",
      workspaceId: workspace.id,
    });
    await active.updateThreadAccess(asking, "approval-required");
    const streamingRun = (await active.queueMessage({ text: "Keep notes.", threadId: streaming }))
      .runId!;
    const askingRun = (await active.queueMessage({ text: "Ask before acting.", threadId: asking }))
      .runId!;
    const request = await waitForValue(30_000, async () =>
      active.host.store.database
        .selectFrom("requests")
        .select(["id", "presentation"])
        .where("originatingRunId", "=", askingRun)
        .where("status", "=", "pending")
        .executeTakeFirst(),
    );
    await waitFor(
      async () =>
        (await storedRunnerEvents(active, streamingRun)).filter(
          ({ type }) => type === "assistant.message",
        ).length === 1,
      30_000,
      "sibling streaming",
    );
    const generation = await connectionGeneration(active);
    const presentation = request.presentation as {
      readonly options: readonly { readonly hint?: string; readonly id: string }[];
    };
    const allow = presentation.options.find((option) => option.hint !== "reject-once")!;

    await waitFor(
      async () => {
        const pending = await active.host.store.database
          .selectFrom("threadStatePending")
          .select("threadId")
          .execute();
        return pending.length === 0;
      },
      30_000,
      "initial projections",
    );
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    const blocker = active.host.store.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", workspace.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
        transaction,
      );
      locked.resolve(result.rows[0]!.pid);
      await unlock.promise;
    });
    void blocker.catch(locked.reject);
    const blockerPid = await locked.promise;
    const contention: number[][] = [];
    const waiting = async () => {
      const result = await sql<{ pid: number }>`
        with recursive blocked(pid) as (
          select pid from pg_stat_activity
          where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))
          union
          select activity.pid from pg_stat_activity activity
          join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
          where activity.datname = current_database()
        )
        select pid from blocked order by pid
      `.execute(active.host.store.database);
      contention.push(result.rows.map(({ pid }) => pid));
      return result.rows.length;
    };
    const key = `respond-${randomUUID()}`;
    const answer = testRpcData(
      active.hostOrigin,
      "commands.dispatch",
      {
        idempotencyKey: key,
        requestId: request.id,
        response: { kind: "choice", optionId: allow.id },
        type: "request.respond",
      },
      {
        headers: {
          cookie: active.sessionCookie,
          "content-type": "application/json",
          "idempotency-key": key,
          origin: active.hostOrigin.origin,
        },
      },
    );
    void answer.catch(() => undefined);
    try {
      // Queue the answer ahead of one sibling event on the same held row.
      // Acceptance must bypass that event while the answer holds the Workspace.
      await waitFor(async () => (await waiting()) === 1, 30_000, "blocked answer");
      await advanceSibling();
      await waitFor(async () => (await waiting()) >= 2, 30_000, "blocked sibling event");
    } finally {
      unlock.resolve();
      await blocker;
    }
    await answer;
    await waitFor(
      async () => (await run(active, askingRun)).status === "completed",
      30_000,
      "answer delivered",
    );
    await release();
    await waitFor(
      async () => (await run(active, streamingRun)).status === "completed",
      60_000,
      "sibling done",
    );
    const after = await connectionGeneration(active);
    expect(after).toBe(generation);
    const outputDirectory =
      process.env.OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT ??
      (await mkdtemp(join(tmpdir(), "opensteer-sibling-approval-")));
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      join(outputDirectory, "sibling-approval.json"),
      JSON.stringify(
        {
          blockerPid,
          contention,
          askingRun,
          streamingRun,
          connectionGenerations: { before: generation.toString(), after: after.toString() },
          status: {
            asking: await run(active, askingRun),
            streaming: await run(active, streamingRun),
          },
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Sibling approval E2E evidence: ${outputDirectory}`);
  }, 120_000);

  it("dispatches new turns while other Runs wait, bounded by the Runner's capacity", async () => {
    // The Host dispatches two commands at a time; three held Runs must all run.
    const { release, stack: active } = await start({
      executionLeaseMs: 60_000,
      maxConcurrentRuns: 4,
    });
    const threads = await Promise.all(
      ["First", "Second", "Third"].map((title) => thread(active, title)),
    );
    const runIds: RunId[] = [];
    for (const threadId of threads) {
      runIds.push((await active.queueMessage({ text: "Write at length.", threadId })).runId!);
    }
    await waitFor(
      async () =>
        (await Promise.all(threads.map((threadId) => liveAssistant(active, threadId)))).every(
          (text) => text === heldText,
        ),
      30_000,
      "every run running at once",
    );
    await release();
    for (const runId of runIds) {
      await waitFor(async () => (await run(active, runId)).status === "completed", 60_000, "done");
    }
  }, 180_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  budget: number | AbortSignal,
  label: string,
): Promise<void> {
  const deadline = typeof budget === "number" ? Date.now() + budget : undefined;
  for (;;) {
    if (typeof budget !== "number") budget.throwIfAborted();
    if (await predicate()) return;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(100, undefined, typeof budget === "number" ? undefined : { signal: budget });
  }
}

async function waitForValue<T>(timeoutMs: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for a value");
}
