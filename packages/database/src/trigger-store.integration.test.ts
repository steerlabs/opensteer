import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type TriggerId,
} from "@opensteer/core";
import type { RunnerDescriptor } from "@opensteer/protocol";
import {
  MAX_ACTIVE_WATCHES_PER_ENVIRONMENT,
  TRIGGER_AUTO_PAUSE_REASON,
  WATCH_AUTO_PAUSE_REASON,
  WATCH_OBSERVATIONS_PER_HOUR,
  type TriggerOccurrence,
} from "@opensteer/triggers";
import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { OpensteerStore, TriggerStore, admitWatchControlRequest, createDatabase } from "./index.js";
import { withDatabaseTransaction } from "./connection.js";
import { issueRunGrant } from "./run-grants.js";
import { jsonValue } from "./store-primitives.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
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
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const triggers = new TriggerStore(database);
    async function stagedTriggerEdge(
      firstTable:
        "trigger_occurrences" | "triggers" | "execution_environments" | "runs" | "workspaces",
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
              await sql<{ query: string }>`
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
      fixture: { readonly runnerId: ReturnType<typeof createId<"runner">> },
      runId: ReturnType<typeof createId<"run">>,
      set: { readonly createdAt?: Date } = {},
    ) {
      // Bound as a dispatch binds it: the Run's session names the Runner holding it.
      const run = await database
        .updateTable("runs")
        .set({ ...set, bindingGeneration: 1, status: "running" })
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
      await withDatabaseTransaction(database, (transaction) =>
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
      const userId = await store.createUser(`Trigger owner ${suffix}`);
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      if (!(await store.getDeployment())) {
        await store.ensureDeployment({
          canonicalOrigin: "https://test-host.invalid",
          hostInstanceId: createId("hostInstance"),
          deploymentShape: {
            defaultWorkspaceBacking: "portablefs",
            kind: "server" as const,
          },
        });
      }
      await enrollRunner({ environmentId, runnerId, suffix, userId });
      const workspace = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: `wsp_trigger_failure_${suffix}`,
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: userId,
        idempotencyKey: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
        status: "ready",
      });
      const harness = await store.createHarnessInstance({
        config: { model: "test" },
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
        workspaceId: workspace.id,
      });
      return {
        environmentId,
        harnessInstanceId: harness.id,
        runnerId,
        threadId: thread.id,
        userId,
        workspaceId: workspace.id,
      };
    }
    async function enrollRunner(input: {
      readonly environmentId: ReturnType<typeof createId<"environment">>;
      readonly runnerId: ReturnType<typeof createId<"runner">>;
      readonly suffix: string;
      readonly userId: ReturnType<typeof createId<"user">>;
    }) {
      const pair = generateKeyPairSync("ed25519");
      const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
      const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
      const enrollmentTokenHash = `sha256:${createHash("sha256")
        .update(`trigger-failure-${input.suffix}`, "utf8")
        .digest("base64url")}`;
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
            localStorage: null,
            maxConcurrentRuns: 4,
            providerStateModes: ["isolated"],
            workspaceBackings: ["portablefs"],
            workspaceMounts: [],
          },
        },
        name: "Trigger test Runner",
        runnerId: input.runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      };
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: input.userId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `trigger-runner-${input.suffix}`,
        mainEnrollmentPurpose: "initial",
        name: descriptor.name,
        requestFingerprint: `sha256:trigger-runner-${input.suffix}`,
        runnerKind: "main",
        tokenHash: enrollmentTokenHash,
      });
      await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash,
        publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
        publicKeyPem,
      });
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
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default async () => null",
        },
        source: {
          kind: "schedule",
          schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
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
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default async () => new Promise(() => setInterval(() => {}, 1000))",
        },
        source: { kind: "watch" },
      });
    }
    async function detail(triggerId: TriggerId, userId: ReturnType<typeof createId<"user">>) {
      const value = await triggers.getForOwner(triggerId, userId, 25, { kind: "user" });
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
          result: status === "succeeded" ? { ok: true } : null,
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
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
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
            result: { ok: true },
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
      content: [{ text: "Existing work", type: "text" }],
      idempotencyKey: "input-occurrence-work",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
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
        content: [{ text: "Observed change", type: "text" }],
        idempotencyKey: "input-occurrence-observation",
        policy: "steer",
        requestedBy: fixture.userId,
        source: { kind: "trigger", occurrenceId: occurrence.id },
        threadId: fixture.threadId,
      }),
    );
  });

  it("fences the Workspace before an admitted Watch input source", async ({ storeFixture }) => {
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
      "workspaces",
      fixture.workspaceId,
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
              membershipGeneration: 1,
              observationId: "input-watch",
              requestFingerprint: "a".repeat(64),
              requestId: "input-watch",
              revisionId: created.revision.id,
              triggerId: created.trigger.id,
              workspaceId: fixture.workspaceId,
            },
          },
          input: {
            content: [{ text: "Watch observation", type: "text" }],
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

  it("fences revocation Occurrences before their Trigger mutations", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, triggers, store, database, stagedTriggerEdge } =
      storeFixture;
    const fixture = await createFixture("revocation-occurrence-order");
    const created = await createScheduleTrigger(fixture, "revocation-occurrence-order");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const replacement = await store.createUser("Replacement owner");
    const membership = await database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", fixture.workspaceId)
      .where("userId", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("workspaceMemberships")
      .values({ ...membership, id: createId("workspaceMembership"), userId: replacement })
      .execute();
    const revoked = await database
      .updateTable("workspaceMemberships")
      .set({
        state: "revoked",
        generation: sql`generation + 1`,
        revokedAt: new Date(),
        revokedBy: replacement,
        updatedAt: new Date(),
      })
      .where("id", "=", membership.id)
      .returning("generation")
      .executeTakeFirstOrThrow();
    await stagedTriggerEdge(
      "trigger_occurrences",
      occurrence.id,
      "triggers",
      created.trigger.id,
      () =>
        triggers.revokeForMembershipRevocation({
          membershipGeneration: Number(revoked.generation),
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
        }),
    );
    expect(
      await database
        .selectFrom("triggers")
        .select("status")
        .where("id", "=", created.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "archived" });
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
          program: {
            toolContractVersion: 2,
            language: "javascript",
            source: "export default async () => new Promise(() => {})",
          },
        }),
    );
    expect((await detail(created.trigger.id, fixture.userId)).trigger.currentRevisionId).not.toBe(
      created.revision.id,
    );
  });

  it("pauses an active schedule after three current-Revision failures", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, detail } = storeFixture;
    const fixture = await createFixture("three-failures");
    const created = await createScheduleTrigger(fixture, "three-failures");

    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 2,
      pauseReason: null,
      status: "active",
    });

    await failManual(fixture, created.trigger.id, "third");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 3,
      nextFireAt: null,
      pauseReason: TRIGGER_AUTO_PAUSE_REASON,
      status: "paused",
    });
  });

  it("resets the consecutive count when a success interrupts failures", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers, detail, succeedManual } =
      storeFixture;
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
    expect((await detail(created.trigger.id, fixture.userId)).trigger.consecutiveFailures).toBe(1);
    await succeedManual(fixture, created.trigger.id, "success");
    expect((await detail(created.trigger.id, fixture.userId)).trigger.consecutiveFailures).toBe(0);

    await failManual(fixture, created.trigger.id, "second-series-1");
    await failManual(fixture, created.trigger.id, "second-series-2");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 2,
      status: "active",
    });
  });

  it("does not count a failed occurrence pinned to a stale Revision", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, triggers, complete, detail } = storeFixture;
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
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => 'new'",
      },
      triggerId: created.trigger.id,
    });

    await complete(fixture, occurrence, "failed", "stale-failure");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 0,
      status: "active",
    });
  });

  it("keeps a legacy create fingerprint stable after later Trigger edits", async ({
    storeFixture,
  }) => {
    const { createFixture, triggers } = storeFixture;
    const fixture = await createFixture("legacy-create-retry");
    const original = {
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "legacy-create-retry",
      name: "Legacy schedule",
      program: {
        language: "javascript" as const,
        source: "export default async () => null",
        toolContractVersion: 1 as const,
      },
      source: {
        kind: "schedule" as const,
        schedule: { expression: "0 9 * * *", kind: "cron" as const, timezone: "UTC" },
      },
    };
    const created = await triggers.create(original);
    await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      name: "Renamed later",
      ownerId: fixture.userId,
      program: {
        language: "javascript",
        source: "export default async () => 'changed'",
        toolContractVersion: 1,
      },
      triggerId: created.trigger.id,
    });

    await expect(triggers.create(original)).resolves.toMatchObject({
      trigger: { id: created.trigger.id },
      wasDuplicate: true,
    });
    await expect(
      triggers.create({ ...original, name: "Altered create payload" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      triggers.create({
        ...original,
        program: { ...original.program, toolContractVersion: 2 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows a manual run while paused and resets the count after success", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, succeedManual, detail } =
      storeFixture;
    const fixture = await createFixture("paused-manual");
    const created = await createScheduleTrigger(fixture, "paused-manual");
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");

    await succeedManual(fixture, created.trigger.id, "repair-check");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 0,
      pauseReason: TRIGGER_AUTO_PAUSE_REASON,
      status: "paused",
    });
  });

  it("counts an in-flight failure without changing an already paused Trigger", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, complete, detail } = storeFixture;
    const fixture = await createFixture("already-paused");
    const created = await createScheduleTrigger(fixture, "already-paused");
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });

    await complete(fixture, occurrence, "failed", "already-paused");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 1,
      pauseReason: null,
      status: "paused",
    });

    const archived = await createScheduleTrigger(fixture, "already-archived");
    const archivedOccurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: archived.trigger.id,
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "archived",
      triggerId: archived.trigger.id,
    });
    await complete(fixture, archivedOccurrence, "failed", "already-archived");
    expect((await detail(archived.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 1,
      pauseReason: null,
      status: "archived",
    });
  });

  it("clears the auto-pause reason and recomputes a schedule when resumed", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers } = storeFixture;
    const fixture = await createFixture("resume");
    const created = await createScheduleTrigger(fixture, "resume");
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");

    const resumed = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    expect(resumed).toMatchObject({
      consecutiveFailures: 0,
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

  it("resets failures on a program update but not a name-only update", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers } = storeFixture;
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
    expect(renamed.trigger.consecutiveFailures).toBe(1);

    const repaired = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: renamed.revision.id,
      ownerId: fixture.userId,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => 'fixed'",
      },
      triggerId: created.trigger.id,
    });
    expect(repaired.trigger.consecutiveFailures).toBe(0);

    await failManual(fixture, created.trigger.id, "after-program-update");
    const rescheduled = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: repaired.revision.id,
      ownerId: fixture.userId,
      source: {
        kind: "schedule",
        schedule: { expression: "30 9 * * *", kind: "cron", timezone: "UTC" },
      },
      triggerId: created.trigger.id,
    });
    expect(rescheduled.trigger.consecutiveFailures).toBe(0);
  });

  it("refuses webhook ingress while auto-paused", async ({ storeFixture }) => {
    const { createFixture, triggers, failManual } = storeFixture;
    const fixture = await createFixture("paused-webhook");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "paused-webhook",
      name: "Paused webhook",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_paused_webhook_123456789012345678",
      webhookSecretHash: "a".repeat(64),
    });
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");

    await expect(
      triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        payload: null,
        routeKey: created.trigger.webhookRouteKey ?? "",
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "Webhook Trigger is not active" });
  });

  it("does not reset the count when a stale-Revision occurrence succeeds", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, failManual, complete, detail } =
      storeFixture;
    const fixture = await createFixture("stale-success");
    const created = await createScheduleTrigger(fixture, "stale-success");
    const stale = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      ownerId: fixture.userId,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => 'new'",
      },
      triggerId: created.trigger.id,
    });
    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");

    await complete(fixture, stale, "succeeded", "stale-success");
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 2,
      status: "active",
    });
  });

  it("treats a repeated status as a no-op that keeps the reason and the count", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, failManual, triggers } = storeFixture;
    const fixture = await createFixture("repeat-status");
    const created = await createScheduleTrigger(fixture, "repeat-status");
    await failManual(fixture, created.trigger.id, "first");
    const stillActive = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    expect(stillActive.consecutiveFailures).toBe(1);

    await failManual(fixture, created.trigger.id, "second");
    await failManual(fixture, created.trigger.id, "third");
    const stillPaused = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });
    expect(stillPaused).toMatchObject({
      consecutiveFailures: 3,
      pauseReason: TRIGGER_AUTO_PAUSE_REASON,
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
    ).rejects.toMatchObject({ code: "bad_request" });
    expect((await detail(created.trigger.id, fixture.userId)).revision.id).toBe(
      created.revision.id,
    );
  });

  it("counts concurrent completions exactly once each and pauses once", async ({
    storeFixture,
  }) => {
    const { createFixture, createScheduleTrigger, triggers, complete, detail } = storeFixture;
    const fixture = await createFixture("concurrent");
    const created = await createScheduleTrigger(fixture, "concurrent");
    const occurrences = await Promise.all(
      ["a", "b", "c"].map(() =>
        triggers.enqueueManual({
          actorThreadId: null,
          ownerId: fixture.userId,
          triggerId: created.trigger.id,
        }),
      ),
    );

    await Promise.all(
      occurrences.map((occurrence, index) =>
        complete(fixture, occurrence, "failed", `concurrent-${index}`),
      ),
    );
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 3,
      nextFireAt: null,
      pauseReason: TRIGGER_AUTO_PAUSE_REASON,
      status: "paused",
    });
  });

  it("tracks failures independently for each Trigger", async ({ storeFixture }) => {
    const { createFixture, createScheduleTrigger, failManual, detail } = storeFixture;
    const fixture = await createFixture("per-trigger");
    const failing = await createScheduleTrigger(fixture, "per-trigger-failing");
    const unaffected = await createScheduleTrigger(fixture, "per-trigger-unaffected");
    await failManual(fixture, failing.trigger.id, "first");
    await failManual(fixture, failing.trigger.id, "second");
    await failManual(fixture, failing.trigger.id, "third");

    expect((await detail(failing.trigger.id, fixture.userId)).trigger.status).toBe("paused");
    expect((await detail(unaffected.trigger.id, fixture.userId)).trigger).toMatchObject({
      consecutiveFailures: 0,
      pauseReason: null,
      status: "active",
    });
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
      content: [{ text: "Summarize the inbox", type: "text" }],
      idempotencyKey: "downstream-first",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "trigger", occurrenceId: occurrence.id },
      threadId: fixture.threadId,
    });
    const second = await store.enqueueThreadInput({
      content: [{ text: "Check the calendar", type: "text" }],
      idempotencyKey: "downstream-second",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "trigger", occurrenceId: occurrence.id },
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
        result: { queued: true },
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
        run: expect.objectContaining({ id: first.run.id, status: "queued" }),
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
      content: [{ text: "Start older existing work", type: "text" }],
      idempotencyKey: "steered-downstream-older",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
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
      workspaceId: fixture.workspaceId,
    });
    const newer = await store.enqueueThreadInput({
      content: [{ text: "Start newer existing work", type: "text" }],
      idempotencyKey: "steered-downstream-newer",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: newerThread.thread.id,
    });
    if (!newer.run) throw new Error("Expected the newer existing Run");
    await markRunning(fixture, older.run.id, { createdAt: new Date("2020-01-01T00:00:00.000Z") });
    await markRunning(fixture, newer.run.id);
    await database
      .updateTable("threadInputs")
      .set({ runId: older.run.id, state: "claimed" })
      .where("messageId", "=", older.message.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threadInputs")
      .set({ runId: newer.run.id, state: "claimed" })
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
      content: [{ text: "One update for the older Run", type: "text" }],
      idempotencyKey: "steered-downstream-older-input",
      policy: "steer",
      requestedBy: fixture.userId,
      source: { kind: "trigger", occurrenceId: occurrence.id },
      threadId: fixture.threadId,
    });
    await database
      .updateTable("threadInputs")
      .set({ deliveredAt: new Date(), runId: older.run.id, state: "delivered" })
      .where("messageId", "=", olderSteer.message.id)
      .executeTakeFirstOrThrow();
    const steered = await store.enqueueThreadInput({
      content: [{ text: "Trigger update", type: "text" }],
      idempotencyKey: "steered-downstream-input-0",
      policy: "steer",
      requestedBy: fixture.userId,
      source: { kind: "trigger", occurrenceId: occurrence.id },
      threadId: newerThread.thread.id,
    });
    const occurrenceChainId = steered.input.causalChainId;
    expect(olderSteer.input.causalChainId).toBe(occurrenceChainId);
    const templateInput = await database
      .updateTable("threadInputs")
      .set({ deliveredAt: new Date(), runId: newer.run.id, state: "delivered" })
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
    const extra = Array.from({ length: 104 }, (_, index) => ({
      messageId: createId("message"),
      sequence: (BigInt(templateMessage.sequence) + BigInt(index) + 1n).toString(),
    }));
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("threads")
        .set({ nextMessageSequence: (BigInt(templateMessage.sequence) + 105n).toString() })
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
      content: [{ text: "Existing work 0", type: "text" }],
      idempotencyKey: "downstream-cap-existing-0",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.threadId,
    });
    if (!existing.run) throw new Error("Expected a distinct existing Run");
    const runIds = [existing.run.id];
    const steered = await store.enqueueThreadInput({
      content: [{ text: "Trigger update 0", type: "text" }],
      idempotencyKey: "downstream-cap-steer-0",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "trigger", occurrenceId: occurrence.id },
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
      .set({ deliveredAt: new Date(), runId: existing.run.id, state: "delivered" })
      .where("messageId", "=", existing.message.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ completedAt: new Date(), status: "completed" })
      .where("id", "=", existing.run.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threads")
      .set({ status: "idle" })
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
    const humanInput = templateInputs.find((input) => input.policy === "queue")!;
    const triggerInput = templateInputs.find((input) => input.policy === "steer")!;
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
    const extra = Array.from({ length: 100 }, (_, index) => ({
      createdAt: new Date(templateRun.createdAt.getTime() + index + 1),
      runOrdinal: templateRun.runOrdinal + index + 1,
      causalChainId: createId("causalChain"),
      runId: createId("run"),
      humanId: createId("message"),
      triggerId: createId("message"),
      humanSequence: (BigInt(triggerMessage.sequence) + BigInt(index * 2) + 1n).toString(),
      triggerSequence: (BigInt(triggerMessage.sequence) + BigInt(index * 2) + 2n).toString(),
    }));
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
    expect(initial.activation).toMatchObject({ desired: "active", executionGeneration: 0 });
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("triggerId", "=", created.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
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
    ).rejects.toMatchObject({ code: "forbidden" });
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
        membershipGeneration: 1,
        revisionId: created.revision.id,
        triggerId: created.trigger.id,
        workspaceId: fixture.workspaceId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
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
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => new Promise(() => setInterval(() => {}, 1000))",
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
    ).toEqual({ desired: "stopped", observed: "stopped" });

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

  it("stops a Runner's watch activations atomically with revocation", async ({ storeFixture }) => {
    const { createFixture, createWatchTrigger, store, detail } = storeFixture;
    const fixture = await createFixture("watch-runner-revocation");
    const created = await createWatchTrigger(fixture, "watch-runner-revocation");

    await store.revokeRunner(fixture.runnerId, fixture.userId, { allowDeployment: true });

    expect((await detail(created.trigger.id, fixture.userId)).activation).toMatchObject({
      desired: "stopped",
      leaseExpiresAt: null,
      observed: "stopped",
    });
  });

  it("records a Workspace access failure on the fenced watch activation", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, triggers, detail } = storeFixture;
    const fixture = await createFixture("watch-workspace-unavailable");
    const created = await createWatchTrigger(fixture, "watch-workspace-unavailable");
    const bootId = `watch-boot-${randomUUID()}`;
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: bootId,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activation = snapshot.activations[0]!.activation;

    await triggers.recordWatchUnavailable({
      activationId: activation.id,
      executionGeneration: activation.executionGeneration,
      reason: "Runner does not support portablefs Workspace access",
      runnerBootId: bootId,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });

    expect((await detail(created.trigger.id, fixture.userId)).activation).toMatchObject({
      healthySince: null,
      lastError: "Runner does not support portablefs Workspace access",
      leaseExpiresAt: null,
      observed: "backoff",
    });
    await expect(
      triggers.recordWatchUnavailable({
        activationId: activation.id,
        executionGeneration: activation.executionGeneration,
        reason: "stale failure",
        runnerBootId: bootId,
        runnerConnectionGeneration: 2,
        runnerId: fixture.runnerId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resets a healthy watch failure window and auto-pauses the next crash loop", async ({
    storeFixture,
  }) => {
    const { createFixture, createWatchTrigger, triggers, detail } = storeFixture;
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
      observed: "backoff" | "running",
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
    expect((await report(3, null, "backoff")).autoPaused).toBe(false);
    expect((await report(4, null, "backoff")).autoPaused).toBe(false);
    expect((await report(5, null, "backoff")).autoPaused).toBe(true);
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: WATCH_AUTO_PAUSE_REASON,
      status: "paused",
    });
    const stopped = await report(6, null, "backoff");
    expect(stopped.activation).toMatchObject({
      consecutiveFailures: 3,
      desired: "stopped",
      observed: "stopped",
    });
  });

  it("deduplicates observations and enforces an activation-local rolling limit", async ({
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
    const request = (
      activation: typeof firstActivation,
      observationId: string,
      requestId: string,
    ) => ({
      action: "thread.message" as const,
      activationId: activation.id,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      executionGeneration: activation.executionGeneration,
      membershipGeneration: 1,
      observationId,
      requestFingerprint: "a".repeat(64),
      requestId,
      revisionId: activation.revisionId,
      triggerId: activation.triggerId,
      workspaceId: fixture.workspaceId,
    });
    const firstRequest = request(firstActivation, "stable-1", "request-1");
    const firstInput = await store.enqueueAdmittedThreadInput({
      admission: { kind: "watch", request: firstRequest },
      input: {
        content: [{ text: "One filesystem observation", type: "text" }],
        idempotencyKey: `watch:${firstActivation.id}:stable-1:message`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          activationId: firstActivation.id,
          kind: "watch",
          observationId: "stable-1",
          revisionId: firstActivation.revisionId,
          triggerId: firstActivation.triggerId,
        },
        threadId: fixture.threadId,
      },
    });
    const duplicateInput = await store.enqueueAdmittedThreadInput({
      admission: { kind: "watch", request: { ...firstRequest, requestId: "request-2" } },
      input: {
        content: [{ text: "One filesystem observation", type: "text" }],
        idempotencyKey: `watch:${firstActivation.id}:stable-1:message`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          activationId: firstActivation.id,
          kind: "watch",
          observationId: "stable-1",
          revisionId: firstActivation.revisionId,
          triggerId: firstActivation.triggerId,
        },
        threadId: fixture.threadId,
      },
    });
    expect(duplicateInput.message.id).toBe(firstInput.message.id);
    expect(duplicateInput.input.causalChainId).toBe(firstInput.input.causalChainId);
    for (let index = 1; index < WATCH_OBSERVATIONS_PER_HOUR; index += 1) {
      await admitWatchControlRequest(
        database,
        request(firstActivation, `stable-${index + 1}`, `request-${index + 2}`),
      );
    }
    await expect(
      admitWatchControlRequest(
        database,
        request(firstActivation, "over-limit", "request-over-limit"),
      ),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { limit: WATCH_OBSERVATIONS_PER_HOUR },
    });
    const secondActivation = activations.get(second.trigger.id)!;
    await expect(
      admitWatchControlRequest(database, request(secondActivation, "independent", "other-watch")),
    ).resolves.toEqual({ wasDuplicate: false });
  });

  it("enforces the active watch limit per environment", async ({ storeFixture }) => {
    const { createFixture, createWatchTrigger } = storeFixture;
    const fixture = await createFixture("watch-limit");
    for (let index = 0; index < MAX_ACTIVE_WATCHES_PER_ENVIRONMENT; index += 1) {
      await createWatchTrigger(fixture, `watch-limit-${index}`);
    }
    await expect(createWatchTrigger(fixture, "watch-limit-overflow")).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { limit: MAX_ACTIVE_WATCHES_PER_ENVIRONMENT },
    });
  });

  /**
   * Marks a Run running without dispatching it, with the grant a dispatched
   * Run holds: only a Run whose authority stands takes a steer.
   */
});
