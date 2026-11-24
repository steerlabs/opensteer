import { withTimeout } from "@opensteer/shared/withTimeout";
import { jsonValue } from "./store-primitives.js";
import { personalFixtureOwner } from "./personal-run-fixture.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";

import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  ThreadAccessModeSchema,
  createId,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, describe, expect, it as baseIt, vi } from "vitest";
import "./connection.js";
import {
  ShellSessionIdSchema,
  type RunnerAuxiliaryFrameFence,
  type ShellSessionId,
} from "@opensteer/protocol";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { connectionAttempts } from "./connection-disconnect.js";
import { createDatabase, OpensteerStore } from "./index.js";
import { NotificationStore } from "./notification-store.js";
import { revokeRunGrants } from "./run-grants.js";
import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import { readTranscriptOverlays } from "./personal-overlay-store.js";

/**
 * Stage 1 fault matrix, database side: every way a Stop, an answer, a steer or
 * a lease could slip past the authority that ended. Each scenario records its
 * outcome in `fault-matrix-database.json`.
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;
const matrix: Record<string, unknown> = {};
integration.sequential("Run stop fencing", () => {
  async function createTestFixture() {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-run-stop-fencing-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return {
        database,
        close: () => database.destroy(),
      };
    });
    const store = new OpensteerStore(database);
    async function runStatus(runId: RunId): Promise<string | undefined> {
      return (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst()
      )?.status;
    }
    async function requestStatus(requestId: RequestId): Promise<string | undefined> {
      return (
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", requestId)
          .executeTakeFirst()
      )?.status;
    }
    async function commandStatus(
      runId: RunId,
      type: "run.execute" | "run.interrupt",
    ): Promise<string | undefined> {
      return (
        await database
          .selectFrom("commands")
          .select("status")
          .where("runId", "=", runId)
          .where("type", "=", type)
          .executeTakeFirst()
      )?.status;
    }
    async function executeCommand(runId: RunId) {
      return (
        await database
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", runId)
          .where("type", "=", "run.execute")
          .executeTakeFirstOrThrow()
      ).id;
    }
    async function claim(f: Fixture, suffix: string) {
      const sent = await store.enqueueThreadInput({
        content: [
          {
            text: `Work ${suffix}`,
            type: "text",
          },
        ],
        idempotencyKey: `send-${suffix}`,
        policy: "queue",
        requestedBy: f.userId,
        source: {
          kind: "human",
        },
        threadId: f.thread.id,
      });
      if (!sent.command || !sent.run) throw new Error("Expected a queued Run");
      await store.claimCommand(sent.command.id, `${suffix}-dispatcher`);
      return sent.run;
    }
    function bind(
      f: Fixture,
      runId: Parameters<OpensteerStore["acquireExecutionBinding"]>[0]["runId"],
    ) {
      return store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: f.harness.id,
        leaseTokenHash: `lease-${runId}`,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        runId,
        threadId: f.thread.id,
      });
    }
    async function running(f: Fixture, suffix: string) {
      const run = await claim(f, suffix);
      const binding = await bind(f, run.id);
      f.bindingGeneration = binding.bindingGeneration;
      f.ordinal = 0;
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: {
            status: "running",
          },
          environmentId: f.environmentId,
          ordinal: f.ordinal++,
          runId: run.id,
          threadId: f.thread.id,
          type: "run.started",
        }),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
      return run;
    }
    async function openRequest(
      f: Fixture,
      run: {
        readonly id: RunId;
      },
      index: number,
      createdAt = new Date().toISOString(),
    ) {
      const request = PendingRequestSchema.parse({
        callId: `call-${index}`,
        cancellationReason: null,
        createdAt,
        id: createId("request"),
        kind: "harness.approval",
        mode: "live",
        originatingOccurrenceId: null,
        originatingRunId: run.id,
        originatingThreadId: f.thread.id,
        payload: {
          kind: "harness.approval",
        },
        presentation: {
          detail: "Confirm",
          kind: "choice",
          options: [
            {
              hint: "confirm",
              id: "yes",
              label: "Yes",
            },
          ],
          title: "Continue?",
        },
        requestedBy: f.userId,
        requiredActor: "requester",
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
      });
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          data: {
            request,
          },
          environmentId: f.environmentId,
          ordinal: f.ordinal++,
          runId: run.id,
          threadId: f.thread.id,
          type: "request.opened",
        }),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
      return request;
    }
    async function answer(f: Fixture, runId: RunId, requestId: RequestId, key: string) {
      return store.enqueueRunnerControl({
        idempotencyKey: `answer-${key}`,
        requestId,
        requestedBy: f.userId,
        response: {
          kind: "choice",
          optionId: "yes",
        },
        runId,
        sealedResponse: {
          envelope: Buffer.from("encrypted-test-response"),
          keyVersion: 1,
          requestFingerprint: `hmac-sha256-v1:1:${key}`,
        },
        threadId: f.thread.id,
        expectedRevision: (await store.requests.revision(requestId))!,
        type: "request.respond",
      });
    }
    function stop(f: Fixture, runId: RunId, key: string) {
      return store.enqueueRunnerControl({
        idempotencyKey: `stop-${key}`,
        requestedBy: f.userId,
        runId,
        threadId: f.thread.id,
        type: "run.interrupt",
      });
    }
    function resume(f: Fixture, key: string) {
      return store.resumeThreadInputQueue({
        idempotencyKey: `resume-${key}`,
        requestedBy: f.userId,
        threadId: f.thread.id,
      });
    }
    async function fixture(suffix: string) {
      const personal = await personalFixtureOwner(database, databaseUrl);
      const { userId, runnerId, environmentId } = personal;
      await enrollRunner({ environmentId, runnerId, suffix, userId: userId });
      const harness = await store.createHarnessInstance({
        config: {
          model: "test",
        },
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native",
        stateKind: "isolated",
      });
      await store.recordHarnessCatalogs({
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity,
            driverKind: "native",
            harnessInstanceId: harness.id,
            models: [
              {
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                modelId: modelSelection.modelId,
                options: [],
                providerId: modelSelection.providerId,
              },
            ],
            status: "ready",
          }),
        ],
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
      const { thread } = await store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Thread ${suffix}`,
      });
      return {
        bindingGeneration: 0,
        environmentId,
        harness,
        ordinal: 0,
        runnerBootId: `boot-${suffix}`,
        runnerId,
        thread,
        userId,
      };
    }
    async function enrollRunner(input: {
      environmentId: EnvironmentId;
      runnerId: RunnerId;
      suffix: string;
      userId: UserId;
    }) {
      const descriptor: RunnerDescriptor = {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: ["filesystem"],
        name: "Main runner",
        runnerId: input.runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
        modules: {
          agents: {
            environmentIds: [input.environmentId],
            harnessDrivers: [
              {
                accessModes: ThreadAccessModeSchema.options,
                driverKind: HarnessIdSchema.parse("native"),
                readiness: "configured",
                sources: [
                  {
                    fields: [],
                    kind: "first-party",
                    label: "Native",
                    quota: "none",
                    sourceId: "native",
                    stateKinds: ["isolated"],
                  },
                ],
              },
            ],

            maxConcurrentRuns: 4,
          },
        },
      };
      await database
        .updateTable("runners")
        .set({
          capabilities: jsonValue(descriptor.capabilities),
          moduleDescriptors: descriptor.modules,
        })
        .where("id", "=", input.runnerId)
        .execute();
    }
    return Object.freeze({
      database,
      store,
      runStatus,
      requestStatus,
      commandStatus,
      executeCommand,
      claim,
      bind,
      running,
      openRequest,
      answer,
      stop,
      resume,
      fixture,
      enrollRunner,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{
    storeFixture: StoreFixture;
  }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });
  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-fault-matrix-"));
    const artifact = join(directory, "fault-matrix-database.json");
    await writeFile(artifact, `${JSON.stringify(matrix, null, 2)}\n`);
    console.info(`Database fault matrix: ${artifact}`);
  });
  it("ends a Run stopped before it was bound, and the Thread's next Run starts", async ({
    storeFixture,
  }) => {
    const { fixture, claim, stop, runStatus, bind, commandStatus, resume, store } = storeFixture;
    const f = await fixture("unbound");
    const run = await claim(f, "unbound");
    const stopped = await stop(f, run.id, "unbound");
    expect(await runStatus(run.id)).toBe("interrupted");
    // The person stopped it, so its end is no news to them.
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.latestRunCompletedAt).toBeNull();
    expect(stopped.command.status).toBe("succeeded");
    await expect(bind(f, run.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await commandStatus(run.id, "run.execute")).toBe("failed");
    await resume(f, "unbound");
    const next = await claim(f, "unbound-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({
      bindingGeneration: 1,
    });
    matrix["stop-before-binding"] = {
      nextRunBinds: true,
      runStatus: "interrupted",
      runnerReceivedExecute: false,
    };
  });
  it("ends a stopped Run its Runner never held instead of queueing it again", async ({
    storeFixture,
  }) => {
    const { fixture, claim, bind, stop, runStatus, store, resume } = storeFixture;
    const f = await fixture("unheld");
    const run = await claim(f, "unheld");
    await bind(f, run.id);
    await stop(f, run.id, "unheld");
    expect(await runStatus(run.id)).toBe("starting");

    // The same Runner boot reattaches holding nothing: it never received the Run.
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(await runStatus(run.id)).toBe("interrupted");
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.latestRunCompletedAt).toBeNull();
    await resume(f, "unheld");
    const next = await claim(f, "unheld-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({
      bindingGeneration: 2,
    });
    matrix["stop-then-runner-never-held"] = {
      requeued: false,
      runStatus: "interrupted",
    };
  });
  it("ends a stopped Run whose dispatch is retried instead of queueing it again", async ({
    storeFixture,
  }) => {
    const { fixture, claim, bind, stop, executeCommand, store, runStatus, resume } = storeFixture;
    const f = await fixture("retried");
    const run = await claim(f, "retried");
    await bind(f, run.id);
    await stop(f, run.id, "retried");
    const execute = await executeCommand(run.id);

    // The registry refuses an execute its Stop overtook before the send, and
    // retries it as unsent work.
    await store.retryCommand(execute, new Error("Run execution authority was revoked"));
    expect(await runStatus(run.id)).toBe("interrupted");
    await resume(f, "retried");
    const next = await claim(f, "retried-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({
      bindingGeneration: 2,
    });
    matrix["stop-then-dispatch-retry"] = {
      nextRunBinds: true,
      requeued: false,
      runStatus: "interrupted",
    };
  });
  it("cancels a stopped Run's questions, refuses new answers and never delivers an admitted one", async ({
    storeFixture,
  }) => {
    const { fixture, running, openRequest, answer, store, runStatus, stop, requestStatus } =
      storeFixture;
    const f = await fixture("answers");
    const run = await running(f, "answers");
    const asked = await openRequest(f, run, 1);
    const answeredFirst = await openRequest(f, run, 2);
    const admitted = await answer(f, run.id, answeredFirst.id, "admitted");
    await store.claimCommand(admitted.command.id, "answers-dispatcher");
    expect(await runStatus(run.id)).toBe("waiting");
    await stop(f, run.id, "answers");
    expect(await requestStatus(asked.id)).toBe("cancelled");
    expect(await requestStatus(answeredFirst.id)).toBe("cancelled");
    // Nothing is left to answer, so no one is shown a question that is gone.
    expect(await runStatus(run.id)).toBe("running");
    await expect(answer(f, run.id, asked.id, "late")).rejects.toMatchObject({
      code: "conflict",
    });
    let delivered = false;
    await expect(
      store.dispatchRequestResponse(admitted.command.id, async () => {
        delivered = true;
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(delivered).toBe(false);
    matrix["answers-after-stop"] = {
      admittedAnswerDelivered: false,
      lateAnswer: "refused",
      pendingRequests: "cancelled",
    };
  });
  it("refuses to enqueue a claimed answer when Stop commits during frame preparation", async ({
    storeFixture,
  }) => {
    const { fixture, running, openRequest, answer, store, stop } = storeFixture;
    const f = await fixture("prepare-answers");
    const run = await running(f, "prepare-answers");
    const request = await openRequest(f, run, 1);
    const admitted = await answer(f, run.id, request.id, "admitted");
    await store.claimCommand(admitted.command.id, "answers-dispatcher");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runnerResolves: string[] = [];
    const delivery = store.dispatchRequestResponse(admitted.command.id, async (_ack, fenceSend) => {
      entered.resolve();
      await withTimeout(release.promise, 2_000, {
        timeoutError: () => new Error("Request frame preparation was never released"),
      });
      await fenceSend(() => runnerResolves.push(request.id));
    });
    const refused = expect(delivery).rejects.toMatchObject({ code: "conflict" });
    try {
      await withTimeout(entered.promise, 2_000, {
        timeoutError: () => new Error("The Request dispatch intent did not commit"),
      });
      await stop(f, run.id, "while-preparing");
    } finally {
      release.resolve();
      await refused;
    }
    expect(runnerResolves).toEqual([]);
  });
  it("records an engine's question asked after Stop as cancelled, leaving the Run running", async ({
    storeFixture,
  }) => {
    const { fixture, running, stop, openRequest, requestStatus, runStatus } = storeFixture;
    const f = await fixture("late-ask");
    const run = await running(f, "late-ask");
    await stop(f, run.id, "late-ask");
    const late = await openRequest(f, run, 1);
    expect(await requestStatus(late.id)).toBe("cancelled");
    expect(await runStatus(run.id)).toBe("running");
    matrix["engine-asks-after-stop"] = {
      request: "cancelled",
      runStatus: "running",
    };
  });
  it("shows the settlement time of a one-hour wait across two history pages after Stop", async ({
    storeFixture,
  }) => {
    const { fixture, running, openRequest, stop, database } = storeFixture;
    const f = await fixture("one-hour-stop");
    const run = await running(f, "one-hour-stop");
    const read = { viewerId: f.userId, scope: { kind: "thread", threadId: f.thread.id } as const };
    const waitingSince = new Date(Date.now() - 60 * 60_000).toISOString();
    const request = await openRequest(f, run, 1, waitingSince);
    const before = await readTranscriptPage(database, { ...read, limit: 1 });
    if (before.kind !== "page") throw new Error("Expected history before Stop");
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.kind).not.toBe("request");
    await expect(
      readTranscriptOverlays(database, { ...read, kind: "requests" }),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: request.id, status: "pending" })],
    });

    await stop(f, run.id, "one-hour-stop");
    const newest = await readTranscriptPage(database, { ...read, limit: 1 });
    if (newest.kind !== "page" || !newest.nextBefore)
      throw new Error("Expected a second history page");
    const { resolvedAt } = await database
      .selectFrom("requests")
      .select("resolvedAt")
      .where("id", "=", request.id)
      .executeTakeFirstOrThrow();
    expect(resolvedAt!.getTime() - Date.parse(waitingSince)).toBeGreaterThanOrEqual(60 * 60_000);
    expect(newest.items).toEqual([
      expect.objectContaining({
        id: `request:${request.id}`,
        kind: "request",
        createdAt: resolvedAt!.toISOString(),
        waitedSince: waitingSince,
        view: { status: "cancelled", title: "Continue?", preview: "Cancelled · run-ended" },
      }),
    ]);
    const older = await readTranscriptPage(database, { ...read, cursor: newest.nextBefore });
    if (older.kind !== "page") throw new Error("Expected older history after Stop");
    expect(older.items.map(({ id }) => id)).toContain(before.items[0]?.id);
    expect(older.items.filter(({ kind }) => kind === "request")).toEqual([]);
    await expect(
      readTranscriptItem(database, { ...read, itemId: newest.items[0]!.id }),
    ).resolves.toMatchObject({ item: newest.items[0] });
    await expect(
      readTranscriptOverlays(database, { ...read, kind: "requests" }),
    ).resolves.toMatchObject({ entries: [] });
  });
  it("refuses a steer into a Run whose authority ended while it still runs", async ({
    storeFixture,
  }) => {
    const { fixture, running, store, database } = storeFixture;
    const f = await fixture("steer");
    const run = await running(f, "steer");
    const waiting = await store.enqueueThreadInput({
      content: [
        {
          text: "Also do this",
          type: "text",
        },
      ],
      idempotencyKey: "steer-waiting",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    // An Assignment cancel ends a worker's grant without pausing its queue.
    await withPersonalTransaction(database, (transaction) =>
      revokeRunGrants(transaction, [run.id], "assignment-cancelled"),
    );
    await expect(
      store.steerThreadInput({
        expectedRunId: run.id,
        idempotencyKey: "steer-attempt",
        messageId: waiting.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    matrix["steer-after-authority-ended"] = {
      steer: "refused",
    };
  });
  it("never renews a lease that already ran out, nor one the Run no longer holds", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("leases");
    const run = await running(f, "leases");
    await database
      .updateTable("providerSessions")
      .set({
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .execute();
    const renewed = await store.renewActiveExecutionBindings({
      activeRunIds: [run.id],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(renewed).toEqual([]);

    // A Host that was down heard nothing: its boot restarts the lease once.
    await store.restartExecutionLeases(new Date(Date.now() + 60_000));
    expect(
      await store.renewActiveExecutionBindings({
        activeRunIds: [run.id],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      }),
    ).toEqual([run.id]);

    // A binding the Run does not hold is never renewed in its name.
    await database
      .updateTable("runs")
      .set({
        bindingGeneration: f.bindingGeneration + 1,
      })
      .where("id", "=", run.id)
      .execute();
    expect(
      await store.renewActiveExecutionBindings({
        activeRunIds: [run.id],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      }),
    ).toEqual([]);
    matrix["lease-renewal"] = {
      expiredLeaseRenewed: false,
      restartedAfterHostBoot: true,
      supersededBindingRenewed: false,
    };
  });

  it("records engine-retired cause, leaves open tools stopped, and pauses queued work", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("engine-retired");
    const run = await running(f, "engine-retired");
    // Open a tool call in flight and enqueue a follow-up message behind this Run.
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          arguments: { command: "sleep 30" },
          callId: "call-inflight",
          tool: { name: "shell", namespace: "codex" },
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "tool.started",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    await store.enqueueThreadInput({
      content: [{ text: "Follow-up that must not run silently", type: "text" }],
      idempotencyKey: "engine-retired-followup",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    // The shared engine retired under another task's stop: this innocent neighbour
    // ends interrupted with cause "engine-retired".
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          cause: "engine-retired",
          status: "interrupted",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "run.interrupted",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const settledRun = await database
      .selectFrom("runs")
      .select(["status", "interruptedCause"])
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(settledRun).toEqual({ status: "interrupted", interruptedCause: "engine-retired" });
    // Rule 4: the in-flight tool call is interrupted/stopped, never failed or completed.
    const toolRow = await database
      .selectFrom("toolCalls")
      .select(["status", "isError"])
      .where("runId", "=", run.id)
      .where("callId", "=", "call-inflight")
      .executeTakeFirstOrThrow();
    expect(toolRow).toEqual({ status: "interrupted", isError: null });
    // Follow-ups are paused rather than silently starting a new Run.
    const threadRow = await database
      .selectFrom("threads")
      .select(["inputQueuePaused", "status"])
      .where("id", "=", f.thread.id)
      .executeTakeFirstOrThrow();
    expect(threadRow.inputQueuePaused).toBe(true);
    const allRuns = await database
      .selectFrom("runs")
      .select(["id", "status"])
      .where("threadId", "=", f.thread.id)
      .execute();
    expect(allRuns).toHaveLength(1);
    const page = await readTranscriptPage(database, {
      viewerId: f.userId,
      scope: { kind: "thread", threadId: f.thread.id },
    });
    expect(page.kind).toBe("page");
    if (page.kind === "page") {
      const runItem = page.items.find((item) => item.kind === "run" && item.runId === run.id);
      expect(runItem?.kind === "run" ? runItem.interruptedCause : undefined).toBe("engine-retired");
      const toolItem = page.items.find((item) => item.kind === "tool");
      expect(toolItem?.view.status).toBe("stopped");
    }
  });

  it("H5(b)+(c): holds next Run on previous-stop-unconfirmed without cycling Starting, records failureCode, and promotes unproven stop to interrupted with stopConfirmedAt on late proof", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("unproven-late-proof");
    const run1 = await running(f, "unproven-1");
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          code: "execution_termination_unproven",
          message:
            "Stopping could not be confirmed. Something from this Run may still be running on that device.",
          retryable: false,
          status: "failed",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run1.id,
        threadId: f.thread.id,
        type: "run.failed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const failedThread = await database
      .selectFrom("threads")
      .select(["status", "failureCode", "failurePreview"])
      .where("id", "=", f.thread.id)
      .executeTakeFirstOrThrow();
    expect(failedThread.status).toBe("failed");
    expect(failedThread.failureCode).toBe("execution_termination_unproven");

    // Enqueue a follow-up message; simulate Runner rejecting with previous-stop-unconfirmed.
    const nextSent = await store.enqueueThreadInput({
      content: [{ text: "Try again after stop", type: "text" }],
      idempotencyKey: "unproven-next-msg",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    expect(nextSent.command).not.toBeNull();
    expect(nextSent.run).not.toBeNull();
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    const heldError = Object.assign(new Error("Stopping could not be confirmed."), {
      cause: {
        code: "conflict",
        message: "Stopping could not be confirmed.",
        reason: "previous-stop-unconfirmed",
        retryable: true,
      },
    });
    await store.retryCommand(nextSent.command!.id, heldError);

    const heldRun = await database
      .selectFrom("runs")
      .select(["status", "startHoldReason"])
      .where("id", "=", nextSent.run!.id)
      .executeTakeFirstOrThrow();
    expect(heldRun).toEqual({
      status: "queued",
      startHoldReason: "previous-stop-unconfirmed",
    });
    // While held, listPendingCommands must NOT keep claiming and cycling Starting.
    const pendingWhileHeld = await store.listPendingCommands();
    expect(pendingWhileHeld.some((cmd) => cmd.id === nextSent.command!.id)).toBe(false);

    // Late proof arrives from the Runner: run.interrupted at Run 1's nextRunnerOrdinal.
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          status: "interrupted",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run1.id,
        threadId: f.thread.id,
        type: "run.interrupted",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const confirmedRun = await database
      .selectFrom("runs")
      .select(["status", "failure", "stopConfirmedAt"])
      .where("id", "=", run1.id)
      .executeTakeFirstOrThrow();
    expect(confirmedRun.status).toBe("interrupted");
    expect(confirmedRun.failure).toBeNull();
    expect(confirmedRun.stopConfirmedAt).not.toBeNull();

    // Thread clears failureCode and queued Run 2's hold lifts so it can dispatch!
    const liftedThread = await database
      .selectFrom("threads")
      .select(["failureCode", "failurePreview"])
      .where("id", "=", f.thread.id)
      .executeTakeFirstOrThrow();
    expect(liftedThread.failureCode).toBeNull();
    expect(liftedThread.failurePreview).toBeNull();

    const unheldRun = await database
      .selectFrom("runs")
      .select(["status", "startHoldReason"])
      .where("id", "=", nextSent.run!.id)
      .executeTakeFirstOrThrow();
    expect(unheldRun).toEqual({ status: "queued", startHoldReason: null });
    const pendingAfterLift = await store.listPendingCommands();
    expect(pendingAfterLift.some((cmd) => cmd.id === nextSent.command!.id)).toBe(true);

    // Transcript Run card reflects interrupted + stopConfirmedAt.
    const page = await readTranscriptPage(database, {
      viewerId: f.userId,
      scope: { kind: "thread", threadId: f.thread.id },
    });
    expect(page.kind).toBe("page");
    if (page.kind === "page") {
      const runItem = page.items.find((item) => item.kind === "run" && item.runId === run1.id);
      expect(runItem?.view.status).toBe("interrupted");
      expect(runItem?.kind === "run" ? runItem.stopConfirmedAt : undefined).toBeTruthy();
    }
  });

  it("S2+S3: keeps held Runs and refuses new follow-up Runs after a Runner restart with unknown earlier-boot reap", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("s3-reboot-unknown");
    const run1 = await running(f, "s3-unproven-1");
    await database
      .updateTable("providerSessions")
      .set({ providerSessionReference: "native-session-s3-unknown" })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          code: "execution_termination_unproven",
          message:
            "Stopping could not be confirmed. Something from this Run may still be running on that device.",
          retryable: false,
          status: "failed",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run1.id,
        threadId: f.thread.id,
        type: "run.failed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    // Queue Run 2 and mark it held on previous-stop-unconfirmed.
    const nextSent = await store.enqueueThreadInput({
      content: [{ text: "Follow up while held", type: "text" }],
      idempotencyKey: "s3-follow-up-1",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    const heldError = Object.assign(new Error("Stopping could not be confirmed."), {
      cause: {
        code: "conflict",
        message: "Stopping could not be confirmed.",
        reason: "previous-stop-unconfirmed",
        retryable: true,
      },
    });
    await store.retryCommand(nextSent.command!.id, heldError);

    // Runner restarts on the same machine as boot B2 with earlier-boot reap UNKNOWN
    // (capabilities omits earlier-boots-contained-v1).
    const boot2 = `rbt_${randomUUID()}` as RunnerDescriptor["bootId"];
    await database
      .updateTable("runners")
      .set({ capabilities: jsonValue([]) })
      .where("id", "=", f.runnerId)
      .execute();
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: boot2,
      runnerId: f.runnerId,
    });

    // Run 2 MUST remain held on previous-stop-unconfirmed.
    const heldAfterRestart = await database
      .selectFrom("runs")
      .select(["status", "startHoldReason"])
      .where("id", "=", nextSent.run!.id)
      .executeTakeFirstOrThrow();
    expect(heldAfterRestart).toEqual({
      status: "queued",
      startHoldReason: "previous-stop-unconfirmed",
    });

    // Attempting to bind a follow-up Run on boot B2 MUST be refused with previous-stop-unconfirmed.
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    await expect(
      store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: f.harness.id,
        leaseTokenHash: `lease-${randomUUID()}`,
        runId: nextSent.run!.id,
        runnerBootId: boot2,
        runnerId: f.runnerId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "previous-stop-unconfirmed",
    });
  });

  it("S2+S3 lift (1): lifts hold and admits follow-up after a later verified reap (earlier-boots-contained-v1)", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("s3-lift-verified-reap");
    await database
      .updateTable("runners")
      .set({ machineBootId: "linux:machine-boot-1" })
      .where("id", "=", f.runnerId)
      .execute();
    const run1 = await running(f, "s3-reap-1");
    await database
      .updateTable("providerSessions")
      .set({ providerSessionReference: "native-session-s3-reap" })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          code: "execution_termination_unproven",
          message:
            "Stopping could not be confirmed. Something from this Run may still be running on that device.",
          retryable: false,
          status: "failed",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run1.id,
        threadId: f.thread.id,
        type: "run.failed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const nextSent = await store.enqueueThreadInput({
      content: [{ text: "Follow up after verified reap", type: "text" }],
      idempotencyKey: "s3-reap-next",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    await store.retryCommand(
      nextSent.command!.id,
      Object.assign(new Error("Stopping could not be confirmed."), {
        cause: {
          code: "conflict",
          message: "Stopping could not be confirmed.",
          reason: "previous-stop-unconfirmed",
          retryable: true,
        },
      }),
    );

    // Boot 2 restarts with unknown reap: stays held.
    const boot2 = `rbt_${randomUUID()}` as RunnerDescriptor["bootId"];
    await database
      .updateTable("runners")
      .set({ capabilities: jsonValue([]), machineBootId: "linux:machine-boot-1" })
      .where("id", "=", f.runnerId)
      .execute();
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: boot2,
      runnerId: f.runnerId,
    });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("startHoldReason")
          .where("id", "=", nextSent.run!.id)
          .executeTakeFirstOrThrow()
      ).startHoldReason,
    ).toBe("previous-stop-unconfirmed");

    // Boot 3 restarts with a verified earlier-boot reap (earlier-boots-contained-v1):
    // attach confirms Run 1, lifts the hold on Run 2, and Run 2 binds cleanly.
    const boot3 = `rbt_${randomUUID()}` as RunnerDescriptor["bootId"];
    await database
      .updateTable("runners")
      .set({
        capabilities: jsonValue(["earlier-boots-contained-v1"]),
        machineBootId: "linux:machine-boot-1",
      })
      .where("id", "=", f.runnerId)
      .execute();
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: boot3,
      runnerId: f.runnerId,
    });
    const run1After = await database
      .selectFrom("runs")
      .select(["status", "stopConfirmedAt"])
      .where("id", "=", run1.id)
      .executeTakeFirstOrThrow();
    expect(run1After.status).toBe("interrupted");
    expect(run1After.stopConfirmedAt).not.toBeNull();
    const run2After = await database
      .selectFrom("runs")
      .select(["status", "startHoldReason"])
      .where("id", "=", nextSent.run!.id)
      .executeTakeFirstOrThrow();
    expect(run2After).toEqual({ status: "queued", startHoldReason: null });
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    const bound = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: `lease-${randomUUID()}`,
      machineBootId: "linux:machine-boot-1",
      runId: nextSent.run!.id,
      runnerBootId: boot3,
      runnerId: f.runnerId,
      threadId: f.thread.id,
    });
    expect(bound.runnerBootId).toBe(boot3);
  });

  it("S2+S3 lift (2): lifts hold and admits follow-up after a new machine boot even when reap is unknown", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("s3-lift-machine-boot");
    await database
      .updateTable("runners")
      .set({ machineBootId: "linux:machine-boot-old" })
      .where("id", "=", f.runnerId)
      .execute();
    const run1 = await running(f, "s3-reboot-1");
    await database
      .updateTable("providerSessions")
      .set({ providerSessionReference: "native-session-s3-reboot" })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          code: "execution_termination_unproven",
          message:
            "Stopping could not be confirmed. Something from this Run may still be running on that device.",
          retryable: false,
          status: "failed",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run1.id,
        threadId: f.thread.id,
        type: "run.failed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const nextSent = await store.enqueueThreadInput({
      content: [{ text: "Follow up after machine reboot", type: "text" }],
      idempotencyKey: "s3-reboot-next",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    await store.retryCommand(
      nextSent.command!.id,
      Object.assign(new Error("Stopping could not be confirmed."), {
        cause: {
          code: "conflict",
          message: "Stopping could not be confirmed.",
          reason: "previous-stop-unconfirmed",
          retryable: true,
        },
      }),
    );

    // Machine reboots (new machineBootId), even though earlier-boot reap returned unknown!
    const boot2 = `rbt_${randomUUID()}` as RunnerDescriptor["bootId"];
    await database
      .updateTable("runners")
      .set({ capabilities: jsonValue([]), machineBootId: "linux:machine-boot-new" })
      .where("id", "=", f.runnerId)
      .execute();
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: boot2,
      runnerId: f.runnerId,
    });

    const run1After = await database
      .selectFrom("runs")
      .select(["status", "stopConfirmedAt"])
      .where("id", "=", run1.id)
      .executeTakeFirstOrThrow();
    expect(run1After.status).toBe("interrupted");
    expect(run1After.stopConfirmedAt).not.toBeNull();
    const run2After = await database
      .selectFrom("runs")
      .select(["status", "startHoldReason"])
      .where("id", "=", nextSent.run!.id)
      .executeTakeFirstOrThrow();
    expect(run2After).toEqual({ status: "queued", startHoldReason: null });
    await store.claimCommand(nextSent.command!.id, "test-dispatcher");
    const bound = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: `lease-${randomUUID()}`,
      machineBootId: "linux:machine-boot-new",
      runId: nextSent.run!.id,
      runnerBootId: boot2,
      runnerId: f.runnerId,
      threadId: f.thread.id,
    });
    expect(bound.runnerBootId).toBe(boot2);
  });
  it("counts a lineaged shell reservation as outstanding when the connection is revoked", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("shell-disconnect-set");
    const run = await running(f, "shell-disconnect-set");
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Fixture",
      clientName: "Fixture",
      resource: "http://localhost/mcp",
      accessMode: "full-access",
      grant: { scope: "everything" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(connection.id, "fixture-shell-disconnect");
    await database
      .updateTable("runs")
      .set({ connectionId: connection.id })
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    const sessionId = ShellSessionIdSchema.parse("shs_00000000-0000-4000-8000-000000000001");
    await store.reserveShellSession({
      callerMachineName: "Fixture",
      callerRunnerId: f.runnerId,
      policyRevision: 1,
      requestedBy: f.userId,
      runId: run.id,
      runnerId: f.runnerId,
      sessionId,
      startedAt: new Date(),
      threadId: f.thread.id,
      threadTitle: "Fixture",
    });
    await connections.revoke(f.userId, connection.id);
    const attempts = await connectionAttempts(database, connection.id);
    expect(attempts.map(({ id }) => id)).toContain(sessionId);
  });

  /** A Run of a live Everything / Full access connection, and a shell reservation for it (A4). */
  async function lineagedShell(storeFixture: StoreFixture, suffix: string) {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture(suffix);
    const run = await running(f, suffix);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Fixture",
      clientName: "Fixture",
      resource: "http://localhost/mcp",
      accessMode: "full-access",
      grant: { scope: "everything" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(connection.id, `fixture-${suffix}`);
    await database
      .updateTable("runs")
      .set({ connectionId: connection.id })
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    const { grantRevision } = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    const fence = (stream: string, boot = `rbt_${suffix}`) =>
      ({
        auxiliaryStreamId: `rax_${stream}`,
        bootId: boot,
        connectionGeneration: 1,
        connectionId: `rcn_${suffix}`,
        connectionLeaseId: `rls_${suffix}`,
        module: "shell",
        runnerId: f.runnerId,
      }) as unknown as RunnerAuxiliaryFrameFence;
    const reserve = (
      sessionId: ShellSessionId,
      options: {
        readonly targetFence?: RunnerAuxiliaryFrameFence;
        readonly revision?: number;
      } = {},
    ) =>
      store.reserveShellSession({
        callerMachineName: "Fixture",
        callerRunnerId: f.runnerId,
        connection: {
          connectionId: connection.id,
          grantRevision: options.revision ?? grantRevision,
          mode: "full-access",
        },
        policyRevision: 1,
        requestedBy: f.userId,
        runId: run.id,
        runnerId: f.runnerId,
        sessionId,
        startedAt: new Date(),
        targetFence: options.targetFence ?? fence("first"),
        threadId: f.thread.id,
        threadTitle: "Fixture",
      });
    const outstanding = async () =>
      (await connectionAttempts(database, connection.id)).filter(
        (attempt) => attempt.kind === "shell" && attempt.terminalEvidenceAt === null,
      );
    const row = (sessionId: ShellSessionId) =>
      database
        .selectFrom("machineAccessSessions")
        .select(["terminalEvidenceAt", "contactLostAt", "connectionId", "admittedGrantRevision"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
    return { f, connection, connections, fence, reserve, outstanding, row, grantRevision };
  }
  /** Until some session of this database waits on a row lock: the one the test holds. */
  async function waitingOnARowLock(database: StoreFixture["database"]) {
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`.execute(database);
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
  }
  const shellId = (n: number) =>
    ShellSessionIdSchema.parse(`shs_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

  it("refuses a shell whose revoke committed first and counts one reserved before it", async ({
    storeFixture,
  }) => {
    const s = await lineagedShell(storeFixture, "shell-open-order");
    const before = shellId(11);
    await s.reserve(before);
    expect(await s.row(before)).toMatchObject({
      connectionId: s.connection.id,
      admittedGrantRevision: s.grantRevision,
    });
    await s.connections.revoke(s.f.userId, s.connection.id);
    // Reserved first: in the set, outstanding, with the target and its generation.
    expect(await s.outstanding()).toMatchObject([
      { id: before, runnerId: s.f.runnerId, runnerBootId: "rbt_shell-open-order", generation: 1 },
    ]);
    // Revoked first: refused where the row would be written, so no open frame is ever sent.
    const after = shellId(12);
    await expect(s.reserve(after)).rejects.toMatchObject({ code: "forbidden" });
    expect(await s.row(after)).toBeUndefined();
  });

  it("holds a shell reservation behind a revoke in progress, then refuses it", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await lineagedShell(storeFixture, "shell-open-race");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const revoking = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", s.connection.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await tx
        .updateTable("agentConnections")
        .set({ revokedAt: new Date(), cleanupReason: "revoked", cleanupRequestedAt: new Date() })
        .where("id", "=", s.connection.id)
        .execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const sessionId = shellId(13);
    let settled = false;
    const reserving = s.reserve(sessionId).finally(() => {
      settled = true;
    });
    void reserving.catch(() => undefined);
    // Held on the connection row the revoke has: neither written nor refused yet.
    await waitingOnARowLock(database);
    expect(settled).toBe(false);
    release.resolve();
    await revoking;
    await expect(reserving).rejects.toMatchObject({ code: "forbidden" });
    expect(await s.row(sessionId)).toBeUndefined();
  });

  it("refuses a shell admitted under a grant that changed before its row", async ({
    storeFixture,
  }) => {
    const s = await lineagedShell(storeFixture, "shell-stale-grant");
    await expect(s.reserve(shellId(14), { revision: s.grantRevision - 1 })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await s.row(shellId(14))).toBeUndefined();
  });

  it("ends a shell attempt on its own stream's receipt, never another generation's", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const s = await lineagedShell(storeFixture, "shell-receipt");
    const sessionId = shellId(15);
    await s.reserve(sessionId, { targetFence: s.fence("first") });
    await s.connections.revoke(s.f.userId, s.connection.id);
    // A later stream of the same computer, and an earlier boot: neither is the one it was sent on.
    for (const other of [s.fence("second"), s.fence("first", "rbt_earlier")])
      expect(
        await store.recordShellTargetEvidence({
          fence: other,
          sessionIds: [sessionId],
          contactLost: false,
        }),
      ).toBe(0);
    expect(await s.outstanding()).toHaveLength(1);
    expect(
      await store.recordShellTargetEvidence({
        fence: s.fence("first"),
        sessionIds: [sessionId],
        contactLost: false,
      }),
    ).toBe(1);
    expect(await s.outstanding()).toEqual([]);
    expect(await s.row(sessionId)).toMatchObject({
      terminalEvidenceAt: expect.any(Date),
      contactLostAt: null,
    });
  });

  it("settles a Disconnect on a shell only once its target answers or contact is lost", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const s = await lineagedShell(storeFixture, "shell-drive");
    const sessionId = shellId(16);
    await s.reserve(sessionId);
    await s.connections.revoke(s.f.userId, s.connection.id);
    const stops: string[] = [];
    const answer: { value: void | "ended" | "contact-lost" } = { value: undefined };
    const stopper = {
      stop: async (attempt: { readonly kind: string; readonly id: string }) => {
        if (attempt.kind !== "shell") return "ended" as const;
        stops.push(attempt.id);
        return answer.value;
      },
    };
    const state = async () =>
      database
        .selectFrom("agentConnections")
        .select(["cleanupCompletedAt", "lastActionUncertainAt", "lastActionUncertain"])
        .where("id", "=", s.connection.id)
        .executeTakeFirstOrThrow();
    // No answer from the target and no contact loss: it stays Stopping, with no timeout.
    await store.driveConnectionCleanups({ stopper });
    await store.driveConnectionCleanups({ stopper });
    expect(stops).toEqual([sessionId, sessionId]);
    expect(await state()).toMatchObject({ cleanupCompletedAt: null, lastActionUncertainAt: null });
    // The target's Runner boot is gone: contact lost, ended, and the person is told to check.
    await store.markConnectionAttemptsContactLost({
      runnerId: s.f.runnerId,
      runnerBootId: "rbt_shell-drive",
    });
    await store.driveConnectionCleanups({ stopper });
    expect(stops).toHaveLength(2);
    expect(await state()).toMatchObject({
      cleanupCompletedAt: expect.any(Date),
      lastActionUncertainAt: expect.any(Date),
      lastActionUncertain: expect.objectContaining({
        attemptId: sessionId,
        reason:
          "Contact with this computer was lost before it confirmed the agent's shell there closed.",
      }),
    });
  });

  it("settles a shell whose open never left the Home with no doubt about it", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const s = await lineagedShell(storeFixture, "shell-never-sent");
    const sessionId = shellId(17);
    await s.reserve(sessionId);
    await s.connections.revoke(s.f.userId, s.connection.id);
    await store.endShellSession({ reason: "run-ended", sessionId, neverSent: true });
    expect(await s.outstanding()).toEqual([]);
    expect(await s.row(sessionId)).toMatchObject({ contactLostAt: null });
    await store.driveConnectionCleanups({ stopper: { stop: async () => "ended" as const } });
    expect(
      await database
        .selectFrom("agentConnections")
        .select(["cleanupCompletedAt", "lastActionUncertainAt"])
        .where("id", "=", s.connection.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ cleanupCompletedAt: expect.any(Date), lastActionUncertainAt: null });
  });

  /** A connected agent's Run asking the person, and the alert decided for it (A5). */
  async function lineagedRequest(storeFixture: StoreFixture, suffix: string) {
    const { fixture, running, openRequest, database } = storeFixture;
    const f = await fixture(suffix);
    const run = await running(f, suffix);
    const request = await openRequest(f, run, 1);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Fixture",
      clientName: "Fixture",
      resource: "http://localhost/mcp",
      accessMode: "full-access",
      grant: { scope: "everything" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(connection.id, `fixture-${suffix}`);
    const notifications = new NotificationStore(database);
    const decide = async () => {
      const [decision] = await notifications.decide({
        type: "requestChanged",
        kind: "harness.approval",
        status: "pending",
        opened: true,
        requestId: request.id,
        runId: run.id,
        threadId: f.thread.id,
      });
      if (!decision) throw new Error("Expected an alert");
      return {
        ...decision.view,
        userId: decision.userId,
        eventId: createId("event"),
        sequence: decision.sequence,
        connectionId: decision.connectionId,
        occurredAt: new Date(decision.view.occurredAt),
        expiresAt: new Date(Date.parse(decision.view.occurredAt) + 15 * 60_000),
      };
    };
    // Your own agent's Run first: no connection, no attempt.
    const own = await decide();
    await database
      .updateTable("runs")
      .set({ connectionId: connection.id })
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    const entry = await decide();
    const attempts = () =>
      connectionAttempts(database, connection.id).then((rows) =>
        rows.filter((attempt) => attempt.kind === "notification"),
      );
    const state = () =>
      database
        .selectFrom("agentConnections")
        .select(["cleanupCompletedAt", "lastActionUncertainAt", "lastActionUncertain"])
        .where("id", "=", connection.id)
        .executeTakeFirstOrThrow();
    return { f, run, request, connection, connections, notifications, own, entry, attempts, state };
  }

  it("attributes a Request alert to the connection whose lineage asked", async ({
    storeFixture,
  }) => {
    const r = await lineagedRequest(storeFixture, "alert-lineage");
    expect(r.own.connectionId).toBeNull();
    expect(r.entry.connectionId).toBe(r.connection.id);
  });

  it("records a connection's alert at hand-off and counts it until its outcome", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const r = await lineagedRequest(storeFixture, "alert-counted");
    const begun = await r.notifications.beginPublication(r.entry);
    expect(begun).toMatchObject({ kind: "begun" });
    if (begun.kind !== "begun") throw new Error("unreachable");
    await r.connections.revoke(r.f.userId, r.connection.id);
    // In flight when the Disconnect committed: in the set, outstanding, and Stopping.
    expect(await r.attempts()).toMatchObject([
      { id: begun.attemptId, kind: "notification", terminalEvidenceAt: null },
    ]);
    // Nor is the same alert sent again by a resend once the connection ended.
    await expect(r.notifications.continuePublication(begun.attemptId, r.entry)).resolves.toBe(
      false,
    );
    await store.driveConnectionCleanups({ stopper: { stop: async () => "ended" as const } });
    expect(await r.state()).toMatchObject({ cleanupCompletedAt: null });
    // Its acknowledgement was lost: unknown, ended with contact lost, and the person checks.
    await r.notifications.settlePublication(begun.attemptId, "unknown");
    await store.driveConnectionCleanups({ stopper: { stop: async () => "ended" as const } });
    expect(await r.state()).toMatchObject({
      cleanupCompletedAt: expect.any(Date),
      lastActionUncertainAt: expect.any(Date),
      lastActionUncertain: expect.objectContaining({
        attemptId: begun.attemptId,
        reason:
          "A phone alert about this agent's work may have been sent; the Opensteer account did not confirm it.",
      }),
    });
    // And the ended connection hands off nothing more.
    await expect(r.notifications.beginPublication(r.entry)).resolves.toEqual({
      kind: "refused",
      reason: "The connected agent's access ended",
    });
  });

  it("refuses the hand-off once the revoke committed, or the Request stopped waiting", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const answered = await lineagedRequest(storeFixture, "alert-answered");
    await database
      .updateTable("requests")
      .set({ status: "cancelled", cancellationReason: "authority-revoked", resolvedAt: new Date() })
      .where("id", "=", answered.request.id)
      .execute();
    await expect(answered.notifications.beginPublication(answered.entry)).resolves.toMatchObject({
      kind: "refused",
    });
    const revoked = await lineagedRequest(storeFixture, "alert-revoked");
    await revoked.connections.revoke(revoked.f.userId, revoked.connection.id);
    await expect(revoked.notifications.beginPublication(revoked.entry)).resolves.toMatchObject({
      kind: "refused",
    });
    for (const r of [answered, revoked]) {
      expect(
        await database
          .selectFrom("commandAttempts")
          .select("id")
          .where("connectionId", "=", r.connection.id)
          .execute(),
      ).toEqual([]);
    }
  });

  it("holds a hand-off behind a revoke in progress, then refuses it", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const r = await lineagedRequest(storeFixture, "alert-race");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const revoking = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", r.connection.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await tx
        .updateTable("agentConnections")
        .set({ revokedAt: new Date(), cleanupReason: "revoked", cleanupRequestedAt: new Date() })
        .where("id", "=", r.connection.id)
        .execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let settled = false;
    const handing = r.notifications.beginPublication(r.entry).finally(() => {
      settled = true;
    });
    await waitingOnARowLock(database);
    expect(settled).toBe(false);
    release.resolve();
    await revoking;
    await expect(handing).resolves.toMatchObject({ kind: "refused" });
    expect(await r.attempts()).toEqual([]);
  });

  it("answers a second hand-off of the same alert with the first; only a failed one goes again", async ({
    storeFixture,
  }) => {
    const r = await lineagedRequest(storeFixture, "alert-once");
    const first = await r.notifications.beginPublication(r.entry);
    if (first.kind !== "begun") throw new Error("Expected a begun attempt");
    await expect(r.notifications.beginPublication(r.entry)).resolves.toEqual({
      kind: "prior",
      state: "running",
    });
    // Known never sent: the alert may be handed off again, as a new attempt.
    await r.notifications.settlePublication(first.attemptId, "failed");
    const second = await r.notifications.beginPublication(r.entry);
    expect(second).toMatchObject({ kind: "begun" });
    if (second.kind !== "begun") throw new Error("unreachable");
    await expect(r.notifications.continuePublication(second.attemptId, r.entry)).resolves.toBe(
      true,
    );
    // It may have reached the phone: it answers every later hand-off, and is never sent again.
    await r.notifications.settlePublication(second.attemptId, "unknown");
    await expect(r.notifications.beginPublication(r.entry)).resolves.toEqual({
      kind: "prior",
      state: "unknown",
    });
    await expect(r.notifications.continuePublication(second.attemptId, r.entry)).resolves.toBe(
      false,
    );
  });
});
function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return {
    ...input,
    emittedAt: new Date().toISOString(),
  } as T;
}
