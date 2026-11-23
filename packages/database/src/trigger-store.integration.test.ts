import { personTaskReader } from "./task-reader.js";
import { personalFixtureOwner } from "./personal-run-fixture.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { installPersonalMutationHooks } from "./personal-mutation.js";

import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { randomUUID } from "node:crypto";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type TriggerId,
} from "@opensteer/core";
import type { RunnerDescriptor } from "@opensteer/protocol";
import type { TriggerOccurrence } from "@opensteer/triggers";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { describe, expect, it as baseIt, vi } from "vitest";
import {
  AgentConnectionStore,
  OpensteerStore,
  TriggerStore,
  admitWatchControlRequest,
  createDatabase,
} from "./index.js";
import "./connection.js";
import { issueRunGrant } from "./run-grants.js";
import { jsonValue } from "./store-primitives.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
integration.sequential("Trigger failure auto-pause", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-trigger-failure-integration-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return {
        database,
        close: () => database.destroy(),
      };
    });
    const store = new OpensteerStore(database);
    const triggers = new TriggerStore(database);
    async function stagedTriggerEdge(
      firstTable:
        "trigger_occurrences" | "triggers" | "execution_environments" | "runs" | "threads",
      firstId: string,
      secondTable: "triggers" | "trigger_watch_activations" | "trigger_occurrences",
      secondId: string,
      mutate: () => Promise<unknown>,
    ) {
      const barrier = pauseAfterLock(database, (node) => node.includes(firstTable));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(firstTable)} where id=${firstId} for no key update`.execute(
          transaction,
        );
        await sql`select id from ${sql.table(secondTable)} where id=${secondId} for no key update`.execute(
          transaction,
        );
      });
      void peer.catch(() => undefined);
      let mutation: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        mutation = mutate();
        void mutation.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-trigger-failure-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) => query.includes(firstTable)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, mutation]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, mutation]);
      }
    }
    async function markRunning(
      fixture: {
        readonly runnerId: ReturnType<typeof createId<"runner">>;
      },
      runId: ReturnType<typeof createId<"run">>,
      set: {
        readonly createdAt?: Date;
      } = {},
    ) {
      // Bound as a dispatch binds it: the Run's session names the Runner holding it.
      const run = await database
        .updateTable("runs")
        .set({
          ...set,
          bindingGeneration: 1,
          status: "running",
        })
        .where("id", "=", runId)
        .returning("providerSessionId")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("providerSessions")
        .set({
          bindingGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseTokenHash: `lease-${runId}`,
          runnerBootId: "test-boot",
          runnerId: fixture.runnerId,
          status: "running",
        })
        .where("id", "=", run.providerSessionId!)
        .executeTakeFirstOrThrow();
      await withPersonalTransaction(database, (transaction) =>
        issueRunGrant(transaction, {
          bindingGeneration: 1,
          modelSelection,
          runId,
          runnerBootId: "test-boot",
          runnerId: fixture.runnerId,
        }),
      );
    }
    async function createFixture(suffix: string) {
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
        sourceId: "native",
        stateKind: "isolated",
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
        environmentId,
        harnessInstanceId: harness.id,
        runnerId,
        threadId: thread.id,
        userId,
      };
    }
    async function enrollRunner(input: {
      readonly environmentId: ReturnType<typeof createId<"environment">>;
      readonly runnerId: ReturnType<typeof createId<"runner">>;
      readonly suffix: string;
      readonly userId: ReturnType<typeof createId<"user">>;
    }) {
      const descriptor: RunnerDescriptor = {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: ["filesystem"],
        modules: {
          agents: {
            environmentIds: [input.environmentId],
            harnessDrivers: [
              {
                accessModes: ThreadAccessModeSchema.options,
                driverKind: HarnessIdSchema.parse("native"),
                readiness: "configured",
                steering: true,
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
            providerStateModes: ["isolated"],
          },
        },
        name: "Trigger test Runner",
        runnerId: input.runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
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
    function createScheduleTrigger(
      fixture: Awaited<ReturnType<typeof createFixture>>,
      suffix: string,
    ) {
      return triggers.create({
        actorThreadId: null,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        idempotencyKey: `schedule-${suffix}`,
        name: `Schedule ${suffix}`,
        script: {
          interpreter: null,

          text: "console.log('ok')",
        },
        source: {
          kind: "schedule",
          schedule: {
            expression: "0 9 * * *",
            kind: "cron",
            timezone: "UTC",
          },
        },
      });
    }
    function createWatchTrigger(
      fixture: Awaited<ReturnType<typeof createFixture>>,
      suffix: string,
    ) {
      return triggers.create({
        actorThreadId: null,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        idempotencyKey: `watch-${suffix}`,
        name: `Watch ${suffix}`,
        script: {
          interpreter: null,
          text: "setInterval(() => {}, 1000);",
        },
        source: {
          kind: "watch",
        },
      });
    }
    async function detail(triggerId: TriggerId, userId: ReturnType<typeof createId<"user">>) {
      const value = await triggers.getForOwner(triggerId, userId, 25, personTaskReader);
      if (!value) throw new Error("Expected Trigger detail");
      return value;
    }
    async function failManual(
      fixture: Awaited<ReturnType<typeof createFixture>>,
      triggerId: TriggerId,
      suffix: string,
    ) {
      const occurrence = await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId,
      });
      return complete(fixture, occurrence, "failed", suffix);
    }
    async function succeedManual(
      fixture: Awaited<ReturnType<typeof createFixture>>,
      triggerId: TriggerId,
      suffix: string,
    ) {
      const occurrence = await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId,
      });
      return complete(fixture, occurrence, "succeeded", suffix);
    }
    async function complete(
      fixture: Awaited<ReturnType<typeof createFixture>>,
      occurrence: TriggerOccurrence,
      status: "failed" | "succeeded",
      suffix: string,
    ) {
      const runnerBootId = `boot-${suffix}-${randomUUID()}`;
      const claimed = await store.claimCommand(occurrence.commandId, `dispatcher-${suffix}`);
      if (!claimed) throw new Error("Expected Trigger command claim");
      const started = await triggers.startExecution({
        commandId: occurrence.commandId,
        runnerBootId,
        runnerId: fixture.runnerId,
      });
      return triggers.completeExecution({
        executionGeneration: started.executionGeneration,
        output: {
          completedAt: new Date().toISOString(),
          error: status === "failed" ? "Program failed" : null,
          exitCode: status === "failed" ? 1 : 0,
          occurrenceId: occurrence.id,
          result:
            status === "succeeded"
              ? {
                  ok: true,
                }
              : null,
          status,
          stderr: status === "failed" ? "failure\n" : "",
          stdout: status === "succeeded" ? "success\n" : "",
        },
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    }
    return Object.freeze({
      database,
      store,
      triggers,
      stagedTriggerEdge,
      markRunning,
      createFixture,
      enrollRunner,
      createScheduleTrigger,
      createWatchTrigger,
      detail,
      failManual,
      succeedManual,
      complete,
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

  it("creates an automation's own linked task with its Trigger, once per receipt", async ({
    storeFixture,
  }) => {
    const { database, triggers, createFixture, detail } = storeFixture;
    const f = await createFixture("own-task");
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.threadId)
      .execute();
    const input = {
      actorThreadId: f.threadId,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: "own-task-monitor",
      name: "Price monitor",
      ownTask: true,
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "*/30 * * * *", kind: "cron", timezone: "UTC" },
      },
    } as const;
    const children = () =>
      database.selectFrom("threads").selectAll().where("parentThreadId", "=", f.threadId).execute();
    const created = await Promise.all([triggers.create(input), triggers.create(input)]);
    expect(created.map(({ wasDuplicate }) => wasDuplicate).sort()).toEqual([false, true]);
    const [child, ...extra] = await children();
    expect(extra).toEqual([]);
    expect(created.map(({ trigger }) => trigger.anchorThreadId)).toEqual([child!.id, child!.id]);
    expect(child).toMatchObject({
      accessMode: "full-access",
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstanceId,
      lineageRootThreadId: f.threadId,
      listed: false,
      modelSelection,
      purpose: "task",
      title: "Price monitor",
    });
    const createdRevision = created.find(({ wasDuplicate }) => !wasDuplicate)!.revision;
    expect(await detail(created[0]!.trigger.id, f.userId)).toMatchObject({
      trigger: { id: created[0]!.trigger.id, anchorThreadId: child!.id },
      revision: createdRevision,
    });
    expect(
      await database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", child!.id)
        .execute(),
    ).toEqual([]);
    const replay = await triggers.create(input);
    expect(replay).toMatchObject({ wasDuplicate: true, trigger: { anchorThreadId: child!.id } });
    await expect(triggers.create({ ...input, name: "Another monitor" })).rejects.toMatchObject({
      code: "conflict",
    });
    // The receipt is the caller's intent: the same key without ownTask is another command.
    await expect(
      triggers.create({ ...input, ownTask: undefined } as unknown as Parameters<
        typeof triggers.create
      >[0]),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await children()).toHaveLength(1);
  });
  it("creates nothing when the caller may not define it or the anchor is Done", async ({
    storeFixture,
  }) => {
    const { database, store, triggers, createFixture } = storeFixture;
    const f = await createFixture("own-task-refused");
    const { thread: lower } = await store.createThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstanceId,
      idempotencyKey: "own-task-lower-caller",
      modelSelection,
      title: "Lower caller",
    });
    const input = {
      actorThreadId: lower.id,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: "own-task-refused",
      name: "Refused monitor",
      ownTask: true,
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: { kind: "watch" },
    } as const;
    const counts = async () => ({
      threads: (await database.selectFrom("threads").select("id").execute()).length,
      triggers: (await database.selectFrom("triggers").select("id").execute()).length,
    });
    const before = await counts();
    await expect(triggers.create(input)).rejects.toMatchObject({ code: "forbidden" });
    expect(await counts()).toEqual(before);
    await database
      .updateTable("threads")
      .set({ doneAt: new Date() })
      .where("id", "=", f.threadId)
      .execute();
    await expect(
      triggers.create({ ...input, actorThreadId: null, idempotencyKey: "own-task-done" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await counts()).toEqual(before);
  });
  it("lists a conversation's family: its live automations, then its own tasks' ones, ended last", async ({
    storeFixture,
  }) => {
    const { database, store, triggers, createFixture } = storeFixture;
    const f = await createFixture("family");
    const script = { interpreter: null, text: "console.log('ok')" } as const;
    const create = (name: string, anchorThreadId = f.threadId, ownTask?: true) =>
      triggers.create({
        actorThreadId: null,
        anchorThreadId,
        createdBy: f.userId,
        idempotencyKey: `family-${name}`,
        name,
        ...(ownTask ? { ownTask } : {}),
        script,
        source: { kind: "webhook" },
        webhookRouteKey: `wh_${randomUUID().replaceAll("-", "")}`,
      });
    const archive = (triggerId: TriggerId) =>
      triggers.setStatus({ actorThreadId: null, ownerId: f.userId, status: "archived", triggerId });
    const own = await create("Own live");
    await archive((await create("Own archived")).trigger.id);
    const monitor = await create("Monitor", f.threadId, true);
    const ended = await create("Ended", f.threadId, true);
    await archive(ended.trigger.id);
    // A worker handed work has its own family; its automations stay there.
    const { thread: worker } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstanceId,
      idempotencyKey: "family-worker",
      modelSelection,
      parentThreadId: f.threadId,
      title: "Worker",
    });
    const handed = await store.enqueueThreadInput({
      content: [{ text: "Work", type: "text" }],
      idempotencyKey: "family-worker-input",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: worker.id,
    });
    await database
      .insertInto("delegations")
      .values({
        id: createId("delegation"),
        childRunId: handed.run!.id,
        childThreadId: worker.id,
        initialInputMessageId: handed.message.id,
        objective: "Work",
        origin: "run",
        parentAssignmentId: null,
        parentRunId: null,
        parentThreadId: f.threadId,
        parentOccurrenceId: null,
        parentWatchActivationId: null,
        status: "open",
        revision: 1,
        resultStatus: "pending",
        resultText: null,
        finishedAt: null,
        completedAt: null,
        replyTarget: null,
        resultAttemptedAt: null,
        resultMessageId: null,
        resultReason: null,
      })
      .execute();
    await create("Worker's", worker.id);
    const family = await triggers.listForOwner({
      reader: personTaskReader,
      anchorThreadId: f.threadId,
      ownerId: f.userId,
    });
    expect(family.map(({ name, status }) => [name, status])).toEqual([
      ["Monitor", "active"],
      ["Own live", "active"],
      ["Ended", "archived"],
    ]);
    expect(family[0]).toMatchObject({
      anchorThreadId: monitor.trigger.anchorThreadId,
      anchorThreadTitle: "Monitor",
    });
    // Ended ones never crowd out a live one.
    expect(
      (
        await triggers.listForOwner({
          reader: personTaskReader,
          anchorThreadId: f.threadId,
          limit: 2,
          ownerId: f.userId,
        })
      ).map(({ id }) => id),
    ).toEqual([monitor.trigger.id, own.trigger.id]);
  });
  it("orders occurrence completion before its Trigger fence", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, triggers, store, stagedTriggerEdge, detail } =
      storeFixture;
    const fixture = await createFixture("occurrence-trigger-order");
    const created = await createScheduleTrigger(fixture, "occurrence-trigger-order");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await store.claimCommand(occurrence.commandId, "occurrence-trigger-order");
    const runnerBootId = "occurrence-trigger-order";
    const started = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await stagedTriggerEdge(
      "trigger_occurrences",
      occurrence.id,
      "triggers",
      created.trigger.id,
      () =>
        triggers.completeExecution({
          executionGeneration: started.executionGeneration,
          runnerBootId,
          runnerId: fixture.runnerId,
          output: {
            completedAt: new Date().toISOString(),
            error: null,
            exitCode: 0,
            occurrenceId: occurrence.id,
            result: {
              ok: true,
            },
            status: "succeeded",
            stderr: "",
            stdout: "",
          },
        }),
    );
    expect((await detail(created.trigger.id, fixture.userId)).occurrences[0]).toMatchObject({
      status: "succeeded",
    });
  });
  it("does not treat an earlier Trigger generation's proof as proof for a retry", async ({
    storeFixture,
  }) => {
    const { createFixture, database, store, triggers } = storeFixture;
    const fixture = await createFixture("occurrence-retry-proof");
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: fixture.userId,
      label: "Connected agent",
      clientName: "Connected agent",
      accessMode: "full-access",
      resource: "https://home.example.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await connections.activate(connection.id, randomUUID())).toBe(true);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: connection.id,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "occurrence-retry-proof",
      name: "Retry proof",
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: trigger.id,
    });
    const read = () =>
      database
        .selectFrom("triggerOccurrences")
        .selectAll()
        .where("id", "=", occurrence.id)
        .executeTakeFirstOrThrow();
    const runnerBootId = "same-boot";
    const runnerId = fixture.runnerId;
    const dispatch = { commandId: occurrence.commandId, runnerBootId, runnerId };
    expect(await store.claimCommand(occurrence.commandId, "first-dispatch")).not.toBeNull();
    const first = await triggers.startExecution(dispatch);
    await triggers.recordOccurrenceNotAdmitted(occurrence.id, first.executionGeneration);
    expect(await read()).toMatchObject({
      terminalEvidenceAt: expect.any(Date),
      contactLostAt: null,
    });
    await store.retryCommand(occurrence.commandId, new Error("Not sent"));
    expect(
      await database
        .selectFrom("triggerOccurrenceAttempts")
        .select("occurrenceId")
        .where("occurrenceId", "=", occurrence.id)
        .execute(),
    ).toEqual([]);
    expect(await store.claimCommand(occurrence.commandId, "retry-dispatch")).not.toBeNull();
    const second = await triggers.startExecution(dispatch);
    expect(second.executionGeneration).toBe(first.executionGeneration + 1);
    const running = {
      status: "running",
      executionGeneration: second.executionGeneration,
      terminalEvidenceAt: null,
      contactLostAt: null,
    };
    expect(await read()).toMatchObject(running);
    const output = {
      occurrenceId: occurrence.id,
      completedAt: new Date().toISOString(),
      status: "succeeded" as const,
      result: null,
      error: null,
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    await expect(
      triggers.completeExecution({
        executionGeneration: first.executionGeneration,
        runnerBootId,
        runnerId,
        verifiedContainment: true,
        output,
      }),
    ).rejects.toThrow("Trigger result binding is stale");
    await triggers.recordOccurrenceNotAdmitted(occurrence.id, first.executionGeneration);
    expect(await read()).toMatchObject(running);
    await triggers.completeExecution({
      executionGeneration: second.executionGeneration,
      runnerBootId,
      runnerId,
      verifiedContainment: true,
      output,
    });
    expect(await read()).toMatchObject({
      ...running,
      status: "succeeded",
      terminalEvidenceAt: expect.any(Date),
    });
  });

  it("fences the target Run before an Occurrence input source", async ({ storeFixture }) => {
    const {
      createFixture,
      store,
      markRunning,
      createScheduleTrigger,
      triggers,
      stagedTriggerEdge,
    } = storeFixture;
    const fixture = await createFixture("input-occurrence-order");
    const queued = await store.enqueueThreadInput({
      content: [
        {
          text: "Existing work",
          type: "text",
        },
      ],
      idempotencyKey: "input-occurrence-work",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.threadId,
    });
    if (!queued.run) throw new Error("Expected Run");
    await markRunning(fixture, queued.run.id);
    const created = await createScheduleTrigger(fixture, "input-occurrence-order");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await store.claimCommand(occurrence.commandId, "input-occurrence-order");
    await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "input-occurrence-order",
      runnerId: fixture.runnerId,
    });
    await stagedTriggerEdge("runs", queued.run.id, "trigger_occurrences", occurrence.id, () =>
      store.enqueueThreadInput({
        content: [
          {
            text: "Observed change",
            type: "text",
          },
        ],
        idempotencyKey: "input-occurrence-observation",
        policy: "steer",
        requestedBy: fixture.userId,
        source: {
          kind: "trigger",
          occurrenceId: occurrence.id,
        },
        threadId: fixture.threadId,
      }),
    );
  });
  it("fences the anchor task before an admitted Watch input source", async ({ storeFixture }) => {
    const { createFixture, createWatchTrigger, triggers, stagedTriggerEdge, store } = storeFixture;
    const fixture = await createFixture("input-watch-order");
    const created = await createWatchTrigger(fixture, "input-watch-order");
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60000),
      runnerBootId: "input-watch-order",
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activation = snapshot.activations[0]!.activation;
    await stagedTriggerEdge(
      "threads",
      fixture.threadId,
      "trigger_watch_activations",
      activation.id,
      () =>
        store.enqueueAdmittedThreadInput({
          admission: {
            kind: "watch",
            request: {
              action: "thread.message",
              activationId: activation.id,
              anchorThreadId: fixture.threadId,
              createdBy: fixture.userId,
              environmentId: fixture.environmentId,
              executionGeneration: activation.executionGeneration,
              requestFingerprint: "a".repeat(64),
              requestId: "input-watch",
              revisionId: created.revision.id,
              triggerId: created.trigger.id,
            },
          },
          input: {
            content: [
              {
                text: "Watch observation",
                type: "text",
              },
            ],
            idempotencyKey: "input-watch",
            policy: "queue",
            requestedBy: fixture.userId,
            source: {
              activationId: activation.id,
              kind: "watch",
              observationId: "input-watch",
              revisionId: created.revision.id,
              triggerId: created.trigger.id,
            },
            threadId: fixture.threadId,
          },
        }),
    );
  });

  it("orders cancellation occurrences before their Trigger fence", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, triggers, stagedTriggerEdge, detail } =
      storeFixture;
    const fixture = await createFixture("cancel-occurrence-order");
    const created = await createScheduleTrigger(fixture, "cancel-occurrence-order");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await stagedTriggerEdge(
      "trigger_occurrences",
      occurrence.id,
      "triggers",
      created.trigger.id,
      () =>
        triggers.cancelPendingOccurrences(fixture.userId, {
          actorThreadId: null,
          triggerId: created.trigger.id,
        }),
    );
    expect((await detail(created.trigger.id, fixture.userId)).occurrences[0]).toMatchObject({
      status: "canceled",
    });
  });
  it("orders watch status after its Trigger fence", async ({ storeFixture }) => {
    const { createFixture, createWatchTrigger, triggers, stagedTriggerEdge, detail } = storeFixture;
    const fixture = await createFixture("watch-trigger-order");
    const created = await createWatchTrigger(fixture, "watch-trigger-order");
    const runnerBootId = "watch-trigger-order";
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60000),
      runnerBootId,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activation = snapshot.activations[0]!.activation;
    await stagedTriggerEdge(
      "triggers",
      created.trigger.id,
      "trigger_watch_activations",
      activation.id,
      () =>
        triggers.applyWatchStatus({
          activationId: activation.id,
          executionGeneration: activation.executionGeneration,
          healthySince: null,
          lastError: "restart",
          lastExitCode: 1,
          observed: "backoff",
          restartCount: 1,
          runnerBootId,
          runnerConnectionGeneration: 1,
          runnerId: fixture.runnerId,
          stderrTail: "",
          stdoutTail: "",
        }),
    );
    expect((await detail(created.trigger.id, fixture.userId)).activation).toMatchObject({
      restartCount: 1,
    });
  });
  it("orders watch revision capacity before Trigger and activation fences", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, stagedTriggerEdge, triggers, detail } = storeFixture;
    const fixture = await createFixture("watch-capacity-order");
    const created = await createWatchTrigger(fixture, "watch-capacity-order");
    await stagedTriggerEdge(
      "execution_environments",
      fixture.environmentId,
      "triggers",
      created.trigger.id,
      () =>
        triggers.update({
          actorThreadId: null,
          expectedRevisionId: created.revision.id,
          ownerId: fixture.userId,
          triggerId: created.trigger.id,
          script: {
            interpreter: null,
            text: "await new Promise(() => {});",
          },
        }),
    );
    expect((await detail(created.trigger.id, fixture.userId)).trigger.currentRevisionId).not.toBe(
      created.revision.id,
    );
  });
  it("keeps an active schedule running across repeated failures and records failing_since (T9)", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, detail, database } = storeFixture;
    const fixture = await createFixture("three-failures");
    const created = await createScheduleTrigger(fixture, "three-failures");
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");
    const afterThird = await detail(created.trigger.id, fixture.userId);
    expect(afterThird.trigger).toMatchObject({
      pauseReason: null,
      status: "active",
    });
    expect(afterThird.trigger.nextFireAt).not.toBeNull();
    const row = await database
      .selectFrom("triggers")
      .select(["failingSince", "failureNotifiedAt"])
      .where("id", "=", created.trigger.id)
      .executeTakeFirstOrThrow();
    expect(row.failingSince).not.toBeNull();
    expect(row.failureNotifiedAt).not.toBeNull();
  });
  it("clears failingSince when a success interrupts failures", async ({ storeFixture }) => {
    const {
      createFixture,
      createScheduleTrigger,
      failManual,
      triggers,
      detail,
      succeedManual,
      database,
    } = storeFixture;
    const fixture = await createFixture("success-reset");
    const created = await createScheduleTrigger(fixture, "success-reset");
    await failManual(fixture, created.trigger.id, "first");
    const canceled = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await triggers.cancelPendingOccurrences(fixture.userId, {
      actorThreadId: null,
      occurrenceId: canceled.id,
      triggerId: created.trigger.id,
    });
    const readFailing = async () =>
      (
        await database
          .selectFrom("triggers")
          .select(["failingSince", "failureNotifiedAt"])
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince;
    expect(await readFailing()).not.toBeNull();
    await succeedManual(fixture, created.trigger.id, "success");
    expect(await readFailing()).toBeNull();
    await failManual(fixture, created.trigger.id, "second-series-1");
    await failManual(fixture, created.trigger.id, "second-series-2");
    expect(await readFailing()).not.toBeNull();
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      status: "active",
    });
  });
  it("does not mark failing for a failed occurrence pinned to a stale Revision", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, complete, detail, database } =
      storeFixture;
    const fixture = await createFixture("stale-revision");
    const created = await createScheduleTrigger(fixture, "stale-revision");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      ownerId: fixture.userId,
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      triggerId: created.trigger.id,
    });
    await complete(fixture, occurrence, "failed", "stale-failure");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      status: "active",
    });
    expect(
      (
        await database
          .selectFrom("triggers")
          .select("failingSince")
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince,
    ).toBeNull();
  });

  it("allows a manual run while paused and clears failingSince after success", async ({
    storeFixture,
  }) => {
    const {
      createFixture,
      createScheduleTrigger,
      failManual,
      succeedManual,
      triggers,
      detail,
      database,
    } = storeFixture;
    const fixture = await createFixture("paused-manual");
    const created = await createScheduleTrigger(fixture, "paused-manual");
    await failManual(fixture, created.trigger.id, "first");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    await succeedManual(fixture, created.trigger.id, "repair-check");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "paused",
    });
    expect(
      (
        await database
          .selectFrom("triggers")
          .select("failingSince")
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince,
    ).toBeNull();
  });
  it("counts an in-flight failure without changing an already paused Trigger, and cancels pending firings on pause (Y12)", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, store, detail } = storeFixture;
    const fixture = await createFixture("already-paused");
    const created = await createScheduleTrigger(fixture, "already-paused");
    const pendingOcc = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const pausedWithPending = await triggers.setStatusWithEffects({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(pausedWithPending.canceledOccurrenceIds).toEqual([pendingOcc.id]);
    expect(pausedWithPending.runningFirings).toEqual([]);

    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    const runningOcc = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await store.claimCommand(runningOcc.commandId, "pause-test");
    const started = await triggers.startExecution({
      commandId: runningOcc.commandId,
      runnerBootId: "boot-already-paused",
      runnerId: fixture.runnerId,
    });
    const pausedWithRunning = await triggers.setStatusWithEffects({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(pausedWithRunning.runningFirings).toEqual([
      {
        commandId: runningOcc.commandId,
        environmentId: fixture.environmentId,
        executionGeneration: started.executionGeneration,
        occurrenceId: runningOcc.id,
        runnerBootId: "boot-already-paused",
        runnerId: fixture.runnerId,
      },
    ]);
    await triggers.completeExecution({
      executionGeneration: started.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: "Program failed",
        exitCode: 1,
        occurrenceId: runningOcc.id,
        result: null,
        status: "failed",
        stderr: "failure\n",
        stdout: "",
      },
      runnerBootId: "boot-already-paused",
      runnerId: fixture.runnerId,
    });
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "paused",
    });

    const archived = await createScheduleTrigger(fixture, "already-archived");
    const archivedOccurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: archived.trigger.id,
    });
    await store.claimCommand(archivedOccurrence.commandId, "archive-test");
    const archivedStarted = await triggers.startExecution({
      commandId: archivedOccurrence.commandId,
      runnerBootId: "boot-already-archived",
      runnerId: fixture.runnerId,
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "archived",
      triggerId: archived.trigger.id,
    });
    await triggers.completeExecution({
      executionGeneration: archivedStarted.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: "Program failed",
        exitCode: 1,
        occurrenceId: archivedOccurrence.id,
        result: null,
        status: "failed",
        stderr: "failure\n",
        stdout: "",
      },
      runnerBootId: "boot-already-archived",
      runnerId: fixture.runnerId,
    });
    expect((await detail(archived.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "archived",
    });
  });
  it("clears failures and recomputes a schedule when resumed after manual pause", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers } = storeFixture;
    const fixture = await createFixture("resume");
    const created = await createScheduleTrigger(fixture, "resume");
    await failManual(fixture, created.trigger.id, "first");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    const resumed = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    expect(resumed).toMatchObject({
      pauseReason: null,
      status: "active",
    });
    expect(Date.parse(resumed.nextFireAt ?? "")).toBeGreaterThan(Date.now());
    const pausedManually = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(pausedManually.pauseReason).toBeNull();
    const archived = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "archived",
      triggerId: created.trigger.id,
    });
    expect(archived.pauseReason).toBeNull();
  });
  it("wakes the scheduler when a program repair makes a waiting schedule runnable", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, database, triggers } = storeFixture;
    const fixture = await createFixture("program-repair-wake");
    const created = await createScheduleTrigger(fixture, "program-repair-wake");
    // A legacy non-script revision: the schedule keeps its future time but cannot run.
    await sql`update trigger_revisions set script = null, legacy_source = 'export default () => null;'
      where id = ${created.revision.id}`.execute(database);
    expect(await triggers.nextScheduleAt()).toBeNull();
    const reactions: string[] = [];
    const unhook = installPersonalMutationHooks(database, {
      wake() {},
      react: (reaction) => {
        reactions.push(reaction.type);
      },
      onFailure(error) {
        throw error;
      },
    });
    try {
      await triggers.update({
        actorThreadId: null,
        expectedRevisionId: created.revision.id,
        ownerId: fixture.userId,
        script: {
          interpreter: null,

          text: "console.log('ok')",
        },
        triggerId: created.trigger.id,
      });
    } finally {
      unhook();
    }
    expect(await triggers.nextScheduleAt()).toEqual(expect.any(Date));
    expect(reactions).toContain("triggerSchedulesChanged");
  });
  it("keeps failingSince on a name-only update and preserves revision history on updates", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers, database } = storeFixture;
    const fixture = await createFixture("revision-reset");
    const created = await createScheduleTrigger(fixture, "revision-reset");
    await failManual(fixture, created.trigger.id, "first");
    const renamed = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      name: "Renamed only",
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    expect(renamed.trigger.name).toBe("Renamed only");
    expect(
      (
        await database
          .selectFrom("triggers")
          .select("failingSince")
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince,
    ).not.toBeNull();
    const repaired = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: renamed.revision.id,
      ownerId: fixture.userId,
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      triggerId: created.trigger.id,
    });
    expect(repaired.revision.ordinal).toBe(3);
    await failManual(fixture, created.trigger.id, "after-program-update");
    const rescheduled = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: repaired.revision.id,
      ownerId: fixture.userId,
      source: {
        kind: "schedule",
        schedule: {
          expression: "30 9 * * *",
          kind: "cron",
          timezone: "UTC",
        },
      },
      triggerId: created.trigger.id,
    });
    expect(rescheduled.revision.ordinal).toBe(4);
  });
  it("keeps accepting webhooks across repeated failures and refuses them once paused (T9)", async ({
    storeFixture,
  }) => {
    const { createFixture, triggers, failManual } = storeFixture;
    const fixture = await createFixture("paused-webhook");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "paused-webhook",
      name: "Paused webhook",
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: {
        kind: "webhook",
      },
      webhookRouteKey: "wh_paused_webhook_123456789012345678",
    });
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");
    const stillAccepted = await triggers.enqueueWebhook({
      headers: {},
      method: "POST",
      payload: null,
      routeKey: created.trigger.webhookRouteKey ?? "",
    });
    expect(stillAccepted.occurrence.status).toBe("pending");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    await expect(
      triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        payload: null,
        routeKey: created.trigger.webhookRouteKey ?? "",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Webhook not found",
    });
  });
  it("does not reset the count when a stale-Revision occurrence succeeds", async ({
    storeFixture,
  }) => {
    const { createFixture, triggers, complete, detail } = storeFixture;
    const fixture = await createFixture("stale-success");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "stale-success-wh",
      name: "Stale success",
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_stale_success_1234567890123456789",
    });
    const stale = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey: created.trigger.webhookRouteKey!,
      })
    ).occurrence;
    await storeFixture.store.claimCommand(stale.commandId, "stale-success-dispatcher");
    const staleStarted = await triggers.startExecution({
      commandId: stale.commandId,
      runnerBootId: "boot-stale-1",
      runnerId: fixture.runnerId,
    });
    // Mark the stale firing unknown when the Runner restarts without it, unblocking later firings.
    await triggers.attachRunnerFirings({
      dispatchingOccurrenceIds: [],
      firings: [],
      runnerBootId: "boot-stale-2",
      runnerId: fixture.runnerId,
    });
    await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      ownerId: fixture.userId,
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      triggerId: created.trigger.id,
    });
    const first = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey: created.trigger.webhookRouteKey!,
      })
    ).occurrence;
    const second = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey: created.trigger.webhookRouteKey!,
      })
    ).occurrence;
    await complete(fixture, first, "failed", "first");
    await complete(fixture, second, "failed", "second");
    // Late proof settles the stale-Revision occurrence to succeeded without clearing failingSince.
    await triggers.completeExecution({
      executionGeneration: staleStarted.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: stale.id,
        result: null,
        status: "succeeded",
        stderr: "",
        stdout: "",
      },
      runnerBootId: "boot-stale-1",
      runnerId: fixture.runnerId,
    });
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      status: "active",
    });
    expect(
      (
        await storeFixture.database
          .selectFrom("triggers")
          .select("failingSince")
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince,
    ).not.toBeNull();
  });
  it("treats a repeated status as a no-op that keeps the reason and failing state", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers, database } = storeFixture;
    const fixture = await createFixture("repeat-status");
    const created = await createScheduleTrigger(fixture, "repeat-status");
    await failManual(fixture, created.trigger.id, "first");
    const stillActive = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    expect(stillActive.status).toBe("active");
    expect(
      (
        await database
          .selectFrom("triggers")
          .select("failingSince")
          .where("id", "=", created.trigger.id)
          .executeTakeFirstOrThrow()
      ).failingSince,
    ).not.toBeNull();
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    await database
      .updateTable("triggers")
      .set({ pauseReason: "Paused because its task was marked done." })
      .where("id", "=", created.trigger.id)
      .execute();
    const stillPaused = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(stillPaused).toMatchObject({
      pauseReason: "Paused because its task was marked done.",
      status: "paused",
    });
  });
  it("rejects an update that changes nothing", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, triggers, detail } = storeFixture;
    const fixture = await createFixture("empty-update");
    const created = await createScheduleTrigger(fixture, "empty-update");
    await expect(
      triggers.update({
        actorThreadId: null,
        expectedRevisionId: created.revision.id,
        ownerId: fixture.userId,
        triggerId: created.trigger.id,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    expect((await detail(created.trigger.id, fixture.userId)).revision.id).toBe(
      created.revision.id,
    );
  });
  it("refuses overlapping manual runs (Y11) and counts sequential failures without auto-pausing (T9)", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, complete, detail } = storeFixture;
    const fixture = await createFixture("concurrent");
    const created = await createScheduleTrigger(fixture, "concurrent");
    const first = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await expect(
      triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId: created.trigger.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await complete(fixture, first, "failed", "seq-0");
    const second = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await complete(fixture, second, "failed", "seq-1");
    const third = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await complete(fixture, third, "failed", "seq-2");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "active",
    });
  });
  it("tracks failures independently for each Trigger", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, failManual, detail, database } = storeFixture;
    const fixture = await createFixture("per-trigger");
    const failing = await createScheduleTrigger(fixture, "per-trigger-failing");
    const unaffected = await createScheduleTrigger(fixture, "per-trigger-unaffected");
    await failManual(fixture, failing.trigger.id, "first");
    await failManual(fixture, failing.trigger.id, "second");
    await failManual(fixture, failing.trigger.id, "third");
    expect((await detail(failing.trigger.id, fixture.userId)).trigger).toMatchObject({
      status: "active",
    });
    expect((await detail(unaffected.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "active",
    });
    const rows = await database
      .selectFrom("triggers")
      .select(["id", "failingSince"])
      .where("id", "in", [failing.trigger.id, unaffected.trigger.id])
      .execute();
    expect(rows.find((r) => r.id === failing.trigger.id)?.failingSince).not.toBeNull();
    expect(rows.find((r) => r.id === unaffected.trigger.id)?.failingSince).toBeNull();
  });
  it("reads downstream Runs separately from the Trigger program outcome", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, store, detail } = storeFixture;
    const fixture = await createFixture("downstream-runs");
    const created = await createScheduleTrigger(fixture, "downstream-runs");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const runnerBootId = `boot-downstream-${randomUUID()}`;
    const claimed = await store.claimCommand(occurrence.commandId, "downstream-dispatcher");
    if (!claimed) throw new Error("Expected Trigger command claim");
    const started = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const first = await store.enqueueThreadInput({
      content: [
        {
          text: "Summarize the inbox",
          type: "text",
        },
      ],
      idempotencyKey: "downstream-first",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "trigger",
        occurrenceId: occurrence.id,
      },
      threadId: fixture.threadId,
    });
    const second = await store.enqueueThreadInput({
      content: [
        {
          text: "Check the calendar",
          type: "text",
        },
      ],
      idempotencyKey: "downstream-second",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "trigger",
        occurrenceId: occurrence.id,
      },
      threadId: fixture.threadId,
    });
    if (!first.run) throw new Error("Expected the first downstream Run");
    expect(second.run).toBeNull();
    await triggers.completeExecution({
      executionGeneration: started.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: occurrence.id,
        result: {
          queued: true,
        },
        status: "succeeded",
        stderr: "",
        stdout: "",
      },
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const value = await detail(created.trigger.id, fixture.userId);
    expect(value.occurrences[0]?.status).toBe("succeeded");
    expect(value.downstreamRunsTruncated).toBe(false);
    expect(value.downstreamRuns).toEqual([
      expect.objectContaining({
        occurrenceId: occurrence.id,
        run: expect.objectContaining({
          id: first.run.id,
          status: "queued",
        }),
        threadTitle: "Thread downstream-runs",
      }),
    ]);
  });
  it("associates a Trigger message that steers a Run from another causal chain", async ({
    storeFixture,
  }) => {
    const { createFixture, store, markRunning, database, createScheduleTrigger, triggers, detail } =
      storeFixture;
    const fixture = await createFixture("steered-downstream-run");
    const older = await store.enqueueThreadInput({
      content: [
        {
          text: "Start older existing work",
          type: "text",
        },
      ],
      idempotencyKey: "steered-downstream-older",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.threadId,
    });
    if (!older.run) throw new Error("Expected the older existing Run");
    const newerThread = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstanceId,
      idempotencyKey: "steered-downstream-newer-thread",
      modelSelection,
      title: "Newer target Thread",
    });
    const newer = await store.enqueueThreadInput({
      content: [
        {
          text: "Start newer existing work",
          type: "text",
        },
      ],
      idempotencyKey: "steered-downstream-newer",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: newerThread.thread.id,
    });
    if (!newer.run) throw new Error("Expected the newer existing Run");
    await markRunning(fixture, older.run.id, {
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await markRunning(fixture, newer.run.id);
    await database
      .updateTable("threadInputs")
      .set({
        runId: older.run.id,
        state: "claimed",
      })
      .where("messageId", "=", older.message.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threadInputs")
      .set({
        runId: newer.run.id,
        state: "claimed",
      })
      .where("messageId", "=", newer.message.id)
      .executeTakeFirstOrThrow();
    const created = await createScheduleTrigger(fixture, "steered-downstream-run");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const runnerBootId = `boot-steered-downstream-${randomUUID()}`;
    const claimed = await store.claimCommand(occurrence.commandId, "steered-trigger-dispatcher");
    if (!claimed) throw new Error("Expected Trigger command claim");
    await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const olderSteer = await store.enqueueThreadInput({
      content: [
        {
          text: "One update for the older Run",
          type: "text",
        },
      ],
      idempotencyKey: "steered-downstream-older-input",
      policy: "steer",
      requestedBy: fixture.userId,
      source: {
        kind: "trigger",
        occurrenceId: occurrence.id,
      },
      threadId: fixture.threadId,
    });
    await database
      .updateTable("threadInputs")
      .set({
        deliveredAt: new Date(),
        runId: older.run.id,
        state: "delivered",
      })
      .where("messageId", "=", olderSteer.message.id)
      .executeTakeFirstOrThrow();
    const steered = await store.enqueueThreadInput({
      content: [
        {
          text: "Trigger update",
          type: "text",
        },
      ],
      idempotencyKey: "steered-downstream-input-0",
      policy: "steer",
      requestedBy: fixture.userId,
      source: {
        kind: "trigger",
        occurrenceId: occurrence.id,
      },
      threadId: newerThread.thread.id,
    });
    const occurrenceChainId = steered.input.causalChainId;
    expect(olderSteer.input.causalChainId).toBe(occurrenceChainId);
    const { approvalSort: _approvalSort, ...templateInput } = await database
      .updateTable("threadInputs")
      .set({
        deliveredAt: new Date(),
        runId: newer.run.id,
        state: "delivered",
      })
      .where("messageId", "=", steered.message.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const templateMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", steered.message.id)
      .executeTakeFirstOrThrow();
    // Exercise distinct-Run pagination with 105 receipts, without repeating
    // admission: both target Runs already received a real Trigger steer.
    const extra = Array.from(
      {
        length: 104,
      },
      (_, index) => ({
        messageId: createId("message"),
        sequence: (BigInt(templateMessage.sequence) + BigInt(index) + 1n).toString(),
      }),
    );
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("threads")
        .set({
          nextMessageSequence: (BigInt(templateMessage.sequence) + 105n).toString(),
        })
        .where("id", "=", newerThread.thread.id)
        .execute();
      await transaction
        .insertInto("messages")
        .values(
          extra.map(({ messageId, sequence }) => ({
            ...templateMessage,
            content: jsonValue(templateMessage.content),
            id: messageId,
            sequence,
          })),
        )
        .execute();
      await transaction
        .insertInto("threadInputs")
        .values(
          extra.map(({ messageId, sequence }, index) => ({
            ...templateInput,
            idempotencyKey: `steered-downstream-input-${index + 1}`,
            messageId,
            queueRank: sequence,
            steerCommandId: null,
          })),
        )
        .execute();
    });
    const receipts = await database
      .selectFrom("threadInputs")
      .select(["causalChainId", "runId", "state"])
      .where("threadId", "=", newerThread.thread.id)
      .where("policy", "=", "steer")
      .execute();
    expect(receipts).toHaveLength(105);
    for (const receipt of receipts) {
      expect(receipt.causalChainId).toBe(occurrenceChainId);
      expect(receipt.runId).toBe(newer.run.id);
      expect(receipt.state).toBe("delivered");
    }
    expect(occurrenceChainId).not.toBe(newer.run.causalChainId);
    const value = await detail(created.trigger.id, fixture.userId);
    expect(value.downstreamRuns.map(({ run }) => run.id)).toEqual([newer.run.id, older.run.id]);
    expect(value.downstreamRunsTruncated).toBe(false);
  });
  it("caps more than 100 distinct downstream Runs and reports truncation", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, store, database, detail } =
      storeFixture;
    const fixture = await createFixture("downstream-run-cap");
    const created = await createScheduleTrigger(fixture, "downstream-run-cap");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const runnerBootId = `boot-downstream-cap-${randomUUID()}`;
    const claimed = await store.claimCommand(occurrence.commandId, "downstream-cap-dispatcher");
    if (!claimed) throw new Error("Expected Trigger command claim");
    await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const existing = await store.enqueueThreadInput({
      content: [
        {
          text: "Existing work 0",
          type: "text",
        },
      ],
      idempotencyKey: "downstream-cap-existing-0",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.threadId,
    });
    if (!existing.run) throw new Error("Expected a distinct existing Run");
    const runIds = [existing.run.id];
    const steered = await store.enqueueThreadInput({
      content: [
        {
          text: "Trigger update 0",
          type: "text",
        },
      ],
      idempotencyKey: "downstream-cap-steer-0",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "trigger",
        occurrenceId: occurrence.id,
      },
      threadId: fixture.threadId,
    });
    await database
      .updateTable("threadInputs")
      .set({
        deliveredAt: new Date(),
        policy: "steer",
        runId: existing.run.id,
        state: "delivered",
      })
      .where("messageId", "=", steered.message.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({
        deliveredAt: new Date(),
        runId: existing.run.id,
        state: "delivered",
      })
      .where("messageId", "=", existing.message.id)
      .execute();
    await database
      .updateTable("runs")
      .set({
        completedAt: new Date(),
        status: "completed",
      })
      .where("id", "=", existing.run.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threads")
      .set({
        status: "idle",
      })
      .where("id", "=", fixture.threadId)
      .executeTakeFirstOrThrow();
    const templateRun = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runIds[0]!)
      .executeTakeFirstOrThrow();
    const templateInputs = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("runId", "=", templateRun.id)
      .execute();
    const { approvalSort: _humanSort, ...humanInput } = templateInputs.find(
      (input) => input.policy === "queue",
    )!;
    const { approvalSort: _triggerSort, ...triggerInput } = templateInputs.find(
      (input) => input.policy === "steer",
    )!;
    const templateMessages = await database
      .selectFrom("messages")
      .selectAll()
      .where(
        "id",
        "in",
        templateInputs.map(({ messageId }) => messageId),
      )
      .execute();
    const humanMessage = templateMessages.find(({ id }) => id === humanInput.messageId)!;
    const triggerMessage = templateMessages.find(({ id }) => id === triggerInput.messageId)!;
    const templateChain = await database
      .selectFrom("causalChains")
      .selectAll()
      .where("id", "=", templateRun.causalChainId)
      .executeTakeFirstOrThrow();
    // This boundary is the detail query's distinct-Run cap, not 202 admissions.
    // Keep real admitted rows as templates and grow the relational fixture in bulk.
    const extra = Array.from(
      {
        length: 100,
      },
      (_, index) => ({
        createdAt: new Date(templateRun.createdAt.getTime() + index + 1),
        runOrdinal: templateRun.runOrdinal + index + 1,
        causalChainId: createId("causalChain"),
        runId: createId("run"),
        humanId: createId("message"),
        triggerId: createId("message"),
        humanSequence: (BigInt(triggerMessage.sequence) + BigInt(index * 2) + 1n).toString(),
        triggerSequence: (BigInt(triggerMessage.sequence) + BigInt(index * 2) + 2n).toString(),
      }),
    );
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("threads")
        .set({
          nextMessageSequence: (BigInt(triggerMessage.sequence) + 201n).toString(),
        })
        .where("id", "=", fixture.threadId)
        .execute();
      await transaction
        .insertInto("causalChains")
        .values(
          extra.map((row) => ({
            ...templateChain,
            id: row.causalChainId,
            rootMessageId: row.humanId,
          })),
        )
        .execute();
      await transaction
        .insertInto("messages")
        .values(
          extra.flatMap((row) => [
            {
              ...humanMessage,
              content: jsonValue(humanMessage.content),
              id: row.humanId,
              sequence: row.humanSequence,
            },
            {
              ...triggerMessage,
              content: jsonValue(triggerMessage.content),
              id: row.triggerId,
              sequence: row.triggerSequence,
            },
          ]),
        )
        .execute();
      await transaction
        .insertInto("threadInputs")
        .values(
          extra.flatMap((row) => [
            {
              ...humanInput,
              messageId: row.humanId,
              runId: null,
              state: "pending" as const,
              deliveredAt: null,
              causalChainId: row.causalChainId,
              idempotencyKey: `downstream-cap-existing-${row.runId}`,
              queueRank: row.humanSequence,
            },
            {
              ...triggerInput,
              messageId: row.triggerId,
              runId: null,
              state: "pending" as const,
              deliveredAt: null,
              idempotencyKey: `downstream-cap-steer-${row.runId}`,
              queueRank: row.triggerSequence,
            },
          ]),
        )
        .execute();
      await transaction
        .insertInto("runs")
        .values(
          extra.map((row) => ({
            ...templateRun,
            createdAt: row.createdAt,
            runOrdinal: row.runOrdinal,
            id: row.runId,
            causalChainId: row.causalChainId,
            seedInputId: row.humanId,
            activationInputId: row.humanId,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            costUsd: null,
          })),
        )
        .execute();
      await sql`update thread_inputs set run_id = fixture."runId", state = 'delivered', delivered_at = now()
        from jsonb_to_recordset(${jsonValue(extra)}) as fixture("runId" text, "humanId" text, "triggerId" text)
        where message_id in (fixture."humanId", fixture."triggerId")`.execute(transaction);
    });
    runIds.push(...extra.map(({ runId }) => runId));
    const value = await detail(created.trigger.id, fixture.userId);
    expect(value.downstreamRuns).toHaveLength(100);
    expect(new Set(value.downstreamRuns.map(({ run }) => run.id)).size).toBe(100);
    expect(value.downstreamRuns.map(({ run }) => run.id)).toEqual(
      extra.map(({ runId }) => runId).reverse(),
    );
    expect(value.downstreamRuns.every(({ occurrenceId }) => occurrenceId === occurrence.id)).toBe(
      true,
    );
    expect(value.downstreamRunsTruncated).toBe(true);
    expect(runIds).toHaveLength(101);
  });
  it("reconciles watch desired state without creating an Occurrence or command", async ({
    storeFixture,
  }) => {
    const { createFixture, database, createWatchTrigger, detail, triggers } = storeFixture;
    const fixture = await createFixture("watch-reconcile");
    const commandsBefore = await database
      .selectFrom("commands")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const created = await createWatchTrigger(fixture, "watch-reconcile");
    const initial = await detail(created.trigger.id, fixture.userId);
    expect(initial.occurrences).toEqual([]);
    expect(initial.activation).toMatchObject({
      desired: "active",
      executionGeneration: 0,
    });
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("triggerId", "=", created.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      count: "0",
    });
    expect(
      await database
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual(commandsBefore);
    const bootOne = `watch-boot-one-${randomUUID()}`;
    const first = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: bootOne,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    expect(first.activations).toHaveLength(1);
    expect(first.activations[0]?.activation).toMatchObject({
      executionGeneration: 1,
      runnerConnectionGeneration: 1,
    });
    const renewed = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      runnerBootId: bootOne,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    expect(renewed.activations[0]?.activation.executionGeneration).toBe(1);
    expect(renewed.reconcileGeneration).toBeGreaterThan(first.reconcileGeneration);
    const reconnected = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      runnerBootId: bootOne,
      runnerConnectionGeneration: 2,
      runnerId: fixture.runnerId,
    });
    expect(reconnected.activations[0]?.activation.runnerConnectionGeneration).toBe(2);
    await expect(
      triggers.applyWatchStatus({
        activationId: reconnected.activations[0]!.activation.id,
        executionGeneration: 1,
        healthySince: null,
        lastError: "stale connection",
        lastExitCode: 1,
        observed: "backoff",
        restartCount: 1,
        runnerBootId: bootOne,
        runnerConnectionGeneration: 1,
        runnerId: fixture.runnerId,
        stderrTail: "stale\n",
        stdoutTail: "",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      triggers.applyWatchStatus({
        activationId: reconnected.activations[0]!.activation.id,
        executionGeneration: 1,
        runnerBootId: bootOne,
        runnerConnectionGeneration: 3,
        runnerId: fixture.runnerId,
        observed: "stopped",
        healthySince: null,
        lastError: null,
        lastExitCode: null,
        restartCount: 0,
        stderrTail: "",
        stdoutTail: "",
      }),
    ).resolves.toMatchObject({ activation: { desired: "active", observed: "stopped" } });
    const restarted = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      runnerBootId: `watch-boot-two-${randomUUID()}`,
      runnerConnectionGeneration: 3,
      runnerId: fixture.runnerId,
    });
    expect(restarted.activations[0]?.activation).toMatchObject({
      executionGeneration: 2,
      observed: "starting",
      restartCount: 0,
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    await expect(
      triggers.assertActiveWatchBinding({
        activationId: restarted.activations[0]!.activation.id,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        executionGeneration: 2,
        revisionId: created.revision.id,
        triggerId: created.trigger.id,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("stops old watch activations for revision, pause, archive, and resume transitions", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, detail, triggers, database } = storeFixture;
    const fixture = await createFixture("watch-transitions");
    const created = await createWatchTrigger(fixture, "watch-transitions");
    const firstActivation = (await detail(created.trigger.id, fixture.userId)).activation!;
    const revised = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      ownerId: fixture.userId,
      script: {
        interpreter: null,
        text: "setInterval(() => {}, 1000);",
      },
      triggerId: created.trigger.id,
    });
    const secondActivation = (await detail(created.trigger.id, fixture.userId)).activation!;
    expect(secondActivation.id).not.toBe(firstActivation.id);
    expect(secondActivation.revisionId).toBe(revised.revision.id);
    expect(
      await database
        .selectFrom("triggerWatchActivations")
        .select(["desired", "observed"])
        .where("id", "=", firstActivation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      desired: "stopped",
      observed: "stopped",
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect((await detail(created.trigger.id, fixture.userId)).activation?.desired).toBe("stopped");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    const resumed = (await detail(created.trigger.id, fixture.userId)).activation!;
    expect(resumed.id).not.toBe(secondActivation.id);
    expect(resumed.desired).toBe("active");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "archived",
      triggerId: created.trigger.id,
    });
    expect((await detail(created.trigger.id, fixture.userId)).activation?.desired).toBe("stopped");
  });
  it("records an incompatible renewal without moving an already sent Watch's witness", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, triggers, detail } = storeFixture;
    const fixture = await createFixture("watch-renewal-unavailable");
    const created = await createWatchTrigger(fixture, "watch-renewal-unavailable");
    const binding = {
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: `watch-boot-${randomUUID()}`,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    };
    const snapshot = await triggers.reconcileWatchesForRunner(binding);
    const activation = snapshot.activations[0]!.activation;
    const renewal = await triggers.reconcileWatchesForRunner({
      ...binding,
      runnerConnectionGeneration: 2,
      unavailableReason: "The Runner cannot renew the Watch",
    });
    expect(renewal).toMatchObject({ activations: [], unavailable: true });
    expect((await detail(created.trigger.id, fixture.userId)).activation).toMatchObject({
      id: activation.id,
      executionGeneration: activation.executionGeneration,
      runnerId: binding.runnerId,
      runnerBootId: binding.runnerBootId,
      runnerConnectionGeneration: binding.runnerConnectionGeneration,
      healthySince: null,
      lastError: "The Runner cannot renew the Watch",
      leaseExpiresAt: null,
      observed: "backoff",
    });
  });
  it("resets a healthy watch failure window and keeps crash-looping watches active with backoff (Y10)", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, triggers, detail, database } = storeFixture;
    const fixture = await createFixture("watch-crash-loop");
    const created = await createWatchTrigger(fixture, "watch-crash-loop");
    const bootId = `watch-boot-${randomUUID()}`;
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: bootId,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activation = snapshot.activations[0]!.activation;
    const report = (
      restartCount: number,
      healthySince: Date | null,
      observed: "backoff" | "running" | "stopped",
    ) =>
      triggers.applyWatchStatus({
        activationId: activation.id,
        executionGeneration: activation.executionGeneration,
        healthySince,
        lastError: observed === "backoff" ? "program exited" : null,
        lastExitCode: observed === "backoff" ? 1 : null,
        observed,
        restartCount,
        runnerBootId: bootId,
        runnerConnectionGeneration: 1,
        runnerId: fixture.runnerId,
        stderrTail: "failed\n",
        stdoutTail: "",
      });
    await report(2, null, "backoff");
    const healthy = await report(2, new Date(Date.now() - 11 * 60_000), "running");
    expect(healthy.activation.consecutiveFailures).toBe(0);
    expect((await report(3, null, "backoff")).activation.desired).toBe("active");
    expect((await report(4, null, "backoff")).activation.desired).toBe("active");
    expect((await report(5, null, "backoff")).activation.desired).toBe("active");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: null,
      status: "active",
    });
    const keptActive = await report(6, null, "backoff");
    expect(keptActive.activation).toMatchObject({
      consecutiveFailures: 4,
      desired: "active",
      observed: "backoff",
    });
    const row = await database
      .selectFrom("triggers")
      .select(["watchCrashNotifiedAt", "failingSince"])
      .where("id", "=", created.trigger.id)
      .executeTakeFirstOrThrow();
    expect(row.watchCrashNotifiedAt).not.toBeNull();
    expect(row.failingSince).not.toBeNull();
  });
  it("enforces FIFO one-firing-at-a-time for webhooks, schedule overruns, 100-firing output pruning, and runner removal pause (T8/T10/Y6/Y11)", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, store, database, complete } =
      storeFixture;
    const fixture = await createFixture("commit5-fuses");

    // 1. Webhooks queue FIFO and only the head firing appears in listPendingCommands (Y11)
    const hook = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "fifo-hook",
      name: "FIFO hook",
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_fifo_hook_123456789012345678901234",
    });
    const wh1 = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        rawBody: Buffer.from("one", "utf8"),
        routeKey: hook.trigger.webhookRouteKey!,
      })
    ).occurrence;
    const wh2 = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        rawBody: Buffer.from("two", "utf8"),
        routeKey: hook.trigger.webhookRouteKey!,
      })
    ).occurrence;
    // AA2: One-firing-at-a-time and FIFO order are enforced at trigger claim, not listPendingCommands.
    expect(await store.claimCommand(wh2.commandId, "fifo-dispatcher")).toBeNull();
    expect(await store.claimCommand(wh1.commandId, "fifo-dispatcher")).not.toBeNull();
    const wh1Started = await triggers.startExecution({
      commandId: wh1.commandId,
      runnerBootId: "boot-fifo",
      runnerId: fixture.runnerId,
    });
    expect(await store.claimCommand(wh2.commandId, "fifo-dispatcher")).toBeNull();

    await triggers.completeExecution({
      executionGeneration: wh1Started.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: wh1.id,
        result: { ok: 1 },
        status: "succeeded",
        stderr: "",
        stdout: "one",
      },
      runnerBootId: "boot-fifo",
      runnerId: fixture.runnerId,
    });
    const wh2Claimed = await store.claimCommand(wh2.commandId, "fifo-dispatcher");
    expect(wh2Claimed).not.toBeNull();
    const wh2Started = await triggers.startExecution({
      commandId: wh2.commandId,
      runnerBootId: "boot-fifo",
      runnerId: fixture.runnerId,
    });
    await triggers.completeExecution({
      executionGeneration: wh2Started.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: wh2.id,
        result: { ok: 2 },
        status: "succeeded",
        stderr: "",
        stdout: "two",
      },
      runnerBootId: "boot-fifo",
      runnerId: fixture.runnerId,
    });

    // 2. Schedule overrun while running enqueues ONE waiting firing, collapses further ticks,
    // blocks the waiting firing until the running one ends, and emits one 'overran-schedule' notice (T10 / AA8)
    const sched = await createScheduleTrigger(fixture, "overrun-sched");
    const firstTick = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: sched.trigger.id,
    });
    await store.claimCommand(firstTick.commandId, "overrun-dispatcher");
    const firstStarted = await triggers.startExecution({
      commandId: firstTick.commandId,
      runnerBootId: "boot-overrun",
      runnerId: fixture.runnerId,
    });
    const pastFire = new Date(Date.now() - 60_000);
    await database
      .updateTable("triggers")
      .set({ nextFireAt: pastFire })
      .where("id", "=", sched.trigger.id)
      .execute();
    const overrun1 = await triggers.claimDueSchedules(new Date());
    const waiting = overrun1.occurrences.filter((o) => o.triggerId === sched.trigger.id);
    expect(waiting).toHaveLength(1);
    const waitingOccurrence = waiting[0]!;
    // Waiting firing cannot be claimed while firstTick is still running (AA2 / AA8).
    expect(await store.claimCommand(waitingOccurrence.commandId, "overrun-dispatcher")).toBeNull();
    const overrunNotices1 = await database
      .selectFrom("automationFailureNotices")
      .select(["reason"])
      .where("triggerId", "=", sched.trigger.id)
      .execute();
    expect(overrunNotices1).toEqual([{ reason: "overran-schedule" }]);
    // Second due time while still running collapses into the single waiting firing without a duplicate notice.
    await database
      .updateTable("triggers")
      .set({ nextFireAt: new Date(Date.now() - 30_000) })
      .where("id", "=", sched.trigger.id)
      .execute();
    const overrun2 = await triggers.claimDueSchedules(new Date());
    expect(overrun2.occurrences.filter((o) => o.triggerId === sched.trigger.id)).toEqual([]);
    const overrunNotices2 = await database
      .selectFrom("automationFailureNotices")
      .select(["reason"])
      .where("triggerId", "=", sched.trigger.id)
      .execute();
    expect(overrunNotices2).toHaveLength(1);
    await triggers.completeExecution({
      executionGeneration: firstStarted.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: firstTick.id,
        result: null,
        status: "succeeded",
        stderr: "",
        stdout: "",
      },
      runnerBootId: "boot-overrun",
      runnerId: fixture.runnerId,
    });
    // Once the running firing finishes, the single waiting firing can now be claimed.
    expect(
      await store.claimCommand(waitingOccurrence.commandId, "overrun-dispatcher"),
    ).not.toBeNull();
    await complete(fixture, waitingOccurrence, "succeeded", "overrun-waiting");

    // 3. 100-firing output pruning (T10): keep 100 most recent outputs, prune older without deleting rows
    const principal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    const pruneBase = new Date(Date.now() - 200_000);
    for (let i = 0; i < 101; i += 1) {
      const cmdId = createId("command");
      const occId = createId("triggerOccurrence");
      const at = new Date(pruneBase.getTime() + i * 1_000);
      await database
        .insertInto("commands")
        .values({
          actorPrincipalId: principal.id,
          authoritySource: { kind: "user-session", userId: fixture.userId },
          createdAt: at,
          dispatcherId: null,
          environmentId: fixture.environmentId,
          id: cmdId,
          idempotencyKey: `prune-cmd-${i}-${randomUUID()}`,
          lastError: null,
          payload: { occurrenceId: occId, type: "trigger.execute" },
          requestedBy: fixture.userId,
          runId: null,
          status: "succeeded",
          threadId: fixture.threadId,
          type: "trigger.execute",
          updatedAt: at,
        })
        .execute();
      await database
        .insertInto("triggerOccurrences")
        .values({
          commandId: cmdId,
          completedAt: at,
          createdAt: at,
          environmentId: fixture.environmentId,
          error: null,
          event: {
            id: occId,
            payload: null,
            receivedAt: at.toISOString(),
            source: { kind: "manual" },
            trigger: {
              anchorThreadId: fixture.threadId,
              id: hook.trigger.id,
              revisionId: hook.revision.id,
            },
          },
          executionGeneration: 1,
          exitCode: 0,
          id: occId,
          result: { i },
          revisionId: hook.revision.id,
          runnerBootId: "boot-prune",
          runnerId: fixture.runnerId,
          sourceKey: `prune:${i}`,
          startedAt: at,
          status: "succeeded",
          stderr: `err-${i}`,
          stdout: `out-${i}`,
          triggerId: hook.trigger.id,
          updatedAt: at,
          webhookBody: Buffer.from(`body-${i}`, "utf8"),
        })
        .execute();
    }
    const trigger102 = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        rawBody: Buffer.from("latest-body", "utf8"),
        routeKey: hook.trigger.webhookRouteKey!,
      })
    ).occurrence;
    await complete(fixture, trigger102, "succeeded", "prune-102");
    const hookOccurrences = await database
      .selectFrom("triggerOccurrences")
      .select(["id", "stdout", "stderr", "result", "webhookBody", "outputPrunedAt"])
      .where("triggerId", "=", hook.trigger.id)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .execute();
    expect(hookOccurrences).toHaveLength(104); // 2 from step 1 + 101 seeded + 1 latest
    const pruned = hookOccurrences.filter((row) => row.outputPrunedAt !== null);
    const retained = hookOccurrences.filter((row) => row.outputPrunedAt === null);
    expect(retained).toHaveLength(100);
    expect(pruned).toHaveLength(4);
    for (const row of pruned) {
      expect(row.stdout).toBe("");
      expect(row.stderr).toBe("");
      expect(row.result).toBeNull();
      expect(row.webhookBody).toBeNull();
    }

    // 4. Removing a computer pauses its automations and settles running firings to unknown (Y6)
    await database
      .updateTable("runners")
      .set({ kind: "local", ownerKind: "user", ownerUserId: fixture.userId })
      .where("id", "=", fixture.runnerId)
      .execute();
    const runningBeforeRemove = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: sched.trigger.id,
    });
    await store.claimCommand(runningBeforeRemove.commandId, "remove-dispatcher");
    await triggers.startExecution({
      commandId: runningBeforeRemove.commandId,
      runnerBootId: "boot-before-remove",
      runnerId: fixture.runnerId,
    });
    await store.revokeRunner(fixture.runnerId, fixture.userId);
    const pausedByRemove = await database
      .selectFrom("triggers")
      .select(["status", "pauseReason", "pausedBy", "nextFireAt"])
      .where("id", "=", sched.trigger.id)
      .executeTakeFirstOrThrow();
    expect(pausedByRemove).toEqual({
      nextFireAt: null,
      pauseReason: "Paused because its computer was removed.",
      pausedBy: "system",
      status: "paused",
    });
    const settledRunning = await database
      .selectFrom("triggerOccurrences")
      .select(["status", "contactLostAt"])
      .where("id", "=", runningBeforeRemove.id)
      .executeTakeFirstOrThrow();
    expect(settledRunning.status).toBe("unknown");
    expect(settledRunning.contactLostAt).not.toBeNull();
  });
  it("admits live watch tool calls and deduplicates retries by idempotencyKey without an observation ledger (AA7)", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, triggers, store, database } = storeFixture;
    const fixture = await createFixture("watch-admission");
    const first = await createWatchTrigger(fixture, "watch-admission-first");
    const second = await createWatchTrigger(fixture, "watch-admission-second");
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: `watch-boot-${randomUUID()}`,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activations = new Map(
      snapshot.activations.map(({ activation }) => [activation.triggerId, activation]),
    );
    const firstActivation = activations.get(first.trigger.id)!;
    const request = (activation: typeof firstActivation, requestId: string) => ({
      action: "thread.message" as const,
      activationId: activation.id,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      executionGeneration: activation.executionGeneration,
      requestFingerprint: "a".repeat(64),
      requestId,
      revisionId: activation.revisionId,
      triggerId: activation.triggerId,
    });
    const firstRequest = request(firstActivation, "request-1");
    const firstInput = await store.enqueueAdmittedThreadInput({
      admission: {
        kind: "watch",
        request: firstRequest,
      },
      input: {
        content: [
          {
            text: "One filesystem observation",
            type: "text",
          },
        ],
        idempotencyKey: `watch:${firstActivation.id}:op-1:message`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          activationId: firstActivation.id,
          kind: "watch",
          observationId: "op-1",
          revisionId: firstActivation.revisionId,
          triggerId: firstActivation.triggerId,
        },
        threadId: fixture.threadId,
      },
    });
    const duplicateInput = await store.enqueueAdmittedThreadInput({
      admission: {
        kind: "watch",
        request: {
          ...firstRequest,
          requestId: "request-2",
        },
      },
      input: {
        content: [
          {
            text: "One filesystem observation",
            type: "text",
          },
        ],
        idempotencyKey: `watch:${firstActivation.id}:op-1:message`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          activationId: firstActivation.id,
          kind: "watch",
          observationId: "op-1",
          revisionId: firstActivation.revisionId,
          triggerId: firstActivation.triggerId,
        },
        threadId: fixture.threadId,
      },
    });
    expect(duplicateInput.message.id).toBe(firstInput.message.id);
    expect(duplicateInput.input.causalChainId).toBe(firstInput.input.causalChainId);
    const secondActivation = activations.get(second.trigger.id)!;
    await expect(
      admitWatchControlRequest(database, request(secondActivation, "other-watch")),
    ).resolves.toEqual({
      wasDuplicate: false,
    });
  });

  it("serializes concurrent updateEncryptedSecrets under a row lock and returns identical not_found for missing vs out-of-reach (AA9)", async ({
    storeFixture,
  }) => {
    const { createFixture, triggers } = storeFixture;
    const fixture = await createFixture("secrets-atomic");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "secrets-atomic",
      name: "Secrets hook",
      script: { interpreter: null, text: "console.log('ok')" },
      source: { kind: "webhook" },
      webhookRouteKey: "whk_secrets_atomic_12345678901234567890123",
    });

    const mergeJson = (current: Buffer | null, key: string, value: string) => {
      const parsed = current
        ? (JSON.parse(current.toString("utf8")) as Record<string, string>)
        : {};
      parsed[key] = value;
      return {
        result: Object.keys(parsed).sort(),
        sealed: { envelope: Buffer.from(JSON.stringify(parsed), "utf8"), keyVersion: 1 },
      };
    };

    let releaseFirst!: () => void;
    let enteredFirstLock!: () => void;
    const firstLocked = new Promise<void>((resolve) => {
      enteredFirstLock = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = triggers.updateEncryptedSecrets({
      actorThreadId: null,
      ownerId: fixture.userId,
      transform: async (current) => {
        enteredFirstLock();
        await withTimeout(gate, 5_000, {
          timeoutError: () => new Error("First secret patch never released"),
        });
        return mergeJson(current, "FIRST", "one");
      },
      triggerId: created.trigger.id,
    });
    await withTimeout(firstLocked, 5_000, {
      timeoutError: () => new Error("First secret patch never acquired row lock"),
    });
    const p2 = triggers.updateEncryptedSecrets({
      actorThreadId: null,
      ownerId: fixture.userId,
      transform: async (current) => mergeJson(current, "SECOND", "two"),
      triggerId: created.trigger.id,
    });
    // Wait until p2 is blocked on the FOR NO KEY UPDATE lock behind p1 before releasing p1.
    await vi.waitFor(
      async () => {
        const waiting = await sql<{ pid: number }>`
          select pid from pg_locks where not granted
        `.execute(storeFixture.database);
        expect(waiting.rows.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    releaseFirst();

    await Promise.all([p1, p2]);
    const finalEnvelope = await triggers.getEncryptedSecrets(fixture.userId, created.trigger.id);
    expect(JSON.parse(finalEnvelope!.toString("utf8"))).toEqual({
      FIRST: "one",
      SECOND: "two",
    });

    // Rule 5: missing automation and another owner's automation produce identical not_found errors.
    const foreignOwnerId = createId("user");
    const missingErr = await triggers
      .updateEncryptedSecrets({
        actorThreadId: null,
        ownerId: foreignOwnerId,
        transform: async (current) => mergeJson(current, "X", "1"),
        triggerId: createId("trigger"),
      })
      .catch((error: unknown) => error);
    const foreignErr = await triggers
      .updateEncryptedSecrets({
        actorThreadId: null,
        ownerId: foreignOwnerId,
        transform: async (current) => mergeJson(current, "X", "1"),
        triggerId: created.trigger.id,
      })
      .catch((error: unknown) => error);
    expect(missingErr).toMatchObject({ code: "not_found", message: "Trigger not found" });
    expect(foreignErr).toMatchObject({ code: "not_found", message: "Trigger not found" });
    expect((foreignErr as Error).message).toBe((missingErr as Error).message);
  });

  it("records true pausedBy for person, agent, connected agent, and authority-loss pauses (AA6)", async ({
    storeFixture,
  }) => {
    const { createFixture, database, triggers } = storeFixture;
    const fixture = await createFixture("paused-by-truth");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "paused-by-truth",
      name: "Paused by truth",
      script: { interpreter: null, text: "console.log('ok')" },
      source: {
        kind: "schedule",
        schedule: { expression: "*/5 * * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const readPaused = () =>
      database
        .selectFrom("triggers")
        .select(["pausedBy", "pausedByConnectionId", "pausedByThreadId", "pausedAt"])
        .where("id", "=", created.trigger.id)
        .executeTakeFirstOrThrow();

    // 1. Person pause
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(await readPaused()).toMatchObject({
      pausedAt: expect.any(Date),
      pausedBy: "person",
      pausedByConnectionId: null,
      pausedByThreadId: null,
    });

    // 2. Agent pause
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    await triggers.setStatus({
      actorAccessMode: "full-access",
      actorThreadId: fixture.threadId,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(await readPaused()).toMatchObject({
      pausedAt: expect.any(Date),
      pausedBy: "agent",
      pausedByConnectionId: null,
      pausedByThreadId: fixture.threadId,
    });

    // 3. Connected agent pause (never recorded as "person"!)
    const connectionId = `agc_${randomUUID()}`;
    const now = new Date();
    await database
      .insertInto("agentConnections")
      .values({
        accessMode: "full-access",
        clientName: "External Agent",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
        grant: { scope: "everything" },
        grantRevision: 1,
        id: connectionId,
        label: "External Agent",
        lastUsedAt: null,
        resource: "https://opensteer.test/mcp",
        revokedAt: null,
        tokenHash: "sha256-live-agent-token",
        userId: fixture.userId,
      })
      .execute();
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    await triggers.setStatus({
      actorAccessMode: "full-access",
      actorConnectionId: connectionId,
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(await readPaused()).toMatchObject({
      pausedAt: expect.any(Date),
      pausedBy: "connection",
      pausedByConnectionId: connectionId,
      pausedByThreadId: null,
    });

    // 4. Authority-loss pause in claimDueSchedules sets pausedBy: "system" + pausedAt
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    await database
      .updateTable("threads")
      .set({ doneAt: new Date(), status: "archived" })
      .where("id", "=", fixture.threadId)
      .execute();
    await database
      .updateTable("triggers")
      .set({ nextFireAt: new Date(Date.now() - 1_000) })
      .where("id", "=", created.trigger.id)
      .execute();
    await triggers.claimDueSchedules(new Date());
    expect(await readPaused()).toMatchObject({
      pausedAt: expect.any(Date),
      pausedBy: "system",
      pausedByConnectionId: null,
      pausedByThreadId: null,
    });
  });

  it("lets a person settle a contact-lost personal firing to unknown so later firings can proceed (AA12)", async ({
    storeFixture,
  }) => {
    const { createFixture, database, store, triggers } = storeFixture;
    const fixture = await createFixture("contact-lost-personal");
    const routeKey = "whk_contact_lost_personal_123456789012345678";
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "contact-lost-personal",
      name: "Contact-lost personal webhook",
      script: { interpreter: null, text: "console.log('ok')" },
      source: { kind: "webhook" },
      webhookRouteKey: routeKey,
    });
    const first = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey,
      })
    ).occurrence;
    const second = (
      await triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey,
      })
    ).occurrence;
    await store.claimCommand(first.commandId, "lost-dispatcher");
    await triggers.startExecution({
      commandId: first.commandId,
      runnerBootId: "boot-lost-forever",
      runnerId: fixture.runnerId,
    });

    // Computer disconnects and never comes back: personal firing gets contactLostAt stamped.
    await store.markConnectionAttemptsContactLost({
      runnerBootId: "boot-lost-forever",
      runnerId: fixture.runnerId,
    });
    const lost = await database
      .selectFrom("triggerOccurrences")
      .select(["status", "contactLostAt"])
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(lost.status).toBe("running");
    expect(lost.contactLostAt).not.toBeNull();
    // Second firing is blocked while first is still running.
    expect(await store.claimCommand(second.commandId, "lost-dispatcher")).toBeNull();

    // Ending the stuck contact-lost firing settles it to unknown and unblocks the second firing.
    const ended = await triggers.cancelPendingOccurrences(fixture.userId, {
      actorThreadId: null,
      occurrenceId: first.id,
      triggerId: created.trigger.id,
    });
    expect(ended.canceledOccurrenceIds).toEqual([first.id]);
    const settled = await database
      .selectFrom("triggerOccurrences")
      .select(["status", "completedAt"])
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe("unknown");
    expect(settled.completedAt).not.toBeNull();
    expect(await store.claimCommand(second.commandId, "lost-dispatcher")).not.toBeNull();
  });

  it("returns identical 404 from enqueueWebhook when the anchor task loses authority (AA14.3)", async ({
    storeFixture,
  }) => {
    const { createFixture, database, triggers } = storeFixture;
    const fixture = await createFixture("webhook-lost-authority");
    const routeKey = "whk_lost_authority_123456789012345678901234";
    await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "webhook-lost-authority",
      name: "Lost authority webhook",
      script: { interpreter: null, text: "console.log('ok')" },
      source: { kind: "webhook" },
      webhookRouteKey: routeKey,
    });
    // Revoke the anchor task's hosting runner so execution authority no longer holds.
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", fixture.runnerId)
      .execute();

    await expect(
      triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        routeKey,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Webhook not found",
    });
  });

  /**
   * Marks a Run running without dispatching it, with the grant a dispatched
   * Run holds: only a Run whose authority stands takes a steer.
   */
});
