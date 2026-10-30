import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  HarnessIdSchema,
  MessageAuthorSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type RunnerId,
  type ThreadId,
  type TriggerId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { RunnerDescriptor } from "@opensteer/protocol";
import { WATCH_AUTO_PAUSE_REASON, type TriggerOccurrence } from "@opensteer/triggers";
import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { AutomationFailureStore, recordAutomationFailure } from "./automation-failure-store.js";
import { createDatabase, withDatabaseTransaction } from "./connection.js";

import { NotificationStore } from "./notification-store.js";
import { jsonValue } from "./store-primitives.js";
import { OpensteerStore } from "./store.js";
import { TriggerStore } from "./trigger-store.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

/**
 * An automation that stops working must reach the Thread it is anchored to:
 * a one-shot schedule whose only run failed — by its program, a Host restart
 * or a Runner disconnect — and a schedule or watch the Host auto-paused. The
 * notice is written in the transaction that ended the automation, so it is
 * never lost between the failure and the message.
 */
integration.sequential("automation failure notices", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-automation-failure-integration-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const triggers = new TriggerStore(database);
    const notices = new AutomationFailureStore(database);
    async function storedNotices() {
      return database
        .selectFrom("automationFailureNotices")
        .select(["activationId", "detail", "occurrenceId", "reason", "settledAt", "triggerId"])
        .orderBy("createdAt", "asc")
        .execute();
    }
    async function createFixture(suffix: string): Promise<Fixture> {
      const userId = await store.createUser(`Automation owner ${suffix}`);
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      if (!(await store.getDeployment())) {
        await store.ensureDeployment({
          canonicalOrigin: "https://test-host.invalid",
          deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
          hostInstanceId: createId("hostInstance"),
        });
      }
      await enrollRunner({ environmentId, runnerId, suffix, userId });
      const workspace = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: `wsp_automation_failure_${suffix}`,
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
        home: true,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Chat ${suffix}`,
        workspaceId: workspace.id,
      });
      return { environmentId, runnerId, threadId: thread.id, userId, workspaceId: workspace.id };
    }
    async function enrollRunner(input: {
      readonly environmentId: ReturnType<typeof createId<"environment">>;
      readonly runnerId: RunnerId;
      readonly suffix: string;
      readonly userId: UserId;
    }): Promise<void> {
      const pair = generateKeyPairSync("ed25519");
      const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
      const enrollmentTokenHash = `sha256:${createHash("sha256")
        .update(`automation-failure-${input.suffix}`, "utf8")
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
        name: "Automation test Runner",
        runnerId: input.runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
      };
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: input.userId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `automation-runner-${input.suffix}`,
        mainEnrollmentPurpose: "initial",
        name: descriptor.name,
        requestFingerprint: `sha256:automation-runner-${input.suffix}`,
        runnerKind: "main",
        tokenHash: enrollmentTokenHash,
      });
      await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash,
        publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
    }
    const program = {
      language: "javascript",
      source: "export default async () => null",
      toolContractVersion: 2,
    } as const;
    function createOneShotTrigger(fixture: Fixture, suffix: string) {
      return triggers.create({
        actorThreadId: null,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        idempotencyKey: `one-shot-${suffix}`,
        name: `Reminder ${suffix}`,
        program,
        source: {
          kind: "schedule",
          schedule: { at: new Date(Date.now() + 60_000).toISOString(), kind: "at" },
        },
      });
    }
    function createCronTrigger(fixture: Fixture, suffix: string) {
      return triggers.create({
        actorThreadId: null,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        idempotencyKey: `cron-${suffix}`,
        name: `Daily ${suffix}`,
        program,
        source: {
          kind: "schedule",
          schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
        },
      });
    }
    async function fireOneShot(triggerId: TriggerId): Promise<TriggerOccurrence> {
      const due = (await triggers.claimDueSchedules(new Date(Date.now() + 120_000))).occurrences;
      const occurrence = due.find((candidate) => candidate.triggerId === triggerId);
      if (!occurrence) throw new Error("Expected the one-shot schedule to fire");
      return occurrence;
    }
    async function listed(fixture: Fixture) {
      return (
        await triggers.listForOwner({ scope: { kind: "user" }, ownerId: fixture.userId })
      ).map(({ id }) => id);
    }
    function fireManual(fixture: Fixture, triggerId: TriggerId) {
      return triggers.enqueueManual({ actorThreadId: null, ownerId: fixture.userId, triggerId });
    }
    async function detail(triggerId: TriggerId, userId: UserId) {
      const value = await triggers.getForOwner(triggerId, userId, 25, { kind: "user" });
      if (!value) throw new Error("Expected Trigger detail");
      return value;
    }
    async function start(
      fixture: Fixture,
      occurrence: TriggerOccurrence,
      runnerBootId: string,
    ): Promise<TriggerOccurrence & { readonly executionGeneration: number }> {
      const claimed = await store.claimCommand(occurrence.commandId, `dispatcher-${randomUUID()}`);
      if (!claimed) throw new Error("Expected Trigger command claim");
      const started = await triggers.startExecution({
        commandId: occurrence.commandId,
        runnerBootId,
        runnerId: fixture.runnerId,
      });
      return { ...occurrence, executionGeneration: started.executionGeneration };
    }
    async function complete(
      fixture: Fixture,
      occurrence: TriggerOccurrence,
      status: "failed" | "succeeded",
      suffix: string,
    ): Promise<TriggerOccurrence> {
      const runnerBootId = `boot-${suffix}-${randomUUID()}`;
      const started = await start(fixture, occurrence, runnerBootId);
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
    async function failManual(fixture: Fixture, triggerId: TriggerId, suffix: string) {
      return complete(fixture, await fireManual(fixture, triggerId), "failed", suffix);
    }
    async function appendCompletedReply(
      fixture: Fixture,
      runId: ReturnType<typeof createId<"run">>,
      words: string,
    ) {
      const messageId = await database.transaction().execute(async (transaction) => {
        const context = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.actorPrincipalId", "threads.nextMessageSequence"])
          .where("runs.id", "=", runId)
          .forNoKeyUpdate("threads")
          .executeTakeFirstOrThrow();
        const id = createId("message");
        await transaction
          .insertInto("messages")
          .values({
            actorPrincipalId: context.actorPrincipalId,
            author: jsonValue(
              MessageAuthorSchema.parse({
                displayName: "Opensteer",
                kind: "agent",
                runId,
                threadId: fixture.threadId,
                workspaceId: fixture.workspaceId,
                workspaceName: "Main",
              }),
            ),
            content: jsonValue([{ text: words, type: "text" }]),
            id,
            kind: "assistant",
            runId,
            sequence: context.nextMessageSequence,
            threadId: fixture.threadId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("threads")
          .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
          .where("id", "=", fixture.threadId)
          .executeTakeFirstOrThrow();
        return id;
      });
      await database.transaction().execute(async (transaction) => {
        const createdAt = new Date();
        const workspace = await transaction
          .updateTable("workspaces")
          .set({ eventSequence: sql<string>`event_sequence + 1`, updatedAt: createdAt })
          .where("id", "=", fixture.workspaceId)
          .returning("eventSequence")
          .executeTakeFirstOrThrow();
        const eventId = createId("event");
        const seed = await transaction
          .selectFrom("runs")
          .innerJoin("messages", "messages.id", "runs.seedInputId")
          .select("messages.author")
          .where("runs.id", "=", runId)
          .executeTakeFirstOrThrow();
        const event = AgentEventSchema.parse({
          createdAt: createdAt.toISOString(),
          data: {
            replyMessageId: messageId,
            startedBy: MessageAuthorSchema.parse(seed.author),
            status: "completed",
          },
          environmentId: fixture.environmentId,
          eventId,
          runId,
          sequence: String(workspace.eventSequence),
          threadId: fixture.threadId,
          type: "run.completed",
          workspaceId: fixture.workspaceId,
        });
        await transaction
          .insertInto("workspaceEvents")
          .values({
            createdAt,
            data: jsonValue(event.data),
            environmentId: fixture.environmentId,
            eventId,
            runId,
            runnerBindingGeneration: null,
            runnerBootId: null,
            runnerId: null,
            runnerOrdinal: null,
            sequence: workspace.eventSequence,
            threadId: fixture.threadId,
            type: "run.completed",
            workspaceId: fixture.workspaceId,
          })
          .executeTakeFirstOrThrow();
      });
      return messageId;
    }

    return Object.freeze({
      database,
      store,
      triggers,
      notices,
      storedNotices,
      createFixture,
      enrollRunner,
      program,
      createOneShotTrigger,
      createCronTrigger,
      fireOneShot,
      listed,
      fireManual,
      detail,
      start,
      complete,
      failManual,
      appendCompletedReply,
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

  interface Fixture {
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  }

  it("records a notice when a one-shot schedule's only run fails", async ({ storeFixture }) => {
    const { createFixture, createOneShotTrigger, fireOneShot, complete, storedNotices, notices } =
      storeFixture;
    const fixture = await createFixture("one-shot-failed");
    const created = await createOneShotTrigger(fixture, "one-shot-failed");
    const occurrence = await fireOneShot(created.trigger.id);

    await complete(fixture, occurrence, "failed", "one-shot-failed");

    expect(await storedNotices()).toEqual([
      {
        activationId: null,
        detail: "Program failed",
        occurrenceId: occurrence.id,
        reason: "final-occurrence-failed",
        settledAt: null,
        triggerId: created.trigger.id,
      },
    ]);
    await expect(notices.listDue()).resolves.toEqual([
      {
        anchorThreadId: fixture.threadId,
        attempts: 0,
        createdBy: fixture.userId,
        detail: "Program failed",
        id: expect.any(String),
        reason: "final-occurrence-failed",
        triggerId: created.trigger.id,
        triggerName: "Reminder one-shot-failed",
      },
    ]);
  });

  it("finishes a one-shot whose run succeeds: no notice, archived, and off its owner's list", async ({
    storeFixture,
  }) => {
    const {
      createFixture,
      createOneShotTrigger,
      fireOneShot,
      listed,
      complete,
      storedNotices,
      detail,
    } = storeFixture;
    const fixture = await createFixture("one-shot-succeeded");
    const created = await createOneShotTrigger(fixture, "one-shot-succeeded");
    const occurrence = await fireOneShot(created.trigger.id);
    await expect(listed(fixture)).resolves.toEqual([created.trigger.id]);

    await complete(fixture, occurrence, "succeeded", "one-shot-succeeded");

    expect(await storedNotices()).toEqual([]);
    const finished = await detail(created.trigger.id, fixture.userId);
    expect(finished.trigger).toMatchObject({ nextFireAt: null, status: "archived" });
    expect(finished.occurrences.map(({ status }) => status)).toEqual(["succeeded"]);
    await expect(listed(fixture)).resolves.toEqual([]);
  });

  it("keeps a one-shot run early by hand: its own time is still to come", async ({
    storeFixture,
  }) => {
    const { createFixture, createOneShotTrigger, complete, fireManual, detail, listed } =
      storeFixture;
    const fixture = await createFixture("one-shot-early");
    const created = await createOneShotTrigger(fixture, "one-shot-early");

    await complete(fixture, await fireManual(fixture, created.trigger.id), "succeeded", "early");

    const kept = await detail(created.trigger.id, fixture.userId);
    expect(kept.trigger).toMatchObject({
      nextFireAt: created.trigger.nextFireAt,
      status: "active",
    });
    await expect(listed(fixture)).resolves.toEqual([created.trigger.id]);
  });

  it("keeps a failed one-shot listed until a run by hand succeeds, which finishes it", async ({
    storeFixture,
  }) => {
    const {
      createFixture,
      createOneShotTrigger,
      complete,
      fireOneShot,
      triggers,
      fireManual,
      detail,
      listed,
    } = storeFixture;
    const fixture = await createFixture("one-shot-retried");
    const created = await createOneShotTrigger(fixture, "one-shot-retried");
    await complete(fixture, await fireOneShot(created.trigger.id), "failed", "retried-first");

    const [failed] = await triggers.listForOwner({
      scope: { kind: "user" },
      ownerId: fixture.userId,
    });
    expect(failed).toMatchObject({
      id: created.trigger.id,
      latestOccurrence: { error: "Program failed", source: "schedule", status: "failed" },
      nextFireAt: null,
      status: "active",
    });

    await complete(fixture, await fireManual(fixture, created.trigger.id), "succeeded", "retried");

    expect((await detail(created.trigger.id, fixture.userId)).trigger.status).toBe("archived");
    await expect(listed(fixture)).resolves.toEqual([]);
  });

  it("keeps a paused one-shot whose time has not come, even after a run by hand", async ({
    storeFixture,
  }) => {
    const { createFixture, createOneShotTrigger, triggers, complete, fireManual, detail, listed } =
      storeFixture;
    const fixture = await createFixture("one-shot-paused");
    const created = await createOneShotTrigger(fixture, "one-shot-paused");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "paused",
      triggerId: created.trigger.id,
    });

    await complete(fixture, await fireManual(fixture, created.trigger.id), "succeeded", "paused");

    expect((await detail(created.trigger.id, fixture.userId)).trigger.status).toBe("paused");
    await expect(listed(fixture)).resolves.toEqual([created.trigger.id]);
  });

  it("lists each Trigger with when it runs, how it last went and where it talks", async ({
    storeFixture,
  }) => {
    const { createFixture, triggers, program, createCronTrigger, complete, fireManual, detail } =
      storeFixture;
    const fixture = await createFixture("summary");
    const at = new Date(Date.now() + 60_000).toISOString();
    const once = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "summary-once",
      name: "Reminder summary",
      program,
      source: {
        kind: "schedule",
        schedule: { at, kind: "at", payload: { large: "x".repeat(64) } },
      },
    });
    const daily = await createCronTrigger(fixture, "summary");
    const ran = await complete(
      fixture,
      await fireManual(fixture, daily.trigger.id),
      "succeeded",
      "summary",
    );

    const summaries = await triggers.listForOwner({
      scope: { kind: "user" },
      ownerId: fixture.userId,
    });
    const byId = Object.fromEntries(summaries.map((summary) => [summary.id, summary]));
    expect(byId[once.trigger.id]).toMatchObject({
      anchorThreadTitle: "Chat",
      latestOccurrence: null,
      // The list says when; the payload a schedule carries is the detail's.
      source: { kind: "schedule", schedule: { at, kind: "at" } },
      watch: null,
    });
    expect(byId[once.trigger.id]?.source).toEqual({
      kind: "schedule",
      schedule: { at, kind: "at" },
    });
    expect(byId[daily.trigger.id]).toMatchObject({
      latestOccurrence: {
        completedAt: ran.completedAt,
        error: null,
        id: ran.id,
        source: "manual",
        status: "succeeded",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    expect((await detail(once.trigger.id, fixture.userId)).anchorThreadTitle).toBe("Chat");
  });

  it("records nothing for a recurring failure below the threshold, and one auto-pause", async ({
    storeFixture,
  }) => {
    const { createFixture, createCronTrigger, failManual, storedNotices, detail } = storeFixture;
    const fixture = await createFixture("recurring");
    const created = await createCronTrigger(fixture, "recurring");

    await failManual(fixture, created.trigger.id, "first");
    await failManual(fixture, created.trigger.id, "second");
    expect(await storedNotices()).toEqual([]);

    const third = await failManual(fixture, created.trigger.id, "third");
    expect(await storedNotices()).toEqual([
      {
        activationId: null,
        detail: "Program failed",
        occurrenceId: third.id,
        reason: "paused",
        settledAt: null,
        triggerId: created.trigger.id,
      },
    ]);
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      status: "paused",
    });

    // A run that fails after the pause is not a second stop.
    await failManual(fixture, created.trigger.id, "after-pause");
    expect(await storedNotices()).toHaveLength(1);
  });

  it("records a notice when a Runner disconnect or Host restart loses a one-shot's only run", async ({
    storeFixture,
  }) => {
    const {
      createFixture,
      createOneShotTrigger,
      createCronTrigger,
      start,
      fireOneShot,
      triggers,
      storedNotices,
    } = storeFixture;
    const fixture = await createFixture("lost-run");
    const oneShot = await createOneShotTrigger(fixture, "lost-one-shot");
    const recurring = await createCronTrigger(fixture, "lost-recurring");
    const lostOneShot = await start(fixture, await fireOneShot(oneShot.trigger.id), "boot-a");
    const lostRecurring = await start(
      fixture,
      await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId: recurring.trigger.id,
      }),
      "boot-a",
    );

    // Both runs are lost together, as a disconnect loses every run it held.
    await expect(
      triggers.failActiveForRunnerDisconnect({
        activeOccurrenceIds: [lostRecurring.id, lostOneShot.id],
        runnerBootId: "boot-a",
        runnerId: fixture.runnerId,
      }),
    ).resolves.toBe(2);

    // The recurring Trigger runs again on its schedule; the one-shot never will.
    expect(await storedNotices()).toEqual([
      {
        activationId: null,
        detail: "Runner disconnected before the Trigger program finished",
        occurrenceId: lostOneShot.id,
        reason: "final-occurrence-interrupted",
        settledAt: null,
        triggerId: oneShot.trigger.id,
      },
    ]);

    const restarted = await createOneShotTrigger(fixture, "restarted-one-shot");
    const lostToRestart = await start(fixture, await fireOneShot(restarted.trigger.id), "boot-b");
    await expect(triggers.failActiveAfterHostRestart()).resolves.toBe(1);
    expect((await storedNotices()).at(-1)).toEqual({
      activationId: null,
      detail: "Host restarted before the Trigger program finished",
      occurrenceId: lostToRestart.id,
      reason: "final-occurrence-interrupted",
      settledAt: null,
      triggerId: restarted.trigger.id,
    });
  });

  it("records one notice when a crash-looping watch is auto-paused", async ({ storeFixture }) => {
    const { createFixture, triggers, storedNotices, detail } = storeFixture;
    const fixture = await createFixture("watch");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "watch-crash-loop",
      name: "Inbox watch",
      program: {
        language: "javascript",
        source: "export default async () => new Promise(() => setInterval(() => {}, 1000))",
        toolContractVersion: 2,
      },
      source: { kind: "watch" },
    });
    const bootId = `watch-boot-${randomUUID()}`;
    const snapshot = await triggers.reconcileWatchesForRunner({
      environmentId: fixture.environmentId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: bootId,
      runnerConnectionGeneration: 1,
      runnerId: fixture.runnerId,
    });
    const activation = snapshot.activations[0]!.activation;
    const report = (restartCount: number) =>
      triggers.applyWatchStatus({
        activationId: activation.id,
        executionGeneration: activation.executionGeneration,
        healthySince: null,
        lastError: "program exited with code 1",
        lastExitCode: 1,
        observed: "backoff",
        restartCount,
        runnerBootId: bootId,
        runnerConnectionGeneration: 1,
        runnerId: fixture.runnerId,
        stderrTail: "failed\n",
        stdoutTail: "",
      });

    expect((await report(1)).autoPaused).toBe(false);
    expect((await report(2)).autoPaused).toBe(false);
    expect(await storedNotices()).toEqual([]);
    expect((await report(3)).autoPaused).toBe(true);
    await report(4);

    expect(await storedNotices()).toEqual([
      {
        activationId: activation.id,
        detail: "program exited with code 1",
        occurrenceId: null,
        reason: "paused",
        settledAt: null,
        triggerId: created.trigger.id,
      },
    ]);
    expect((await detail(created.trigger.id, fixture.userId)).trigger).toMatchObject({
      pauseReason: WATCH_AUTO_PAUSE_REASON,
      status: "paused",
    });
  });

  it("records one notice per Occurrence, with a bounded detail", async ({ storeFixture }) => {
    const {
      createFixture,
      createOneShotTrigger,
      fireOneShot,
      database,
      fireManual,
      storedNotices,
    } = storeFixture;
    const fixture = await createFixture("bounded");
    const created = await createOneShotTrigger(fixture, "bounded");
    const occurrence = await fireOneShot(created.trigger.id);

    for (const detailText of ["x".repeat(3_000), "a second record of the same Occurrence"]) {
      await withDatabaseTransaction(database, (transaction) =>
        recordAutomationFailure(transaction, {
          detail: detailText,
          occurrenceId: occurrence.id,
          reason: "final-occurrence-failed",
          triggerId: created.trigger.id,
        }),
      );
    }
    const manual = await fireManual(fixture, created.trigger.id);
    await withDatabaseTransaction(database, (transaction) =>
      recordAutomationFailure(transaction, {
        detail: "   ",
        occurrenceId: manual.id,
        reason: "paused",
        triggerId: created.trigger.id,
      }),
    );

    expect((await storedNotices()).map(({ detail: text }) => text)).toEqual([
      "x".repeat(2_000),
      "No error was reported.",
    ]);
  });

  it("lists due notices, backs a failed delivery off and settles each once", async ({
    storeFixture,
  }) => {
    const { createFixture, createOneShotTrigger, complete, fireOneShot, notices, database } =
      storeFixture;
    const fixture = await createFixture("drain");
    const created = await createOneShotTrigger(fixture, "drain");
    await complete(fixture, await fireOneShot(created.trigger.id), "failed", "drain");
    const [due] = await notices.listDue();

    await notices.retryLater({ error: "Thread busy", id: due!.id });
    await expect(notices.listDue()).resolves.toEqual([]);
    const backedOff = await database
      .selectFrom("automationFailureNotices")
      .select([
        "attempts",
        "lastError",
        sql<number>`extract(epoch from next_attempt_at - now())`.as("delaySeconds"),
      ])
      .where("id", "=", due!.id)
      .executeTakeFirstOrThrow();
    expect(backedOff).toMatchObject({ attempts: 1, lastError: "Thread busy" });
    expect(Number(backedOff.delaySeconds)).toBeGreaterThan(0);
    expect(Number(backedOff.delaySeconds)).toBeLessThanOrEqual(3_600);

    await database
      .updateTable("automationFailureNotices")
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where("id", "=", due!.id)
      .execute();
    await expect(notices.listDue()).resolves.toEqual([
      expect.objectContaining({ attempts: 1, id: due!.id }),
    ]);

    await notices.settle({ id: due!.id, reason: null });
    await notices.settle({ id: due!.id, reason: "a later settle changes nothing" });
    await notices.retryLater({ error: "too late", id: due!.id });
    await expect(notices.listDue()).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("automationFailureNotices")
        .select(["attempts", "lastError"])
        .select((expression) => expression("settledAt", "is not", null).as("settled"))
        .where("id", "=", due!.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempts: 1, lastError: null, settled: true });
  });

  it("wakes the anchor Thread with the notice, and that agent's reply alerts the owner", async ({
    storeFixture,
  }) => {
    const {
      createFixture,
      createOneShotTrigger,
      complete,
      fireOneShot,
      notices,
      store,
      database,
      appendCompletedReply,
    } = storeFixture;
    const fixture = await createFixture("wake-anchor");
    const created = await createOneShotTrigger(fixture, "wake-anchor");
    await complete(fixture, await fireOneShot(created.trigger.id), "failed", "wake-anchor");
    const [notice] = await notices.listDue();

    // Only the Trigger's own owner, into its own anchor Thread, may say so:
    // another member of the Workspace may not speak for it.
    const colleague = await store.createUser("Colleague");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: colleague,
        workspaceId: fixture.workspaceId,
      })
      .executeTakeFirstOrThrow();
    await expect(
      store.enqueueThreadInput({
        content: [{ text: "Forged", type: "text" }],
        idempotencyKey: `automation-failure:forged:${notice!.id}`,
        policy: "queue",
        requestedBy: colleague,
        source: { kind: "automation", noticeId: notice!.id, triggerId: notice!.triggerId },
        threadId: notice!.anchorThreadId,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "Automation source is invalid" });

    const delivered = await store.enqueueThreadInput({
      content: [{ text: `The automation "${notice!.triggerName}" failed.`, type: "text" }],
      idempotencyKey: `automation-failure:${notice!.id}`,
      policy: "queue",
      requestedBy: notice!.createdBy,
      source: { kind: "automation", noticeId: notice!.id, triggerId: notice!.triggerId },
      threadId: notice!.anchorThreadId,
    });
    expect(delivered.message.author).toMatchObject({
      cause: "automation-stopped",
      kind: "platform",
    });
    expect(delivered.message.kind).toBe("continuation");
    if (!delivered.run) throw new Error("Expected the notice to wake the anchor Thread");
    expect(delivered.run).toMatchObject({ requestedBy: fixture.userId });

    const notifications = new NotificationStore(database);
    const reply = await appendCompletedReply(fixture, delivered.run.id, "Your reminder failed.");
    const row = await database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", delivered.run.id)
      .where("type", "=", "run.completed")
      .executeTakeFirstOrThrow();
    const event = AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
    expect(await notifications.decide(event)).toEqual([
      expect.objectContaining({
        userId: fixture.userId,
        view: expect.objectContaining({
          body: "Your reminder failed.",
          kind: "reply-published",
          messageId: reply,
          runId: delivered.run.id,
          threadId: fixture.threadId,
        }),
      }),
    ]);
  });

  /** A reminder: one scheduled run a minute from now. */

  /** The one Occurrence a one-shot schedule makes, as the scheduler claims it when due. */

  /** The Triggers its owner's list shows, by id. */

  /**
   * The reply a Runner's `assistant.message` and `run.completed` commit, each
   * in its own transaction and canonical shape, so no Runner lease is needed.
   */
});
