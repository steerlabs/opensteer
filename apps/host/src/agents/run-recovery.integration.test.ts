import { NotificationStore } from "@opensteer/database";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  advanceExecutionClock,
  executionDisconnected,
  executionLeaseExpiresAt,
} from "./execution-clock.test-support.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AgentEventSchema,
  createId,
  ModelSelectionSchema,
  type RunId,
  type ThreadId,
  type MessageId,
} from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import {
  AgentControlResponseSchema,
  PendingAgentEventSchema,
  RunnerConnectionFenceSchema,
  sameRunnerConnectionFence,
} from "@opensteer/protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";
import type { WireRecord } from "./runner-wire.test-support.js";
import { readCodexRunCaptures } from "./codex-capture.test-support.js";

/*
 * Failing-first acceptance for spec.md, including review amendments A1–A7.
 * The Host, Runner, Postgres, WebSocket, driver and engine processes are real.
 * Gates affect delivery on the public wire; assertions use RPCs, durable rows,
 * engine captures and OS process liveness. No future production symbols are
 * imported. afterEach captures evidence even when an acceptance assertion fails.
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fixture = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const selection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const terminal = ["completed", "failed", "interrupted"];
const recordSchema = z.record(z.string(), z.unknown());
const eventSchema = z
  .object({
    type: z.string(),
    runId: z.string(),
    ordinal: z.number(),
    bindingGeneration: z.number(),
  })
  .passthrough();
const captureSchema = z
  .object({
    method: z.string().optional(),
    params: recordSchema.optional(),
    recoveryTurn: z
      .object({
        pid: z.number(),
        threadId: z.string(),
        input: z.array(z.unknown()),
        recovery: z.boolean(),
        scope: z.string().nullable(),
        acceptedAt: z.number(),
        priorPidsAlive: z.array(z.boolean()).optional(),
      })
      .optional(),
    recoveryChild: z.object({ pid: z.number(), scope: z.string().nullable() }).optional(),
    fakeOpensteerTokens: z.object({ agentTools: z.string().optional() }).optional(),
  })
  .passthrough();
type Capture = z.infer<typeof captureSchema>;
interface Fixture {
  readonly clock: ManualClock | undefined;
  readonly active: VerticalStack;
  readonly threadId: ThreadId;
  readonly scratch: string;
  readonly captures: () => Promise<Capture[]>;
  readonly release: () => Promise<void>;
}
interface Evidence {
  readonly name: string;
  readonly outcome: string;
  readonly failures: readonly string[];
  readonly snapshots: readonly unknown[];
  readonly engine: readonly unknown[];
  readonly wire: readonly unknown[];
  readonly checkpoints: readonly unknown[];
}

integration.sequential("Run recovery acceptance", () => {
  let fixtureState: Fixture | undefined;
  const runs: RunId[] = [];
  const checkpoints: unknown[] = [];
  const artifacts: Evidence[] = [];

  afterEach(async (context) => {
    const current = fixtureState;
    try {
      const snapshots = current
        ? await Promise.all(runs.map((id) => snapshot(current.active, id)))
        : [];
      artifacts.push({
        name: context.task.name,
        outcome: context.task.result?.state ?? "unknown",
        failures: context.task.result?.errors?.map((error) => error.message) ?? [],
        snapshots,
        engine: current
          ? (await current.captures())
              .filter(
                (entry) =>
                  entry.recoveryTurn ||
                  entry.recoveryChild ||
                  ["thread/start", "thread/resume", "turn/start"].includes(entry.method ?? ""),
              )
              .map((entry) =>
                entry.recoveryTurn
                  ? { recoveryTurn: entry.recoveryTurn }
                  : entry.recoveryChild
                    ? { recoveryChild: entry.recoveryChild }
                    : {
                        method: entry.method,
                        params: { threadId: entry.params?.threadId, input: entry.params?.input },
                      },
              )
          : [],
        wire:
          current?.active.wire?.frames.flatMap<unknown>(({ direction, frame }) => {
            if (frame.type === "runner.enroll" || frame.type === "runner.authenticate") {
              const descriptor = recordSchema.parse(frame.descriptor);
              return [
                {
                  direction,
                  type: frame.type,
                  descriptor: {
                    runnerId: descriptor.runnerId,
                    bootId: descriptor.bootId,
                    capabilities: descriptor.capabilities,
                  },
                },
              ];
            }
            if (
              [
                "host.challenge",
                "runner.enroll",
                "runner.authenticate",
                "host.welcome",
                "runner.harness-catalog",
              ].includes(frame.type)
            )
              return [];
            if (frame.type === "host.command") {
              const command = recordSchema.parse(frame.command);
              const context = command.context ? recordSchema.parse(command.context) : {};
              return [
                {
                  direction,
                  type: frame.type,
                  connectionId: frame.connectionId,
                  bootId: frame.bootId,
                  command: {
                    type: command.type,
                    commandId: command.commandId,
                    context: {
                      runId: context.runId,
                      bindingGeneration: context.bindingGeneration,
                      inputs: command.inputs,
                      reports: command.reports,
                      initialContext: context.initialContext,
                    },
                  },
                },
              ];
            }
            if (frame.type === "host.grants.credentials") {
              return [
                {
                  direction,
                  type: frame.type,
                  requestId: frame.requestId,
                  status: recordSchema.parse(frame.result).status,
                },
              ];
            }
            return [
              "runner.event",
              "runner.session-bound",
              "runner.grants.refresh",
              "host.error",
              "runner.executions.attach",
              "host.executions.attached",
              "host.events.acked",
              "host.runs.revoked",
              "host.executions.renewed",
              "runner.heartbeat",
              "runner.command-accepted",
              "runner.command-rejected",
              "runner.command-uncertain",
            ].includes(frame.type)
              ? [{ direction, frame }]
              : [];
          }) ?? [],
        checkpoints: [...checkpoints],
      });
    } finally {
      try {
        await current?.active.close();
      } finally {
        if (current) await rm(current.scratch, { recursive: true, force: true });
        fixtureState = undefined;
        runs.splice(0);
        checkpoints.splice(0);
      }
    }
  }, 90_000);

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-run-recovery-"));
    const path = join(directory, "recovery.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          command: "pnpm test:integration apps/host/src/agents/run-recovery.integration.test.ts",
          journeys: artifacts,
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Run recovery artifact: ${path}`);
  });

  async function start(
    options: {
      readonly firstScenario?: string;
      readonly laterScenario?: string;
      readonly engineArguments?: readonly string[];
      readonly leaseMs?: number;
      readonly contained?: boolean;
      readonly filter?: (direction: "host" | "runner", frame: WireRecord) => boolean;
      readonly child?: boolean;
    } = {},
  ): Promise<Fixture> {
    const clock = options.leaseMs ? new ManualClock() : undefined;
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-recovery-engine-"));
    const capture = join(scratch, "capture.jsonl");
    const release = join(scratch, "release");
    let boot = 0;
    const engineArguments = [
      "--unique-threads",
      "--capture-tokens",
      "--capture-process-id",
      `--capture=${capture}`,
      `--release-file=${release}`,
      ...(options.engineArguments ?? []),
    ];
    let active: VerticalStack;
    try {
      active = await startVerticalStack({
        ...(clock ? { executionClock: clock } : {}),
        databaseUrl: databaseUrl!,
        catalogTimeoutMs: 30_000,
        runTimeoutMs: 60_000,
        executionLeaseMs: options.leaseMs ?? 60_000,
        maxConcurrentRuns: 2,
        runnerWire: {
          ...(options.contained === undefined
            ? {}
            : { contained: () => options.contained === true }),
          ...(options.filter ? { filter: options.filter } : {}),
        },
        ...(options.child
          ? {
              runnerChild: { fixture, arguments: ["--scenario=recovery-held", ...engineArguments] },
            }
          : {}),
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses: () => {
          boot += 1;
          const registry = new HarnessRegistry();
          registry.registerDriver(
            new CodexHarnessDriver({
              launch: {
                executable: process.execPath,
                arguments: [
                  fixture,
                  `--scenario=${boot === 1 ? (options.firstScenario ?? "recovery-held") : (options.laterScenario ?? "recovery-held")}`,
                  ...engineArguments,
                ],
              },
            }),
          );
          return registry;
        },
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      });
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
    const threadId = await active.createThread({
      modelSelection: selection,
      title: "Recovery acceptance",
      workspaceId: active.mainWorkspaceId,
    });
    const value: Fixture = {
      clock,
      active,
      threadId,
      scratch,
      captures: async () =>
        (await readCodexRunCaptures(capture)).map((entry) => captureSchema.parse(entry)),
      release: () => writeFile(release, ""),
    };
    fixtureState = value;
    return value;
  }

  async function queue(current: Fixture, text = "Finish the recovery acceptance task.") {
    const queued = await current.active.queueMessage({ text, threadId: current.threadId });
    if (!queued.runId) throw new Error("Seed did not create a Run");
    runs.push(queued.runId);
    return { runId: queued.runId, messageId: queued.messageId };
  }
  async function held(current: Fixture, text?: string) {
    const queued = await queue(current, text);
    await waitFor(
      async () => (await current.captures()).some((entry) => entry.recoveryTurn),
      "engine accepted initial turn",
    );
    await waitFor(
      async () => (await row(current.active, queued.runId)).startedAt !== null,
      "run.started committed",
    );
    return queued;
  }

  async function expireDisconnected(current: Fixture, runId: RunId) {
    if (!current.clock) throw new Error("Expected a controlled execution clock");
    await waitFor(() => executionDisconnected(current.active), "Host observed Runner disconnect");
    const expiry = await executionLeaseExpiresAt(current.active.host, runId);
    expect(expiry.getTime()).toBeGreaterThan(current.clock.now());
    await advanceExecutionClock(
      current.clock,
      current.active.host,
      expiry.getTime() - current.clock.now() + 5_000,
    );
    checkpoints.push({
      stage: "expired disconnected lease",
      domainNow: current.clock.now(),
      leaseExpiresAt: expiry,
      completedPasses: await current.active.host.settleExecutionLeases(),
    });
  }
  async function recovery(current: Fixture, runId: RunId, ordinal = 2) {
    await waitFor(
      async () =>
        (await attempts(current.active, runId)).length >= ordinal ||
        terminal.includes((await row(current.active, runId)).status),
      "replacement attempt or visible outcome",
    );
    const state = await row(current.active, runId);
    expect(
      state.failure,
      `Expected recovery; Run ended ${state.status}: ${JSON.stringify(state.failure)}`,
    ).toBeNull();
    expect(terminal).not.toContain(state.status);
    const listed = await attempts(current.active, runId);
    expect(listed[ordinal - 1]).toMatchObject({ ordinal, reason: "recovery" });
    expect(listed[ordinal - 2]).toMatchObject({ outcome: "interrupted", status: "superseded" });
    const messages = await recoveryMessages(current.active, current.threadId);
    expect(messages).toHaveLength(ordinal - 1);
    expect(messages.at(-1)).toMatchObject({
      kind: "continuation",
      author: { kind: "platform", cause: "run-recovery", referenceId: listed[ordinal - 2]!.id },
    });
    const events = await eventsOf(current.active, runId);
    expect(events.filter((event) => event.type === "run.restarted")).toHaveLength(ordinal - 1);
    expect(events.filter((event) => event.type === "run.restarted").at(-1)?.data).toMatchObject({
      reason: "recovery",
      attempt: ordinal,
    });
    expect(await failedNotifications(current.active, runId)).toEqual([]);
    return messages.at(-1)!;
  }
  async function finish(current: Fixture, runId: RunId) {
    await current.release();
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "Run terminal outcome",
      60_000,
    );
    expect(await row(current.active, runId)).toMatchObject({ status: "completed", failure: null });
    expect(
      (await eventsOf(current.active, runId)).filter((entry) => entry.type === "run.completed"),
    ).toHaveLength(1);
    expect(await failedNotifications(current.active, runId)).toEqual([]);
  }

  it("1. resumes the same native conversation after a mid-turn Runner restart", async () => {
    const current = await start();
    const { runId, messageId } = await held(current);
    const original = (await current.captures()).find((entry) => entry.recoveryTurn)!.recoveryTurn!;
    await current.active.restartRunner();
    const message = await recovery(current, runId);
    expect(textOf(message.content)).toContain("Opensteer restarted while you were working");
    expect(textOf(message.content)).toContain(
      "Live browser, computer and phone sessions may have closed",
    );
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "resumed turn",
    );
    const captures = await current.captures();
    expect(captures.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    expect(captures.find((entry) => entry.method === "thread/resume")?.params?.threadId).toBe(
      original.threadId,
    );
    const resumed = captures.filter((entry) => entry.recoveryTurn).at(-1)!.recoveryTurn!;
    expect(resumed.threadId).toBe(original.threadId);
    expect(executeFrames(current.active).at(-1)!.inputs).toMatchObject([{ messageId: message.id }]);
    expect(executeFrames(current.active).at(-1)!.inputs).toHaveLength(1);
    expect(nativeMessageInputs(resumed.input)).toHaveLength(1);
    expect(textOf(resumed.input)).toContain(textOf(message.content));
    expect(textOf(resumed.input)).not.toContain("Finish the recovery acceptance task.");
    await finish(current, runId);
    expect((await attempts(current.active, runId))[1]).toMatchObject({
      outcome: "completed",
      engineStart: "cold",
    });
    expect(await inputState(current.active, messageId)).toMatchObject({
      state: "delivered",
      cancelReason: null,
    });
    const lost = (await attempts(current.active, runId))[0]!;
    expect(lost.usage).toBeNull();
  }, 120_000);

  it("2. keeps the Assignment open and delivers one successful parent result", async () => {
    const current = await start();
    const parent = await held(current, "Delegate a recovery task.");
    const captured = await current.captures();
    const token = captured.findLast((entry) => entry.fakeOpensteerTokens)?.fakeOpensteerTokens
      ?.agentTools;
    const proxy = JSON.stringify(captured)
      .match(/http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools/gu)
      ?.at(-1);
    if (!token || !proxy) throw new Error("Parent engine did not receive its control endpoint");
    const client = new Client({ name: "recovery-acceptance", version: "1" });
    const delegated = await (async () => {
      try {
        await client.connect(
          // The SDK getter includes undefined; its Transport interface uses an exact optional property.
          new StreamableHTTPClientTransport(new URL(proxy), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }) as Transport,
        );
        const result = await client.callTool({
          name: "thread_delegate",
          arguments: {
            task: "Keep working through a restart",
            title: "Recovery worker",
            workspaceId: current.active.mainWorkspaceId,
          },
        });
        expect(result.isError).not.toBe(true);
        return AgentControlResponseSchema.parse({
          type: "thread.delegate.result",
          requestId: randomUUID(),
          result: result.structuredContent,
        });
      } finally {
        await client.close();
      }
    })();
    if (delegated.type !== "thread.delegate.result" || !delegated.result.run)
      throw new Error("No delegated Run");
    const { assignmentId, run: child, thread } = delegated.result;
    runs.push(child.id);
    await waitFor(
      async () => (await row(current.active, child.id)).startedAt !== null,
      "child running",
    );
    const statusBefore = await current.active.api["thread.assignments.list"]({
      threadId: current.threadId,
    });
    checkpoints.push({ stage: "assignment before restart", assignment: statusBefore });
    expect(statusBefore).toMatchObject({
      ok: true,
      data: {
        assignments: [
          expect.objectContaining({
            id: assignmentId,
            status: "open",
            currentRunStatus: "running",
          }),
        ],
      },
    });
    await current.active.restartRunner();
    await recovery({ ...current, threadId: thread.id }, child.id);
    await waitFor(
      async () => (await attempts(current.active, child.id))[1]?.startedAt !== null,
      "child recovery started",
    );
    const statusDuring = await current.active.api["thread.assignments.list"]({
      threadId: current.threadId,
    });
    checkpoints.push({ stage: "assignment during recovery", assignment: statusDuring });
    expect(statusDuring).toMatchObject({
      ok: true,
      data: {
        assignments: [
          expect.objectContaining({
            id: assignmentId,
            status: "open",
            currentRunStatus: "running",
          }),
        ],
      },
    });
    expect(
      (await messagesOf(current.active, current.threadId)).filter((message) =>
        textOf(message.content).includes("Task failed"),
      ),
    ).toEqual([]);
    await finish(current, child.id);
    await waitFor(
      async () =>
        (await messagesOf(current.active, current.threadId)).some((message) =>
          textOf(message.content).includes("Task completed: Recovery worker"),
        ),
      "parent completion result",
    );
    const resultMessages = (await messagesOf(current.active, current.threadId)).filter((message) =>
      JSON.stringify(message.author).includes(assignmentId),
    );
    expect(resultMessages).toHaveLength(1);
    expect(textOf(resultMessages[0]!.content)).toContain("Task completed: Recovery worker");
    expect(
      await current.active.api["thread.assignments.list"]({ threadId: current.threadId }),
    ).toMatchObject({
      ok: true,
      data: { assignments: [expect.objectContaining({ id: assignmentId, status: "completed" })] },
    });
    const activity = await current.active.host.store.database
      .selectFrom("workspaceEvents")
      .select(["type", "data"])
      .where("threadId", "=", thread.id)
      .orderBy("sequence", "asc")
      .execute();
    expect(JSON.stringify(activity)).not.toContain('"status":"failed"');
    expect(await failedNotifications(current.active, parent.runId)).toEqual([]);
  }, 180_000);

  for (const [id, effect] of [
    ["3", false],
    ["3′", true],
  ] as const) {
    it(`${id}. quotes unconfirmed inputs without replaying their effects`, async () => {
      let lostBoot: unknown;
      const current = await start({
        filter: (direction, frame) => {
          if (direction !== "runner") return true;
          if (frame.type === "runner.session-bound" && lostBoot === undefined)
            lostBoot = frame.bootId;
          return !(frame.bootId === lostBoot && frame.type === "runner.event");
        },
      });
      const person = await current.active.host.store.database
        .selectFrom("users")
        .select("id")
        .executeTakeFirstOrThrow();
      const passiveReport = "Passive recovery context: preserve the project permission decision.";
      const reported = await current.active.host.store.enqueueThreadInput({
        content: [{ type: "text", text: passiveReport }],
        idempotencyKey: randomUUID(),
        policy: "report",
        requestedBy: person.id,
        source: { kind: "human" },
        threadId: current.threadId,
      });
      expect(reported.run).toBeNull();
      // The fake accepts the seed and performs its effect before run.started can commit.
      const seed = `Perform the effect once. ${effect ? "[effect]" : "[unconfirmed]"}`;
      const queued = await queue(current, seed);
      await waitFor(
        async () => (await current.captures()).some((entry) => entry.recoveryTurn),
        "accepted seed",
      );
      if (effect) {
        // The fake executed the user's requested write before the start receipt.
        await waitFor(
          async () =>
            (await readFile(
              join(current.active.mountedWorkspacePath, "recovery-effect"),
              "utf8",
            ).catch(() => "")) === "effect\n",
          "effect before run.started",
        );
      }
      expect((await row(current.active, queued.runId)).startedAt).toBeNull();
      expect(await inputState(current.active, queued.messageId)).toMatchObject({
        state: "claimed",
        deliveredAt: null,
      });
      checkpoints.push({
        stage: "before restart",
        input: await inputState(current.active, queued.messageId),
      });
      await current.active.restartRunner();
      const message = await recovery(current, queued.runId);
      expect(textOf(message.content)).toContain(seed);
      expect(textOf(message.content)).toMatch(/could not confirm|unconfirmed/iu);
      await waitFor(
        async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
        "recovery receives quote",
      );
      const resumed = (await current.captures())
        .filter((entry) => entry.recoveryTurn)
        .at(-1)!.recoveryTurn!;
      expect(nativeMessageInputs(resumed.input)).toHaveLength(1);
      expect(textOf(resumed.input)).toContain(textOf(message.content));
      const execute = executeFrames(current.active).at(-1)!;
      expect(execute.inputs).toHaveLength(1);
      const initialDispatch = executeFrames(current.active)[0]!;
      expect(JSON.stringify(initialDispatch.reports)).toContain(passiveReport);
      expect(execute.reports).toEqual(initialDispatch.reports);
      expect(execute.context.initialContext).toEqual(initialDispatch.context.initialContext);
      await finish(current, queued.runId);
      expect(await inputState(current.active, queued.messageId)).toMatchObject({
        state: "delivered",
        cancelReason: null,
      });
      const receipts = (await eventsOf(current.active, queued.runId)).filter((event) => {
        if (event.type !== "thread-input.updated") return false;
        const input = recordSchema.parse(recordSchema.parse(event.data).input);
        return input.messageId === queued.messageId && input.state === "delivered";
      });
      expect(receipts).toHaveLength(1);
      if (effect)
        expect(
          await readFile(join(current.active.mountedWorkspacePath, "recovery-effect"), "utf8"),
        ).toBe("effect\n");
    }, 120_000);
  }

  it("4. describes unfinished tools and contains their real processes", async () => {
    const current = await start({ engineArguments: ["--recovery-tool"] });
    const { runId } = await held(current);
    await current.active.waitForToolStart(runId);
    const child = (await current.captures()).find((entry) => entry.recoveryChild)!.recoveryChild!;
    expect(alive(child.pid)).toBe(true);
    expect(child.scope).toBeTruthy();
    await current.active.restartRunner();
    const message = await recovery(current, runId);
    expect(textOf(message.content)).toContain("Started, completion unknown:");
    expect(textOf(message.content)).toContain("sleep 600 # recovery acceptance");
    expect(textOf(message.content)).toMatch(/Check before repeating anything with side effects/iu);
    expect(alive(child.pid)).toBe(false);
    await finish(current, runId);
  }, 120_000);

  it("5. cancels a lost live approval and accepts a fresh approval", async () => {
    const current = await start({
      firstScenario: "run-scoped-approval",
      laterScenario: "run-scoped-approval",
    });
    await current.active.updateThreadAccess(current.threadId, "approval-required");
    const { runId } = await queue(current, "Run the tests.");
    const request = await pendingApproval(current.active, runId);
    await current.active.restartRunner();
    const message = await recovery(current, runId);
    const lost = await requestRow(current.active, request.id);
    expect(lost).toMatchObject({ status: "cancelled", cancellationReason: "process-lost" });
    expect(textOf(message.content)).toContain("did not complete; ask again if you still need it.");
    expect(textOf(message.content)).toContain(request.presentation.title);
    const fresh = await pendingApproval(current.active, runId, request.id);
    await answer(current.active, fresh);
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "new answer completes Run",
    );
    expect((await row(current.active, runId)).status).toBe("completed");
  }, 120_000);

  it("6. Stop wins over a subsequent Runner restart", async () => {
    const current = await start();
    const { runId } = await held(current);
    current.active.network.block();
    await current.active.interruptRun(current.threadId, runId);
    const restart = current.active.restartRunner();
    current.active.network.unblock();
    await restart;
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "stopped Run",
    );
    expect((await row(current.active, runId)).status).toBe("interrupted");
    expect(await attempts(current.active, runId)).toHaveLength(1);
    expect(await recoveryMessages(current.active, current.threadId)).toEqual([]);
    expect(await failedNotifications(current.active, runId)).toEqual([]);
  }, 120_000);

  it("7. permits three recoveries and ends the fourth restart visibly", async () => {
    const current = await start();
    const { runId } = await held(current);
    for (let ordinal = 2; ordinal <= 4; ordinal += 1) {
      await current.active.restartRunner();
      await recovery(current, runId, ordinal);
      await waitFor(
        async () =>
          (await current.captures()).filter((entry) => entry.recoveryTurn).length === ordinal &&
          (await attempts(current.active, runId))[ordinal - 1]?.startedAt !== null,
        `recovery ${ordinal - 1} started`,
      );
    }
    await current.active.restartRunner();
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "crash-loop guard",
    );
    expect(await row(current.active, runId)).toMatchObject({
      status: "failed",
      failure: { code: "runner_restarted" },
    });
    expect(JSON.stringify((await row(current.active, runId)).failure)).toMatch(
      /three|repeated|five minutes/iu,
    );
    expect(
      (await attempts(current.active, runId)).filter(
        (entry) => String(entry.reason) === "recovery",
      ),
    ).toHaveLength(3);
    expect(await recoveryMessages(current.active, current.threadId)).toHaveLength(3);
  }, 180_000);

  it("8. queues an expired execution and runs its recovery once after reattach", async () => {
    const current = await start({ leaseMs: 12_000, contained: false });
    const { runId } = await held(current);
    current.active.network.block();
    await expireDisconnected(current, runId);
    await recovery(current, runId);
    expect(await row(current.active, runId)).toMatchObject({
      status: "queued",
      bindingGeneration: null,
    });
    const before = await snapshot(current.active, runId);
    checkpoints.push({ stage: "offline", snapshot: before });
    current.active.network.unblock();
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "same-boot recovery executes",
    );
    const attached = current.active.wire!.frames.filter(
      ({ frame }) => frame.type === "host.executions.attached",
    );
    expect(JSON.stringify(attached)).toContain('"status":"revoked"');
    await finish(current, runId);
    expect(await attempts(current.active, runId)).toHaveLength(2);
    expect(
      textOf((await recoveryMessages(current.active, current.threadId))[0]!.content),
    ).toContain("stopped responding");
  }, 120_000);

  it("9. refuses cross-boot recovery dispatch without the containment capability", async () => {
    const current = await start({ contained: false });
    const { runId } = await held(current);
    await current.active.restartRunner();
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "unproven boot refused",
    );
    expect(await row(current.active, runId)).toMatchObject({
      status: "failed",
      failure: { code: "runner_restarted" },
    });
    // Classification must still create the recovery; its one dispatch gate refuses it.
    expect((await attempts(current.active, runId))[1]).toMatchObject({
      reason: "recovery",
      dispatchedAt: null,
    });
    expect((await current.captures()).filter((entry) => entry.recoveryTurn)).toHaveLength(1);
  }, 120_000);

  it("10. preserves the background reply, phase and deadline across restart", async () => {
    const current = await start({ firstScenario: "background-children" });
    const { runId } = await queue(current, "Research in the background.");
    await waitFor(
      async () => (await row(current.active, runId)).phase === "background",
      "background phase",
    );
    const before = await row(current.active, runId);
    const replies = (await messagesOf(current.active, current.threadId)).filter(
      (message) => message.kind === "assistant",
    );
    expect(replies).toHaveLength(1);
    await current.active.restartRunner();
    const message = await recovery(current, runId);
    expect(textOf(message.content)).toContain(
      "Your previous reply was already sent; background work you left running was stopped.",
    );
    expect(await row(current.active, runId)).toMatchObject({
      phase: "background",
      backgroundDeadlineAt: before.backgroundDeadlineAt,
      turnReplyMessageId: before.turnReplyMessageId,
    });
    expect(
      (await messagesOf(current.active, current.threadId)).filter(
        (entry) =>
          entry.kind === "assistant" && textOf(entry.content) === textOf(replies[0]!.content),
      ),
    ).toHaveLength(1);
    await finish(current, runId);
    expect((await row(current.active, runId)).backgroundDeadlineAt).toEqual(
      before.backgroundDeadlineAt,
    );
  }, 120_000);

  it("10a. ends an already-expired background Run at loss classification without recovery", async () => {
    const current = await start({ firstScenario: "background-children" });
    const { runId } = await queue(current, "Research until the background deadline.");
    await waitFor(
      async () => (await row(current.active, runId)).phase === "background",
      "background phase",
    );
    const releaseSweep = Promise.withResolvers<void>();
    const store = current.active.host.store;
    const sweep = store.stopRunsPastBackgroundDeadline.bind(store);
    const attach = store.attachRunnerExecutions.bind(store);
    let classifiedAfterDeadline = false;
    // Hold the sweep so the attach classifies the loss first, with an expired deadline.
    vi.spyOn(store, "stopRunsPastBackgroundDeadline").mockImplementation(async (...args) => {
      await releaseSweep.promise;
      return sweep(...args);
    });
    vi.spyOn(store, "attachRunnerExecutions").mockImplementation(async (...args) => {
      const expired = new Date(Date.now() - 60_000);
      await store.database
        .updateTable("runs")
        .set({ backgroundDeadlineAt: expired })
        .where("id", "=", runId)
        .execute();
      const before = await row(current.active, runId);
      expect(before).toMatchObject({ phase: "background", status: "running" });
      classifiedAfterDeadline = true;
      checkpoints.push({ stage: "deadline expired before loss classification", run: before });
      return attach(...args);
    });
    try {
      await current.active.restartRunner();
      await waitFor(
        async () => terminal.includes((await row(current.active, runId)).status),
        "expired lost Run ends",
      );
      expect(classifiedAfterDeadline).toBe(true);
      expect((await row(current.active, runId)).status).toBe("interrupted");
      expect(await attempts(current.active, runId)).toHaveLength(1);
      expect(await recoveryMessages(current.active, current.threadId)).toEqual([]);
      expect(executeFrames(current.active)).toHaveLength(1);
      await expectDeadlineSettled(current.active, runId, current.threadId);
    } finally {
      releaseSweep.resolve();
    }
  }, 120_000);

  it("10b. expires a queued background recovery and never dispatches it on reconnect", async () => {
    const current = await start({ firstScenario: "background-children", leaseMs: 12_000 });
    const { runId } = await queue(current, "Research while the computer is away.");
    await waitFor(
      async () => (await row(current.active, runId)).phase === "background",
      "background phase",
    );
    current.active.network.block();
    await expireDisconnected(current, runId);
    const message = await recovery(current, runId);
    expect(await row(current.active, runId)).toMatchObject({
      phase: "background",
      status: "queued",
    });
    expect(await inputState(current.active, message.id)).toMatchObject({ state: "claimed" });
    await current.active.host.store.database
      .updateTable("runs")
      .set({ backgroundDeadlineAt: new Date(Date.now() - 60_000) })
      .where("id", "=", runId)
      .execute();
    await advanceExecutionClock(current.clock!, current.active.host, 5_000);
    checkpoints.push({
      stage: "background deadline sweep completed",
      domainNow: current.clock!.now(),
      completedPasses: await current.active.host.settleExecutionLeases(),
    });
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "queued deadline sweep",
    );
    expect((await row(current.active, runId)).status).toBe("interrupted");
    const listed = await attempts(current.active, runId);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({ reason: "recovery", dispatchedAt: null });
    expect(listed[1]!.endedAt).not.toBeNull();
    expect(await inputState(current.active, message.id)).toMatchObject({ state: "cancelled" });
    await expectDeadlineSettled(current.active, runId, current.threadId);
    const commands = await current.active.host.store.database
      .selectFrom("commands")
      .select("status")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .orderBy("createdAt", "asc")
      .execute();
    expect(commands.map((command) => command.status)).toEqual(["succeeded", "failed"]);
    const attaches = current.active.wire!.frames.filter(
      ({ frame }) => frame.type === "host.executions.attached",
    ).length;
    current.active.network.unblock();
    await waitFor(
      async () =>
        current.active.wire!.frames.filter(({ frame }) => frame.type === "host.executions.attached")
          .length > attaches,
      "reattach after deadline",
    );
    expect(executeFrames(current.active)).toHaveLength(1);
    expect(
      (await current.captures()).filter((entry) => entry.method === "turn/start"),
    ).toHaveLength(1);
    expect((await row(current.active, runId)).status).toBe("interrupted");
    await expectDeadlineSettled(current.active, runId, current.threadId);
  }, 120_000);

  it("11. interrupts an occurrence without replay, preserves failure count, and runs the next tick", async () => {
    const current = await start();
    const log = join(current.scratch, "occurrences");
    const releaseTick = join(current.scratch, "next-tick");
    const program = `import {appendFileSync, existsSync} from 'node:fs';
      export default async function () {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({id: process.env.OPENSTEER_OCCURRENCE_ID}) + String.fromCharCode(10));
        if (!existsSync(${JSON.stringify(releaseTick)})) await new Promise((resolve) => {
          const poll = setInterval(() => { if (existsSync(${JSON.stringify(releaseTick)})) { clearInterval(poll); resolve(); } }, 50);
        });
      }`;
    const created = await current.active.api["commands.dispatch"]({
      type: "trigger.create",
      idempotencyKey: randomUUID(),
      input: {
        anchorThreadId: current.threadId,
        name: "Recovery recurring program",
        program: { language: "javascript", source: program, toolContractVersion: 2 },
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "*/5 * * * * *", timezone: "UTC" },
        },
      },
    });
    if (!created.ok || created.data.type !== "trigger.create")
      throw new Error(`Trigger setup failed: ${JSON.stringify(created)}`);
    const triggerId = created.data.trigger.id;
    await waitFor(
      async () => (await readFile(log, "utf8").catch(() => "")).length > 0,
      "scheduled occurrence starts",
    );
    const before = await current.active.host.store.database
      .selectFrom("triggerOccurrences")
      .selectAll()
      .where("triggerId", "=", triggerId)
      .where("status", "=", "running")
      .executeTakeFirstOrThrow();
    const failures = created.data.trigger.consecutiveFailures;
    await settledTriggerDispatches(current.active);
    await current.active.restartRunner();
    await waitFor(
      async () =>
        (
          await current.active.host.store.database
            .selectFrom("triggerOccurrences")
            .select("status")
            .where("id", "=", before.id)
            .executeTakeFirstOrThrow()
        ).status === "failed",
      "occurrence interrupted",
    );
    const lost = await current.active.host.store.database
      .selectFrom("triggerOccurrences")
      .selectAll()
      .where("id", "=", before.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(lost.error)).toMatch(
      /runner_disconnected|host_restarted|disconnect|restart/iu,
    );
    expect(lost.executionGeneration).toBe(before.executionGeneration);
    expect(
      (
        await current.active.host.store.database
          .selectFrom("triggers")
          .selectAll()
          .where("id", "=", triggerId)
          .executeTakeFirstOrThrow()
      ).consecutiveFailures,
    ).toBe(failures);
    await writeFile(join(current.scratch, "next-tick"), "");
    await waitFor(
      async () =>
        Boolean(
          await current.active.host.store.database
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("triggerId", "=", triggerId)
            .where("id", "!=", before.id)
            .where("status", "=", "succeeded")
            .executeTakeFirst(),
        ),
      "next recurring tick succeeds",
    );
    const occurrences = await current.active.host.store.database
      .selectFrom("triggerOccurrences")
      .selectAll()
      .where("triggerId", "=", triggerId)
      .execute();
    checkpoints.push({ triggerId, before, lost, occurrences });
    expect(occurrences.filter((entry) => entry.id === before.id)).toHaveLength(1);
    const launches = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => z.object({ id: z.string() }).parse(JSON.parse(line)));
    expect(launches.filter((entry) => entry.id === before.id)).toHaveLength(1);
    const paused = await current.active.api["commands.dispatch"]({
      type: "trigger.status.set",
      triggerId,
      status: "paused",
      idempotencyKey: randomUUID(),
    });
    if (!paused.ok) throw new Error(paused.error.message);
    await settledTriggerDispatches(current.active);
    const oneShotStarted = join(current.scratch, "one-shot-started");
    const oneShot = await current.active.api["commands.dispatch"]({
      type: "trigger.create",
      idempotencyKey: randomUUID(),
      input: {
        anchorThreadId: current.threadId,
        name: "Recovery one-shot",
        program: {
          language: "javascript",
          source: `import {writeFileSync} from 'node:fs'; export default async function () {
            writeFileSync(${JSON.stringify(oneShotStarted)}, process.env.OPENSTEER_OCCURRENCE_ID);
            await new Promise(() => { setInterval(() => {}, 1000); });
          }`,
          toolContractVersion: 2,
        },
        source: {
          kind: "schedule",
          schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
        },
      },
    });
    if (!oneShot.ok || oneShot.data.type !== "trigger.create")
      throw new Error("One-shot setup failed");
    const oneShotId = oneShot.data.trigger.id;
    await waitFor(
      async () => (await readFile(oneShotStarted, "utf8").catch(() => "")).length > 0,
      "one-shot program executing",
    );
    await settledTriggerDispatches(current.active);
    await current.active.restartRunner();
    await waitFor(
      async () =>
        (await messagesOf(current.active, current.threadId)).some((message) =>
          textOf(message.content).includes("Recovery one-shot"),
        ),
      "anchor failure notice",
    );
    const notice = (await messagesOf(current.active, current.threadId)).find((message) =>
      textOf(message.content).includes("Recovery one-shot"),
    )!;
    checkpoints.push({ oneShotId, notice });
    expect(notice.author).toMatchObject({ kind: "platform", cause: "automation-stopped" });
    expect(textOf(notice.content)).toMatch(/restart|interrupt/iu);
    expect(textOf(notice.content)).toMatch(/may not have finished/iu);
    expect(textOf(notice.content)).toMatch(/run.*again/iu);
  }, 180_000);

  it("12. relaunches a watch on the next boot with generation +1 and restartCount zero", async () => {
    const current = await start();
    const created = await current.active.api["commands.dispatch"]({
      type: "trigger.create",
      idempotencyKey: randomUUID(),
      input: {
        anchorThreadId: current.threadId,
        name: "Recovery watch",
        source: { kind: "watch" },
        program: {
          language: "javascript",
          source:
            "export default async function () { await new Promise(() => { setInterval(() => {}, 1000); }); }",
          toolContractVersion: 2,
        },
      },
    });
    if (!created.ok || created.data.type !== "trigger.create")
      throw new Error(`Watch setup failed: ${JSON.stringify(created)}`);
    const triggerId = created.data.trigger.id;
    const activation = () =>
      current.active.host.store.database
        .selectFrom("triggerWatchActivations")
        .selectAll()
        .where("triggerId", "=", triggerId)
        .executeTakeFirstOrThrow();
    await waitFor(async () => (await activation()).observed === "running", "watch running");
    const before = await activation();
    await current.active.restartRunner();
    await waitFor(async () => {
      const after = await activation();
      return after.runnerBootId !== before.runnerBootId && after.observed === "running";
    }, "watch relaunched");
    const after = await activation();
    expect(BigInt(after.executionGeneration)).toBe(BigInt(before.executionGeneration) + 1n);
    expect(after.restartCount).toBe(0);
    expect(after.desired).toBe("active");
    expect(
      (
        await current.active.host.store.database
          .selectFrom("triggers")
          .select("status")
          .where("id", "=", triggerId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("active");
    checkpoints.push({ triggerId, before, after });
  }, 120_000);

  it("13. deduplicates concurrent expiry, attach and a replayed lease-lost event", async () => {
    const current = await start({ leaseMs: 12_000, contained: false });
    const { runId } = await held(current);
    const original = current.active.wire!.frames.find(
      ({ frame }) => frame.type === "runner.event",
    )!.frame;
    const releaseRace = Promise.withResolvers<void>();
    let sweepEntered = false;
    let attachEntered = false;
    const sweep = current.active.host.store.recoverRunsWithExpiredExecutionBindings.bind(
      current.active.host.store,
    );
    const attach = current.active.host.store.attachRunnerExecutions.bind(current.active.host.store);
    vi.spyOn(
      current.active.host.store,
      "recoverRunsWithExpiredExecutionBindings",
    ).mockImplementation(async (...args) => {
      sweepEntered = true;
      await releaseRace.promise;
      return sweep(...args);
    });
    vi.spyOn(current.active.host.store, "attachRunnerExecutions").mockImplementation(
      async (...args) => {
        attachEntered = true;
        await releaseRace.promise;
        return attach(...args);
      },
    );
    try {
      current.active.network.block();
      await waitFor(() => executionDisconnected(current.active), "Host observed Runner disconnect");
      current.clock!.advanceBy(13_000);
      await waitFor(async () => sweepEntered, "expiry sweep waiting at race barrier");
      current.active.network.unblock();
      await waitFor(async () => attachEntered, "expired attach waiting at race barrier");
      expect(sweepEntered && attachEntered).toBe(true);
      checkpoints.push({
        stage: "both expiry race gates entered",
        domainNow: current.clock!.now(),
      });
    } finally {
      releaseRace.resolve();
    }
    await recovery(current, runId);
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "recovery dispatch after attach",
    );
    await Promise.all([
      current.active.host.store.recoverRunsWithExpiredExecutionBindings(),
      current.active.host.store.recoverRunsWithExpiredExecutionBindings(),
    ]);
    await waitFor(
      async () => (await attempts(current.active, runId))[1]!.startedAt !== null,
      "successor start committed",
    );
    const nextOrdinal = (await row(current.active, runId)).nextRunnerOrdinal;
    const storedBefore = await eventsOf(current.active, runId);
    const staleEvent = {
      ...eventSchema.parse(original.event),
      type: "run.interrupted",
      ordinal: nextOrdinal,
      data: { status: "interrupted", cause: "lease-lost" },
    };
    const wireStart = current.active.wire!.frames.length;
    sendStale(current.active, original, staleEvent);
    await confirmHealthyBindingAfterReplay(current.active, runId, wireStart);
    expect(await eventsOf(current.active, runId)).toEqual(storedBefore);
    expect((await row(current.active, runId)).nextRunnerOrdinal).toBe(nextOrdinal);
    expect(await attempts(current.active, runId)).toHaveLength(2);
    expect(await recoveryMessages(current.active, current.threadId)).toHaveLength(1);
    await finish(current, runId);
  }, 120_000);

  it("14. Stop settles a queued recovery before it can dispatch", async () => {
    const current = await start({ leaseMs: 12_000, contained: false });
    const { runId } = await held(current);
    current.active.network.block();
    await expireDisconnected(current, runId);
    const message = await recovery(current, runId);
    expect((await row(current.active, runId)).status).toBe("queued");
    await current.active.interruptRun(current.threadId, runId);
    await waitFor(
      async () => (await row(current.active, runId)).status === "interrupted",
      "queued recovery stopped",
    );
    expect(await inputState(current.active, message.id)).toMatchObject({ state: "cancelled" });
    expect((await attempts(current.active, runId))[1]).toMatchObject({
      outcome: "cancelled",
      dispatchedAt: null,
    });
    current.active.network.unblock();
    await current.release();
    await waitFor(
      async () =>
        current.active.wire!.frames.filter(({ frame }) => frame.type === "host.executions.attached")
          .length >= 2,
      "reattach after Stop",
    );
    expect((await current.captures()).filter((entry) => entry.recoveryTurn)).toHaveLength(1);
    expect((await row(current.active, runId)).status).toBe("interrupted");
  }, 120_000);

  it("15. drops late lost-binding events without storing or consuming their ordinal", async () => {
    const current = await start({ leaseMs: 12_000, contained: false });
    const { runId } = await held(current);
    const original = current.active.wire!.frames.find(
      ({ frame }) => frame.type === "runner.event",
    )!.frame;
    current.active.network.block();
    await expireDisconnected(current, runId);
    await recovery(current, runId);
    current.active.network.unblock();
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "successor running",
    );
    await waitFor(
      async () => (await attempts(current.active, runId))[1]!.startedAt !== null,
      "successor start committed",
    );
    const before = await row(current.active, runId);
    const storedBefore = await eventsOf(current.active, runId);
    const stale = {
      ...eventSchema.parse(original.event),
      type: "assistant.message",
      ordinal: before.nextRunnerOrdinal,
      data: {
        messageId: createId("message"),
        content: [{ type: "text", text: "STALE_LOST_BINDING_EFFECT" }],
      },
    };
    PendingAgentEventSchema.parse(stale);
    const wireStart = current.active.wire!.frames.length;
    sendStale(current.active, original, stale);
    await confirmHealthyBindingAfterReplay(current.active, runId, wireStart);
    expect((await row(current.active, runId)).nextRunnerOrdinal).toBe(before.nextRunnerOrdinal);
    expect(await eventsOf(current.active, runId)).toEqual(storedBefore);
    expect(await attempts(current.active, runId)).toHaveLength(2);
    expect((await row(current.active, runId)).status).toBe("running");
    expect(JSON.stringify(await messagesOf(current.active, current.threadId))).not.toContain(
      "STALE_LOST_BINDING_EFFECT",
    );
    await finish(current, runId);
  }, 120_000);

  it("16. settles an approval answer given while its engine is lost", async () => {
    const current = await start({
      firstScenario: "run-scoped-approval",
      laterScenario: "run-scoped-approval",
    });
    await current.active.updateThreadAccess(current.threadId, "approval-required");
    const { runId } = await queue(current, "Ask before running tests.");
    const pending = await pendingApproval(current.active, runId);
    current.active.network.block();
    await waitFor(async () => {
      const result = await current.active.api["bootstrap.get"]({});
      return (
        result.ok &&
        result.data.environments.find((entry) => entry.id === current.active.environmentId)
          ?.connected === false
      );
    }, "Runner down");
    const selectedDecision = await answer(current.active, pending);
    const answered = await requestRow(current.active, pending.id);
    expect(answered.responseCommandId).not.toBeNull();
    const restart = current.active.restartRunner();
    current.active.network.unblock();
    await restart;
    const message = await recovery(current, runId);
    expect(textOf(message.content)).toContain("did not complete; ask again if you still need it.");
    expect(textOf(message.content)).toContain(pending.presentation.title);
    const command = await current.active.host.store.database
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", answered.responseCommandId!)
      .executeTakeFirstOrThrow();
    expect(command.status).toBe("failed");
    expect(await requestRow(current.active, pending.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "process-lost",
      responseCommandId: null,
    });
    expect(
      (await current.captures()).filter(
        (entry) =>
          entry.id === "run-scoped-approval-rpc" &&
          entry.result !== undefined &&
          recordSchema.parse(entry.result).decision === selectedDecision,
      ),
    ).toEqual([]);
    const fresh = await pendingApproval(current.active, runId, pending.id);
    await answer(current.active, fresh);
    await waitFor(
      async () => terminal.includes((await row(current.active, runId)).status),
      "fresh approval completes Run",
    );
    expect((await row(current.active, runId)).status).toBe("completed");
  }, 120_000);

  for (const mode of ["no native reference", "resume failure"] as const) {
    it(`17. fails visibly on ${mode} without silently starting a fresh conversation`, async () => {
      let lostBoot: unknown;
      const current = await start(
        mode === "resume failure"
          ? { laterScenario: "resume-missing" }
          : {
              filter: (direction: "host" | "runner", frame: WireRecord) => {
                if (direction !== "runner") return true;
                if (frame.type === "runner.session-bound") {
                  lostBoot ??= frame.bootId;
                  return frame.bootId !== lostBoot;
                }
                return !(frame.type === "runner.event" && frame.bootId === lostBoot);
              },
            },
      );
      const { runId } = mode === "no native reference" ? await queue(current) : await held(current);
      await waitFor(
        async () => (await current.captures()).some((entry) => entry.recoveryTurn),
        "initial conversation opened",
      );
      await current.active.restartRunner();
      await waitFor(
        async () => terminal.includes((await row(current.active, runId)).status),
        "visible resume failure",
      );
      expect((await row(current.active, runId)).status).toBe("failed");
      expect(
        (await current.captures()).filter((entry) => entry.method === "thread/start"),
      ).toHaveLength(1);
      if (mode === "no native reference") {
        expect(
          (await current.captures()).filter((entry) => entry.method === "thread/resume"),
        ).toHaveLength(0);
        expect(await attempts(current.active, runId)).toHaveLength(1);
      } else {
        expect((await attempts(current.active, runId))[1]).toMatchObject({
          reason: "recovery",
          outcome: "failed",
        });
        expect(
          (await current.captures()).filter((entry) => entry.method === "thread/resume"),
        ).toHaveLength(1);
        expect(JSON.stringify((await row(current.active, runId)).failure)).toMatch(
          /resume|rollout|conversation/iu,
        );
      }
    }, 120_000);
  }

  it("18. leaves a healthy second Runner's Run and binding untouched", async () => {
    const current = await start();
    const companion = await current.active.startAdditionalRunner();
    const created = await current.active.api["commands.dispatch"]({
      type: "thread.create",
      idempotencyKey: randomUUID(),
      title: "Healthy companion task",
      workspaceId: current.active.mainWorkspaceId,
      environmentId: companion.environmentId,
      harnessInstanceId: companion.harnessInstanceId,
      modelSelection: selection,
    });
    if (!created.ok || created.data.type !== "thread.create")
      throw new Error("Companion thread creation failed");
    const healthyThreadId = created.data.thread.id;
    const { runId } = await held(current);
    const queued = await current.active.queueMessage({
      threadId: healthyThreadId,
      text: "Keep the healthy task running.",
    });
    if (!queued.runId) throw new Error("No healthy Run");
    const healthyId = queued.runId;
    runs.push(healthyId);
    await waitFor(
      async () => (await row(current.active, healthyId)).startedAt !== null,
      "second Runner working",
    );
    const before = await row(current.active, healthyId);
    const initialTurns = (await current.captures()).flatMap((entry) =>
      entry.recoveryTurn ? [entry.recoveryTurn] : [],
    );
    expect(initialTurns).toHaveLength(2);
    const primaryEngine = initialTurns[0]!;
    const companionEngine = initialTurns[1]!;
    expect(primaryEngine.scope).toBeTruthy();
    expect(companionEngine.scope).toBeTruthy();
    expect(companionEngine.scope!.split(".")[0]).not.toBe(primaryEngine.scope!.split(".")[0]);
    expect(alive(companionEngine.pid)).toBe(true);
    checkpoints.push({ stage: "distinct Runner installations", primaryEngine, companionEngine });
    await current.active.restartRunner();
    expect(alive(companionEngine.pid), "primary startup must not reap the companion engine").toBe(
      true,
    );
    await recovery(current, runId);
    const after = await row(current.active, healthyId);
    expect(alive(companionEngine.pid), "companion PID survives primary recovery dispatch").toBe(
      true,
    );
    const surviving = (await current.captures())
      .flatMap((entry) => (entry.recoveryTurn ? [entry.recoveryTurn] : []))
      .filter((turn) => turn.threadId === companionEngine.threadId);
    expect(surviving.map((turn) => turn.pid)).toEqual([companionEngine.pid]);
    checkpoints.push({
      stage: "companion survived primary restart",
      companionPid: companionEngine.pid,
      alive: alive(companionEngine.pid),
      run: after,
    });
    expect(after).toMatchObject({
      status: "running",
      failure: null,
      bindingGeneration: before.bindingGeneration,
      nextRunnerOrdinal: before.nextRunnerOrdinal,
    });
    expect(await attempts(current.active, healthyId)).toHaveLength(1);
    expect(await recoveryMessages(current.active, healthyThreadId)).toEqual([]);
    await current.release();
    await waitFor(
      async () => (await row(current.active, healthyId)).status === "completed",
      "healthy Runner completes",
    );
    await finish(current, runId);
  }, 180_000);

  it("19. reaps a SIGKILLed Runner's surviving marked processes before recovery executes", async () => {
    const current = await start({
      child: true,
      engineArguments: [
        "--survive-parent",
        "--recovery-tool",
        "--watch-pids-file=recovery-prior-pids.json",
      ],
    });
    const { runId } = await held(current);
    await current.active.waitForToolStart(runId);
    const captured = await current.captures();
    const engine = captured.find((entry) => entry.recoveryTurn)!.recoveryTurn!;
    const child = captured.find((entry) => entry.recoveryChild)!.recoveryChild!;
    expect(engine.scope).toBeTruthy();
    expect(child.scope).toBe(engine.scope);
    expect(alive(engine.pid)).toBe(true);
    expect(alive(child.pid)).toBe(true);
    await writeFile(
      join(current.active.mountedWorkspacePath, "recovery-prior-pids.json"),
      JSON.stringify([engine.pid, child.pid]),
    );
    await current.active.crashRunner(async () => {
      expect(alive(engine.pid), "SIGKILL left the engine alive before startup reaping").toBe(true);
      expect(alive(child.pid), "SIGKILL left the marked child alive").toBe(true);
      checkpoints.push({
        stage: "abandoned without close",
        engine,
        child,
        alive: [alive(engine.pid), alive(child.pid)],
      });
    });
    expect(alive(engine.pid), "startup reaped the abandoned engine").toBe(false);
    expect(alive(child.pid), "startup reaped the abandoned child").toBe(false);
    checkpoints.push({
      stage: "replacement boot ready",
      oldPidsDead: [!alive(engine.pid), !alive(child.pid)],
    });
    const message = await recovery(current, runId);
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "recovery engine first event",
    );
    expect(alive(engine.pid)).toBe(false);
    expect(alive(child.pid)).toBe(false);
    const newTurn = (await current.captures())
      .filter((entry) => entry.recoveryTurn)
      .at(-1)!.recoveryTurn!;
    expect(newTurn.pid).not.toBe(engine.pid);
    expect(
      newTurn.priorPidsAlive,
      "old processes must be gone before the new engine first event",
    ).toEqual([false, false]);
    expect(textOf(message.content)).toContain("Started, completion unknown:");
    checkpoints.push({
      abandoned: { engine, child },
      recovered: newTurn,
      oldPidsDead: [!alive(engine.pid), !alive(child.pid)],
    });
    await finish(current, runId);
  }, 180_000);

  it("20. recovers a watchdog lease-lost interruption after a Host outage", async () => {
    const current = await start({ leaseMs: 12_000, contained: false });
    const { runId } = await held(current);
    await current.active.restartHost({
      whileDown: async () => {
        await advanceExecutionClock(current.clock!, current.active.host, 27_000);
        await waitFor(
          async () => current.active.settledRunEvent(runId)?.type === "run.interrupted",
          "watchdog terminal journal settled while Host is down",
        );
        expect(current.active.settledRunEvent(runId)).toMatchObject({
          type: "run.interrupted",
          data: { cause: "lease-lost" },
        });
        checkpoints.push({
          stage: "watchdog settled before Host restart",
          domainNow: current.clock!.now(),
          outcome: current.active.settledRunEvent(runId),
        });
      },
    });
    await waitFor(
      async () =>
        terminal.includes((await row(current.active, runId)).status) ||
        (await attempts(current.active, runId)).length === 2,
      "watchdog journal replay",
    );
    const leaseLost = current.active
      .wire!.frames.filter(
        ({ direction, frame }) => direction === "runner" && frame.type === "runner.event",
      )
      .map(({ frame }) => recordSchema.parse(frame.event))
      .find((event) => event.type === "run.interrupted");
    expect(
      leaseLost,
      "Runner watchdog must classify the interruption on its public wire",
    ).toMatchObject({ data: { cause: "lease-lost" } });
    await recovery(current, runId);
    await finish(current, runId);
  }, 120_000);

  it("21. reuses one unconfirmed recovery message through another loss and delivers originals once", async () => {
    let holdStarts = true;
    const current = await start({
      filter: (direction, frame) =>
        !(holdStarts && direction === "runner" && frame.type === "runner.event"),
    });
    const original = await queue(current, "Keep this quoted original attached to the same task.");
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 1,
      "first turn accepted",
    );
    expect((await row(current.active, original.runId)).startedAt).toBeNull();
    expect(await inputState(current.active, original.messageId)).toMatchObject({
      state: "claimed",
      deliveredAt: null,
    });
    await current.active.restartRunner();
    const firstRecovery = await recovery(current, original.runId);
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 2,
      "unconfirmed recovery dispatched",
    );
    expect((await attempts(current.active, original.runId))[1]).toMatchObject({
      reason: "recovery",
      startedAt: null,
    });
    expect(await inputState(current.active, firstRecovery.id)).toMatchObject({
      state: "claimed",
      deliveredAt: null,
    });
    expect(textOf(firstRecovery.content)).toContain(
      "Keep this quoted original attached to the same task.",
    );
    checkpoints.push({
      stage: "first recovery unconfirmed",
      snapshot: await snapshot(current.active, original.runId),
    });
    await current.active.restartRunner();
    await waitFor(
      async () =>
        (await attempts(current.active, original.runId)).length === 3 ||
        terminal.includes((await row(current.active, original.runId)).status),
      "third attempt exists",
    );
    expect((await row(current.active, original.runId)).failure).toBeNull();
    expect(await attempts(current.active, original.runId)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "interrupted" },
      { ordinal: 2, reason: "recovery", outcome: "interrupted", startedAt: null },
      { ordinal: 3, reason: "recovery", startedAt: null },
    ]);
    const reused = await recoveryMessages(current.active, current.threadId);
    expect(reused).toHaveLength(1);
    expect(reused[0]!.id).toBe(firstRecovery.id);
    expect(await inputState(current.active, firstRecovery.id)).toMatchObject({
      state: "claimed",
      deliveredAt: null,
    });
    expect(await inputState(current.active, original.messageId)).toMatchObject({
      state: "claimed",
      deliveredAt: null,
    });
    await waitFor(
      async () => (await current.captures()).filter((entry) => entry.recoveryTurn).length === 3,
      "third native turn accepted",
    );
    const dispatches = executeFrames(current.active);
    expect(dispatches).toHaveLength(3);
    for (const dispatch of dispatches) expect(dispatch.inputs).toHaveLength(1);
    expect(dispatches[0]!.inputs).toMatchObject([{ messageId: original.messageId }]);
    for (const dispatch of dispatches.slice(1))
      expect(dispatch.inputs).toMatchObject([{ messageId: firstRecovery.id }]);
    checkpoints.push({
      stage: "same claimed recovery message reused",
      snapshot: await snapshot(current.active, original.runId),
    });
    // The final boot still has its start in its journal. Reattach replays that receipt.
    holdStarts = false;
    current.active.network.drop();
    await waitFor(
      async () => (await attempts(current.active, original.runId))[2]?.startedAt !== null,
      "final start committed",
    );
    for (const messageId of [original.messageId, firstRecovery.id]) {
      expect(await inputState(current.active, messageId)).toMatchObject({
        state: "delivered",
        cancelReason: null,
      });
      const delivered = (await eventsOf(current.active, original.runId)).filter((event) => {
        if (event.type !== "thread-input.updated") return false;
        const input = recordSchema.parse(recordSchema.parse(event.data).input);
        return input.messageId === messageId && input.state === "delivered";
      });
      expect(delivered).toHaveLength(1);
    }
    await finish(current, original.runId);
    expect(await attempts(current.active, original.runId)).toHaveLength(3);
    expect(await recoveryMessages(current.active, current.threadId)).toHaveLength(1);
    expect(executeFrames(current.active)).toHaveLength(3);
  }, 180_000);

  it("22. clears a retired binding's revocation before dispatching recovery on the same connection", async () => {
    let lostRunId: RunId | undefined;
    let retiredGeneration: number | undefined;
    let withholdLease = false;
    let suppressedHeartbeat: string | undefined;
    const current = await start({
      leaseMs: 12_000,
      filter: (direction, frame) => {
        if (direction !== "runner" || !withholdLease) return true;
        if (frame.type === "runner.heartbeat") {
          if (z.array(z.string()).parse(frame.activeRunIds).includes(lostRunId!))
            suppressedHeartbeat = z.string().parse(frame.sentAt);
          // Keep the connection alive, but lose this execution's lease renewals.
          frame.activeRunIds = z
            .array(z.string())
            .parse(frame.activeRunIds)
            .filter((id) => id !== lostRunId);
        }
        if (frame.type === "runner.event") {
          const event = eventSchema.parse(frame.event);
          // The watchdog's delayed terminal receipt must not classify the loss.
          if (event.runId === lostRunId && event.bindingGeneration === retiredGeneration)
            return false;
        }
        return true;
      },
    });
    const { runId } = await held(current);
    const wire = current.active.wire!;
    const original = wire.frames.find(({ frame }) => frame.type === "runner.event")!.frame;
    const bound = wire.frames.find(({ frame }) => frame.type === "runner.session-bound")!.frame;
    const fence = {
      runnerId: original.runnerId,
      bootId: original.bootId,
      connectionId: original.connectionId,
      connectionGeneration: original.connectionGeneration,
      connectionLeaseId: original.connectionLeaseId,
    };
    lostRunId = runId;
    retiredGeneration = eventSchema.parse(original.event).bindingGeneration;
    const releaseDispatch = Promise.withResolvers<void>();
    let dispatchWaiting = false;
    const store = current.active.host.store;
    const load = store.loadRunDispatchContext.bind(store);
    const gate = vi.spyOn(store, "loadRunDispatchContext").mockImplementation(async (...args) => {
      const command = await store.database
        .selectFrom("commands")
        .select(["runId", "idempotencyKey"])
        .where("id", "=", args[0])
        .executeTakeFirstOrThrow();
      if (command.runId === runId && command.idempotencyKey.startsWith("recovery:")) {
        // Gate before the registry changes its owned binding, not just delivery
        // of host.command after that ownership has already advanced.
        dispatchWaiting = true;
        await releaseDispatch.promise;
      }
      return load(...args);
    });
    try {
      withholdLease = true;
      await waitFor(
        async () => suppressedHeartbeat !== undefined,
        "live heartbeat selectively withheld the execution",
      );
      // Empty execution renewals have no reply. A later correlated read on
      // this serial wire proves the Host finished processing that heartbeat.
      const heartbeatBarrier = randomUUID();
      wire.sendRunner({
        ...fence,
        type: "runner.grants.refresh",
        runId,
        requestId: heartbeatBarrier,
      });
      await waitFor(
        async () =>
          wire.frames.some(
            ({ direction, frame }) =>
              direction === "host" &&
              frame.type === "host.grants.credentials" &&
              frame.requestId === heartbeatBarrier,
          ),
        "Host processed the selectively withheld heartbeat",
      );
      await advanceExecutionClock(current.clock!, current.active.host, 17_000);
      checkpoints.push({
        stage: "live connection execution expired",
        domainNow: current.clock!.now(),
        suppressedHeartbeat,
        heartbeatBarrier,
      });
      await recovery(current, runId);
      await waitFor(
        async () => dispatchWaiting,
        "recovery dispatch held before registry admission",
      );
      expect(await row(current.active, runId)).toMatchObject({ status: "starting" });
      expect((await attempts(current.active, runId))[1]).toMatchObject({
        reason: "recovery",
        dispatchedAt: null,
        startedAt: null,
      });
      expect(executeFrames(current.active)).toHaveLength(1);
      const before = await snapshot(current.active, runId);
      await waitFor(
        async () =>
          wire.frames.some(({ frame }) => {
            if (frame.type !== "runner.event") return false;
            const event = eventSchema.parse(frame.event);
            return (
              event.runId === runId &&
              event.bindingGeneration === retiredGeneration &&
              event.type === "run.interrupted"
            );
          }),
        "retired watchdog receipt withheld from the expiry sweep",
      );
      const delayed = wire.frames.findLast(({ frame }) => {
        if (frame.type !== "runner.event") return false;
        const event = eventSchema.parse(frame.event);
        return (
          event.runId === runId &&
          event.bindingGeneration === retiredGeneration &&
          event.type === "run.interrupted"
        );
      })!.frame;
      expect(recordSchema.parse(delayed.event).data).toMatchObject({ cause: "lease-lost" });
      const replayStart = wire.frames.length;
      wire.sendRunner(delayed);
      wire.sendRunner(bound);
      // A correlated read on the same serial wire proves both stale reports
      // were handled, whether they were dropped or refused with a revocation.
      const requestId = randomUUID();
      wire.sendRunner({ ...fence, type: "runner.grants.refresh", runId, requestId });
      await waitFor(
        async () =>
          wire.frames.some(
            ({ frame }) =>
              frame.type === "host.grants.credentials" && frame.requestId === requestId,
          ),
        "stale reports processed before successor dispatch",
      );
      const after = await snapshot(current.active, runId);
      expect(after.events).toEqual(before.events);
      expect(after.run.nextRunnerOrdinal).toBe(before.run.nextRunnerOrdinal);
      expect(after.run.status).toBe("starting");
      expect(after.attempts).toHaveLength(2);
      expect(executeFrames(current.active)).toHaveLength(1);
      expect(
        wire.frames.slice(replayStart).filter(({ frame }) => frame.type === "host.error"),
      ).toEqual([]);
      checkpoints.push({
        stage: "retired reports processed before dispatch",
        fence,
        before,
        after,
        responses: wire.frames
          .slice(replayStart)
          .filter(({ frame }) => ["host.runs.revoked", "host.events.acked"].includes(frame.type)),
      });
    } finally {
      withholdLease = false;
      releaseDispatch.resolve();
      gate.mockRestore();
    }
    await waitFor(
      async () => (await attempts(current.active, runId))[1]!.startedAt !== null,
      "successor starts on the original connection",
    );
    const dispatches = wire.frames.filter(
      ({ frame }) =>
        frame.type === "host.command" && recordSchema.parse(frame.command).type === "run.execute",
    );
    expect(dispatches).toHaveLength(2);
    for (const { frame } of dispatches) expect(frame).toMatchObject(fence);
    const successorGeneration = z
      .number()
      .parse(executeFrames(current.active)[1]!.context.bindingGeneration);
    expect(successorGeneration).not.toBe(retiredGeneration);
    const replayStart = wire.frames.length;
    wire.sendRunner({ ...bound });
    sendStale(current.active, original, {
      ...eventSchema.parse(original.event),
      ordinal: (await row(current.active, runId)).nextRunnerOrdinal,
      type: "run.interrupted",
      data: { status: "interrupted", cause: "lease-lost" },
    });
    await confirmHealthyBindingAfterReplay(current.active, runId, replayStart);
    await finish(current, runId);
    expect(await attempts(current.active, runId)).toHaveLength(2);
    expect(await recoveryMessages(current.active, current.threadId)).toHaveLength(1);
    expect(executeFrames(current.active)).toHaveLength(2);
    expect(wire.frames.filter(({ frame }) => frame.type === "host.welcome")).toHaveLength(1);
    const reports = wire.frames.flatMap(({ direction, frame }) => {
      if (direction !== "runner" || frame.type !== "runner.event") return [];
      const event = eventSchema.parse(frame.event);
      if (event.runId !== runId || event.bindingGeneration !== successorGeneration) return [];
      expect(frame).toMatchObject(fence);
      return [{ runnerOrdinal: event.ordinal, type: event.type, data: event.data }];
    });
    const emitted = [...new Map(reports.map((event) => [event.runnerOrdinal, event])).values()];
    expect(emitted.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.message",
      "run.completed",
    ]);
    const stored = await store.database
      .selectFrom("workspaceEvents")
      .select(["runnerOrdinal", "type", "data"])
      .where("runId", "=", runId)
      .where("runnerBindingGeneration", "=", successorGeneration)
      .orderBy("runnerOrdinal", "asc")
      .execute();
    const seed = await store.database
      .selectFrom("runs")
      .innerJoin("messages", "messages.id", "runs.seedInputId")
      .select("messages.author")
      .where("runs.id", "=", runId)
      .executeTakeFirstOrThrow();
    const assistant = stored.find((event) => event.type === "assistant.message")!;
    expect(recordSchema.parse(assistant.data).content).toEqual([
      { type: "text", text: "Recovery task completed." },
    ]);
    expect(
      stored.map((event) => {
        if (event.type !== "run.completed") return event;
        const { replyMessageId, ...data } = recordSchema.parse(event.data);
        expect(replyMessageId).toBe(recordSchema.parse(assistant.data).messageId);
        return { ...event, data };
      }),
    ).toEqual(
      emitted.map((event) =>
        event.type === "run.started" || event.type === "run.completed"
          ? { ...event, data: { ...recordSchema.parse(event.data), startedBy: seed.author } }
          : event,
      ),
    );
    checkpoints.push({
      stage: "same connection successor completed",
      fence,
      successorGeneration,
      emitted,
      stored,
    });
  }, 120_000);
});

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function row(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}
async function attempts(active: VerticalStack, runId: RunId) {
  const result = await active.api["run.attempts.list"]({ runId });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.attempts;
}
async function messagesOf(active: VerticalStack, threadId: ThreadId) {
  const result = await active.api["thread.messages.list"]({ threadId, limit: 100 });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.messages;
}
// Read stored rows: history lists a queued input only once a start delivers it.
async function recoveryMessages(active: VerticalStack, threadId: ThreadId) {
  return (
    await active.host.store.database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", threadId)
      .orderBy("sequence", "asc")
      .execute()
  ).filter((message) => recordSchema.parse(message.author).cause === "run-recovery");
}
function eventsOf(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("workspaceEvents")
    .select(["eventId", "type", "data", "runnerOrdinal", "runnerBootId", "sequence"])
    .where("runId", "=", runId)
    .orderBy("sequence", "asc")
    .execute();
}
function inputState(active: VerticalStack, messageId: MessageId) {
  return active.host.store.database
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", messageId)
    .executeTakeFirstOrThrow();
}
async function failedNotifications(active: VerticalStack, runId: RunId) {
  const rows = await active.host.store.database
    .selectFrom("workspaceEvents")
    .selectAll()
    .where("runId", "=", runId)
    .where("type", "in", ["run.failed", "run.interrupted"])
    .execute();
  const notifications = new NotificationStore(active.host.store.database);
  const decided = (
    await Promise.all(
      rows.map((row) =>
        notifications.decide(
          AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() }),
        ),
      ),
    )
  )
    .flat()
    .map(({ view }) => view);
  return [
    ...decided,
    ...active.notifications.filter((entry) => entry.runId === runId && entry.kind === "run-failed"),
  ];
}
function requestRow(active: VerticalStack, id: string) {
  return active.host.store.database
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", id as never)
    .executeTakeFirstOrThrow();
}
async function pendingApproval(active: VerticalStack, runId: RunId, except?: string) {
  let request: Awaited<ReturnType<typeof requestRow>> | undefined;
  await waitFor(async () => {
    request = await active.host.store.database
      .selectFrom("requests")
      .selectAll()
      .where("originatingRunId", "=", runId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Boolean(request && request.id !== except);
  }, "pending approval");
  return request!;
}
async function answer(active: VerticalStack, request: Awaited<ReturnType<typeof requestRow>>) {
  const presentation = request.presentation;
  if (presentation.kind !== "choice") throw new Error("Request is not an approval");
  const option = presentation.options.find((entry) => entry.hint !== "reject-once");
  if (!option) throw new Error("Approval has no allow option");
  const result = await active.api["commands.dispatch"]({
    type: "request.respond",
    idempotencyKey: randomUUID(),
    requestId: request.id,
    response: { kind: "choice", optionId: option.id },
  });
  if (!result.ok) throw new Error(result.error.message);
  if (option.hint === "allow-once") return "accept";
  if (option.hint === "allow-for-run") return "acceptForSession";
  throw new Error(`Approval option ${option.id} has no mapped Codex allow decision`);
}
function executeFrames(active: VerticalStack) {
  return active.wire!.frames.flatMap(({ direction, frame }) => {
    if (direction !== "host" || frame.type !== "host.command") return [];
    const command = recordSchema.parse(frame.command);
    return command.type === "run.execute"
      ? [z.object({ context: recordSchema }).passthrough().parse(command)]
      : [];
  });
}
function sendStale(active: VerticalStack, original: WireRecord, event: unknown): void {
  const latest = active.wire!.frames.findLast(
    ({ direction, frame }) => direction === "runner" && frame.connectionLeaseId,
  )?.frame;
  if (!latest) throw new Error("No current connection fence");
  active.wire!.sendRunner({
    ...original,
    bootId: latest.bootId,
    connectionId: latest.connectionId,
    connectionGeneration: latest.connectionGeneration,
    connectionLeaseId: latest.connectionLeaseId,
    event,
  });
}
async function snapshot(active: VerticalStack, runId: RunId) {
  const run = await row(active, runId);
  const thread = await active.host.store.database
    .selectFrom("threads")
    .select(["id", "workspaceId", "status", "inputQueuePaused"])
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  return {
    run,
    thread,
    storedMessages: await active.host.store.database
      .selectFrom("messages")
      .selectAll()
      .where("runId", "=", runId)
      .orderBy("sequence", "asc")
      .execute(),
    attempts: await attempts(active, runId),
    storedAttempts: await active.host.store.database
      .selectFrom("runAttempts")
      .selectAll()
      .where("runId", "=", runId)
      .orderBy("ordinal", "asc")
      .execute(),
    binding: run.providerSessionId
      ? await active.host.store.database
          .selectFrom("providerSessions")
          .select([
            "id",
            "bindingGeneration",
            "runnerId",
            "runnerBootId",
            "leaseExpiresAt",
            "status",
            "providerSessionReference",
          ])
          .where("id", "=", run.providerSessionId)
          .executeTakeFirst()
      : null,
    events: await eventsOf(active, runId),
    inputs: await active.host.store.database
      .selectFrom("threadInputs")
      .selectAll()
      .where("runId", "=", runId)
      .execute(),
    messages: await messagesOf(active, run.threadId),
    notifications: active.notifications.filter((entry) => entry.runId === runId),
    assignments: await active.api["thread.assignments.list"]({ threadId: run.threadId }),
    commands: await active.host.store.database
      .selectFrom("commands")
      .select(["id", "type", "status", "lastError", "idempotencyKey"])
      .where("runId", "=", runId)
      .execute(),
    requests: await active.host.store.database
      .selectFrom("requests")
      .selectAll()
      .where("originatingRunId", "=", runId)
      .execute(),
    grants: await active.host.store.database
      .selectFrom("grants")
      .select(["id", "attemptId", "bindingGeneration", "runnerId", "runnerBootId", "revokedReason"])
      .where("runId", "=", runId)
      .execute(),
  };
}
function textOf(content: unknown): string {
  return z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .parse(content)
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("\n");
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settledTriggerDispatches(active: VerticalStack) {
  await waitFor(
    async () =>
      (
        await active.host.store.database
          .selectFrom("commands")
          .select("id")
          .where("type", "=", "trigger.execute")
          .where("status", "in", ["pending", "dispatched"])
          .execute()
      ).length === 0,
    "Trigger execute commands acknowledged",
  );
}

/** Codex sends passive context parts alongside the one envelope per actionable Thread input. */
function nativeMessageInputs(input: readonly unknown[]): string[] {
  return z
    .array(z.object({ text: z.string().optional(), type: z.string() }).passthrough())
    .parse(input)
    .flatMap((part) =>
      part.type === "text" && part.text?.startsWith("[Opensteer input]") ? [part.text] : [],
    );
}

async function expectDeadlineSettled(active: VerticalStack, runId: RunId, threadId: ThreadId) {
  const inputs = await active.host.store.database
    .selectFrom("threadInputs")
    .select(["messageId", "state", "cancelReason"])
    .where("runId", "=", runId)
    .execute();
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) expect(["delivered", "cancelled"]).toContain(input.state);
  const thread = await active.host.store.database
    .selectFrom("threads")
    .select(["workspaceId", "inputQueuePaused"])
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  expect(thread.inputQueuePaused).toBe(false);
  const ended = (await eventsOf(active, runId)).filter((event) => event.type === "run.interrupted");
  expect(ended).toHaveLength(1);
  expect(await failedNotifications(active, runId)).toEqual([]);
  expect(
    (await messagesOf(active, threadId)).filter(
      (message) => recordSchema.parse(message.author).cause === "run-recovery",
    ),
  ).toEqual([]);
}

/** A later correlated renewal proves the same connection still holds the healthy successor. */
async function confirmHealthyBindingAfterReplay(
  active: VerticalStack,
  runId: RunId,
  after: number,
) {
  const wire = active.wire!;
  const latest = wire.frames.findLast(
    ({ direction, frame }) => direction === "runner" && frame.connectionLeaseId,
  )?.frame;
  if (!latest) throw new Error("No current Runner connection fence");
  const fenceSchema = RunnerConnectionFenceSchema.passthrough();
  const fence = fenceSchema.parse(latest);
  const afterReplay = wire.frames.length;
  // The Runner owns monotonic heartbeat timestamps. Wall-clock timestamps
  // synthesized here can go backward after execution time advances.
  const heartbeat = () =>
    wire.frames
      .slice(afterReplay)
      .find(
        ({ direction, frame }) =>
          direction === "runner" &&
          frame.type === "runner.heartbeat" &&
          sameRunnerConnectionFence(fenceSchema.parse(frame), fence) &&
          z.array(z.string()).parse(frame.activeRunIds).includes(runId),
      )?.frame;
  const revokesRun = (frame: WireRecord) =>
    frame.type === "host.runs.revoked" &&
    z
      .array(z.object({ runId: z.string() }))
      .parse(frame.revocations)
      .some((entry) => entry.runId === runId);
  const renewed = (frame: WireRecord) => {
    const sentAt = heartbeat()?.sentAt;
    return (
      typeof sentAt === "string" &&
      frame.type === "host.executions.renewed" &&
      sameRunnerConnectionFence(fenceSchema.parse(frame), fence) &&
      frame.heartbeatSentAt === sentAt
    );
  };
  await waitFor(
    async () =>
      wire.frames
        .slice(after)
        .some(
          ({ direction, frame }) =>
            direction === "host" &&
            (renewed(frame) || revokesRun(frame) || frame.type === "host.error"),
        ),
    "healthy binding renewal after retired event replay",
  );
  const responses = wire.frames
    .slice(after)
    .filter(({ direction }) => direction === "host")
    .map(({ frame }) => frame);
  expect(responses.filter(revokesRun)).toEqual([]);
  expect(responses.filter((frame) => frame.type === "host.error")).toEqual([]);
  const confirmation = responses.find(renewed);
  expect(confirmation).toBeDefined();
  expect(confirmation!.runIds).toContain(runId);
}
