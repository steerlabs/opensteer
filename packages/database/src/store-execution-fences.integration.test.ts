import { pauseAfterLock } from "./lock-race.test-support.js";
import { lockCommandIdempotency } from "./store-primitives.js";
import { HarnessIdSchema, ModelSelectionSchema, createId } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { ChannelStore, OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  testWorkspaceProfile,
  enrollTestRunner,
  pendingEvent,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("separates shared Workspace visibility from private Runner execution authority", async ({
    storeFixture,
  }) => {
    const { store, database, enqueueHumanTrigger, triggers } = storeFixture;
    await store.ensureDeployment({
      canonicalOrigin: "https://execution-authority.test",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: testWorkspaceProfile,
    });
    const aliceId = await store.createUser("Alice");
    const bobId = await store.createUser("Bob");
    const aliceEnvironmentId = createId("environment");
    const bobEnvironmentId = createId("environment");
    const aliceRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      name: "Alice Mac",
      runnerId: aliceRunnerId,
      runnerKind: "local",
      tokenSuffix: "alice-private-runner",
    });
    await enrollTestRunner(store, {
      createdBy: bobId,
      environmentId: bobEnvironmentId,
      name: "Bob Mac",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "bob-private-runner",
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_execution_authority",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: aliceId,
      idempotencyKey: "execution-authority-workspace",
      name: "Shared research",
      status: "ready",
    });
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: aliceId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: bobId,
        workspaceId: workspace.id,
      })
      .executeTakeFirstOrThrow();
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: aliceEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const bobHarness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: bobEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const { thread: aliceThread } = await store.createThread({
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "execution-authority-alice-thread",
      modelSelection: testModelSelection,
      title: "Alice thread",
      workspaceId: workspace.id,
    });
    expect((await store.readThreadForOwner(aliceThread.id, bobId, 10))?.thread.id).toBe(
      aliceThread.id,
    );
    await expect(
      enqueueHumanTrigger({
        content: [{ text: "Resume Alice's provider session", type: "text" }],
        idempotencyKey: "execution-authority-bob-turn",
        requestedBy: bobId,
        threadId: aliceThread.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.createThread({
        createdBy: bobId,
        environmentId: bobEnvironmentId,
        harnessInstanceId: bobHarness.id,
        idempotencyKey: "execution-authority-bob-child",
        modelSelection: testModelSelection,
        parentThreadId: aliceThread.id,
        title: "Bob's safe fork",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({
      thread: { environmentId: bobEnvironmentId, parentThreadId: aliceThread.id },
    });
    await expect(
      store.createThread({
        createdBy: bobId,
        environmentId: aliceEnvironmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "execution-authority-bob-child-alice-environment",
        modelSelection: testModelSelection,
        parentThreadId: aliceThread.id,
        title: "Forbidden execution transfer",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      triggers.create({
        actorThreadId: null,
        anchorThreadId: aliceThread.id,
        createdBy: bobId,
        idempotencyKey: "execution-authority-bob-trigger",
        name: "Forbidden Trigger",
        program: {
          toolContractVersion: 2,
          language: "javascript",
          source: "export default async () => null",
        },
        source: { kind: "webhook" },
        webhookRouteKey: "wh_bob_forbidden_execution_authority",
        webhookSecretHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const inFlight = await enqueueHumanTrigger({
      content: [{ text: "Alice in flight", type: "text" }],
      idempotencyKey: "execution-authority-alice-inflight",
      requestedBy: aliceId,
      threadId: aliceThread.id,
    });
    await store.claimCommand(inFlight.command.id, "execution-authority-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: harness.id,
      leaseTokenHash: "execution-authority-binding",
      membershipGeneration: 1,
      runnerBootId: "execution-authority-alice-boot",
      runnerId: aliceRunnerId,
      runId: inFlight.run.id,
      threadId: aliceThread.id,
    });
    const runCapability = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: aliceEnvironmentId,
      membershipGeneration: 1,
      requestedBy: aliceId,
      runId: inFlight.run.id,
      runnerBootId: "execution-authority-alice-boot",
      runnerId: aliceRunnerId,
      threadId: aliceThread.id,
      workspaceId: workspace.id,
    };
    await expect(store.assertActiveExecutionBinding(runCapability)).resolves.toBeUndefined();

    // Queue control does not transfer Alice's private Runner authority to Bob.
    // Bob may stop and resume as a Workspace owner, while every surviving item
    // remains admitted and executed as Alice.
    const { thread: stoppedThread } = await store.createThread({
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "execution-authority-owner-resume-thread",
      modelSelection: testModelSelection,
      title: "Owner-controlled Alice queue",
      workspaceId: workspace.id,
    });
    const stoppedSeed = await store.enqueueThreadInput({
      content: [{ text: "Alice work stopped by an owner", type: "text" }],
      idempotencyKey: "execution-authority-owner-resume-seed",
      policy: "queue",
      requestedBy: aliceId,
      source: { kind: "human" },
      threadId: stoppedThread.id,
    });
    const survivingWork = await store.enqueueThreadInput({
      content: [{ text: "Alice work surviving the stop", type: "text" }],
      idempotencyKey: "execution-authority-owner-resume-survivor",
      policy: "queue",
      requestedBy: aliceId,
      source: { kind: "human" },
      threadId: stoppedThread.id,
    });
    if (!stoppedSeed.run) throw new Error("Expected Alice's private Run to be queued");
    await store.enqueueRunnerControl({
      idempotencyKey: "execution-authority-owner-stop",
      requestedBy: bobId,
      runId: stoppedSeed.run.id,
      threadId: stoppedThread.id,
      type: "run.interrupt",
    });
    const ownerResumed = await store.resumeThreadInputQueue({
      idempotencyKey: "execution-authority-owner-resume",
      requestedBy: bobId,
      threadId: stoppedThread.id,
    });
    expect(ownerResumed.thread.inputQueuePaused).toBe(false);
    await expect(
      database
        .selectFrom("runs")
        .select(["requestedBy", "seedInputId", "status"])
        .where("threadId", "=", stoppedThread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      requestedBy: aliceId,
      seedInputId: survivingWork.message.id,
      status: "queued",
    });
    await expect(
      store.enqueueThreadInput({
        content: [{ text: "Bob cannot use Alice's private Runner", type: "text" }],
        idempotencyKey: "execution-authority-owner-direct-enqueue",
        policy: "queue",
        requestedBy: bobId,
        source: { kind: "human" },
        threadId: stoppedThread.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // A later Stop cannot take ownership of an existing pause. Otherwise the
    // Run requester could overwrite an owner's pause and immediately resume.
    const { thread: pauseOwnershipThread } = await store.createThread({
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "execution-authority-pause-ownership-thread",
      modelSelection: testModelSelection,
      title: "Owner-paused Alice thread",
      workspaceId: workspace.id,
    });
    const pauseOwnershipWork = await enqueueHumanTrigger({
      content: [{ text: "Alice work paused by an owner", type: "text" }],
      idempotencyKey: "execution-authority-pause-ownership-work",
      requestedBy: aliceId,
      threadId: pauseOwnershipThread.id,
    });
    await store.claimCommand(
      pauseOwnershipWork.command.id,
      "execution-authority-pause-ownership-dispatcher",
    );
    // Bound, the Run outlives a first Stop until its Runner winds it down.
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: harness.id,
      leaseTokenHash: "execution-authority-pause-ownership-binding",
      membershipGeneration: 1,
      runnerBootId: "execution-authority-alice-boot",
      runnerId: aliceRunnerId,
      runId: pauseOwnershipWork.run.id,
      threadId: pauseOwnershipThread.id,
    });
    await store.enqueueRunnerControl({
      idempotencyKey: "execution-authority-pause-ownership-owner-stop",
      requestedBy: bobId,
      runId: pauseOwnershipWork.run.id,
      threadId: pauseOwnershipThread.id,
      type: "run.interrupt",
    });
    await store.enqueueRunnerControl({
      idempotencyKey: "execution-authority-pause-ownership-requester-stop",
      requestedBy: aliceId,
      runId: pauseOwnershipWork.run.id,
      threadId: pauseOwnershipThread.id,
      type: "run.interrupt",
    });
    await expect(
      database
        .selectFrom("threads")
        .select(["inputQueuePaused", "inputQueuePausedBy"])
        .where("id", "=", pauseOwnershipThread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ inputQueuePaused: true, inputQueuePausedBy: bobId });

    const { thread: queuedThread } = await store.createThread({
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "execution-authority-alice-queued-thread",
      modelSelection: testModelSelection,
      title: "Queued Alice thread",
      workspaceId: workspace.id,
    });
    const queuedReport = await store.enqueueThreadInput({
      content: [{ text: "Report claimed before membership revocation", type: "text" }],
      idempotencyKey: "execution-authority-alice-queued-report",
      policy: "report",
      requestedBy: aliceId,
      source: { kind: "human" },
      threadId: queuedThread.id,
    });
    const queued = await enqueueHumanTrigger({
      content: [{ text: "Queued before revocation", type: "text" }],
      idempotencyKey: "execution-authority-alice-queued",
      requestedBy: aliceId,
      threadId: queuedThread.id,
    });
    await store.claimCommand(queued.command.id, "execution-authority-pre-revocation-retry");
    await store.retryCommand(queued.command.id, new Error("Runner was temporarily unavailable"));
    const schedule = await triggers.create({
      actorThreadId: null,
      anchorThreadId: aliceThread.id,
      createdBy: aliceId,
      idempotencyKey: "execution-authority-alice-schedule",
      name: "Alice schedule",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: {
        kind: "schedule",
        schedule: {
          at: new Date(Date.now() + 60_000).toISOString(),
          kind: "at",
          payload: null,
        },
      },
    });
    const webhook = await triggers.create({
      actorThreadId: null,
      anchorThreadId: aliceThread.id,
      createdBy: aliceId,
      idempotencyKey: "execution-authority-alice-webhook",
      name: "Alice webhook",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_alice_execution_authority_active",
      webhookSecretHash: "a".repeat(64),
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: aliceId,
      triggerId: webhook.trigger.id,
    });
    await store.claimCommand(occurrence.commandId, "execution-authority-trigger-dispatcher");
    const triggerBinding = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "execution-authority-alice-boot",
      runnerId: aliceRunnerId,
    });

    const revoked = await store.changeWorkspaceMembership({
      actorId: bobId,
      state: "revoked",
      targetUserId: aliceId,
      workspaceId: workspace.id,
    });
    const claimedAfterRevocation = await store.claimCommand(
      queued.command.id,
      "execution-authority-after-revocation",
    );
    expect(claimedAfterRevocation?.terminalFailure).toContain("no longer available");
    await store.failCommand(
      queued.command.id,
      claimedAfterRevocation!.terminalFailure!,
      "authority-cohort",
    );
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", queued.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cancelReason: "execution-authority-unavailable", state: "cancelled" });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", queuedReport.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cancelReason: "membership-changed", state: "cancelled" });
    await expect(
      database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", queuedThread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      enqueueHumanTrigger({
        content: [{ text: "Work after Alice's membership was revoked", type: "text" }],
        idempotencyKey: "execution-authority-revoked-member-work",
        requestedBy: aliceId,
        threadId: queuedThread.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(store.assertActiveExecutionBinding(runCapability)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      await triggers.revokeForMembershipRevocation({
        membershipGeneration: revoked.membership.generation,
        userId: aliceId,
        workspaceId: workspace.id,
      }),
    ).toBe(2);
    await expect(
      triggers.assertActiveExecutionBinding({
        environmentId: aliceEnvironmentId,
        executionGeneration: triggerBinding.executionGeneration,
        occurrenceId: occurrence.id,
        requestedBy: aliceId,
        runnerBootId: "execution-authority-alice-boot",
        runnerId: aliceRunnerId,
        threadId: aliceThread.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        payload: null,
        routeKey: webhook.trigger.webhookRouteKey ?? "",
      }),
    ).rejects.toBeDefined();
    expect((await triggers.claimDueSchedules(new Date(Date.now() + 120_000))).occurrences).toEqual(
      [],
    );
    await expect(
      database
        .selectFrom("triggerOccurrences")
        .select("status")
        .where("id", "=", occurrence.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      database
        .selectFrom("triggers")
        .select(["nextFireAt", "status"])
        .where("id", "=", schedule.trigger.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ nextFireAt: null, status: "archived" });
  });

  it("reserves delegation task idempotency before execution fences", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const fixture = await startRunFixture("delegation-idempotency-order");
    const key = "delegation-idempotency-order";
    const barrier = pauseAfterLock(database, (node) => node.includes("pg_advisory_xact_lock"));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await lockCommandIdempotency(transaction, fixture.userId, `${key}:task`);
      await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", fixture.workspace.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let delegation: ReturnType<OpensteerStore["delegateThread"]> | undefined;
    try {
      await barrier.reached;
      delegation = store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
        task: [{ text: "Child task", type: "text" }],
        title: "Child",
        workspaceId: fixture.workspace.id,
      });
      void delegation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes("pg_advisory_xact_lock")),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, delegation]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(results[1]).toMatchObject({ value: { wasDuplicate: false } });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, delegation]);
    }
  });

  it("reserves Assignment cancellation idempotency before its scope fence", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("cancel-idempotency-order");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "cancel-idempotency-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Child task", type: "text" }],
      title: "Child",
      workspaceId: fixture.workspace.id,
    });
    const key = "cancel-idempotency-order";
    const barrier = pauseAfterLock(database, (node) => node.includes("pg_advisory_xact_lock"));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await lockCommandIdempotency(transaction, fixture.userId, key);
      await transaction
        .selectFrom("delegations")
        .select("id")
        .where("id", "=", delegated.assignment.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
    try {
      await barrier.reached;
      cancellation = store.cancelAssignment({
        assignmentId: delegated.assignment.id,
        actorRunId: fixture.run.id,
        requestedBy: fixture.userId,
        idempotencyKey: key,
      });
      void cancellation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes("pg_advisory_xact_lock")),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, cancellation]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, cancellation]);
    }
  });

  it.for([
    { eventType: "run.started", fence: "provider_sessions" },
    { eventType: "run.interrupted", fence: "provider_sessions" },
    { eventType: "run.interrupted", fence: "commands" },
  ] as const)(
    "fences $fence before input projection for $eventType",
    async ({ eventType, fence }, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
        storeFixture;
      const fixture = await createRunFixture(`projection-${eventType.replace(".", "-")}-${fence}`);
      const turn = await enqueueHumanTrigger({
        content: [{ type: "text", text: "Work" }],
        idempotencyKey: "projection-fences",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "projection-fences");
      const binding = await bindAgentControlRun(fixture, turn.run.id, "projection-fences");
      const provider = await database
        .selectFrom("runs")
        .select("providerSessionId")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(fence));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(fence)} where id=${fence === "commands" ? turn.command.id : provider.providerSessionId} for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("messageId", "=", turn.message.id)
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let projecting: ReturnType<OpensteerStore["commitRunnerEvent"]> | undefined;
      try {
        await barrier.reached;
        projecting = store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          runnerBootId: binding.runnerBootId,
          runnerId: fixture.runnerId,
          event: pendingEvent({
            bindingGeneration: binding.bindingGeneration,
            data: { status: eventType === "run.started" ? "running" : "interrupted" },
            environmentId: fixture.environmentId,
            ordinal: 0,
            runId: turn.run.id,
            threadId: fixture.thread.id,
            type: eventType,
            workspaceId: fixture.workspace.id,
          }),
        });
        void projecting.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) => query.includes(fence)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, projecting]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, projecting]);
      }
    },
  );

  it.for(["provider_sessions", "commands"] as const)(
    "fences Assignment %s before cancelled inputs",
    async (fence, { storeFixture }) => {
      const { startRunFixture, store, database } = storeFixture;
      const fixture = await startRunFixture("cancel-projection-order");
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "cancel-projection-child",
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
        task: [{ text: "Child", type: "text" }],
        title: "Child",
        workspaceId: fixture.workspace.id,
      });
      const barrier = pauseAfterLock(database, (node) => node.includes(fence));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(fence)} where thread_id=${delegated.thread.id} order by id for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("assignmentId", "=", delegated.assignment.id)
          .orderBy("messageId", "asc")
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
      try {
        await barrier.reached;
        cancellation = store.cancelAssignment({
          assignmentId: delegated.assignment.id,
          actorRunId: fixture.run.id,
          requestedBy: fixture.userId,
          idempotencyKey: "cancel-projection",
        });
        void cancellation.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) => query.includes(fence)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, cancellation]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, cancellation]);
      }
    },
  );

  it("does not interrupt a worker Run that finished while cancellation waited on it", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("cancel-finished-worker");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "cancel-finished-worker-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Child", type: "text" }],
      title: "Child",
      workspaceId: fixture.workspace.id,
    });
    const workerRunId = delegated.run.id;
    // A dispatched worker: cancellation would interrupt it rather than finalize it.
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", workerRunId)
      .execute();
    const held = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const worker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("runs")
        .select("id")
        .where("id", "=", workerRunId)
        .forNoKeyUpdate()
        .execute();
      held.resolve();
      await finish.promise;
      await transaction
        .updateTable("runs")
        .set({ completedAt: new Date(), status: "interrupted" })
        .where("id", "=", workerRunId)
        .execute();
    });
    void worker.catch(() => undefined);
    let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
    try {
      await held.promise;
      cancellation = store.cancelAssignment({
        assignmentId: delegated.assignment.id,
        actorRunId: fixture.run.id,
        requestedBy: fixture.userId,
        idempotencyKey: "cancel-finished-worker",
      });
      void cancellation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('from "runs"')),
        )
        .toBe(true);
      finish.resolve();
      await worker;
      await cancellation;
    } finally {
      finish.resolve();
      await Promise.allSettled([worker, ...(cancellation ? [cancellation] : [])]);
    }
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", workerRunId)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([]);
  });

  it.for(["channel_bindings", "channel_identities"] as const)(
    "fences queued channel %s before its Thread",
    async (resource, { storeFixture }) => {
      const { createChannelNoticeFixture, database, store } = storeFixture;
      const fixture = await createChannelNoticeFixture("channel-claim-prefix", {
        accessMode: "anyone",
      });
      const adopted = await fixture.adopt({ eventId: "claim-prefix", type: "dm" });
      if (adopted.result.kind !== "adopted" || !adopted.result.run)
        throw new Error("Expected queued channel Run");
      const run = adopted.result.run;
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(resource));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(resource)} where account_id=${fixture.configured.account.id} order by id for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threads")
          .select("id")
          .where("id", "=", run.threadId)
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let claiming: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        claiming = store.claimCommand(command.id, "channel-claim-prefix");
        void claiming.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`
          select query from pg_stat_activity where datname=current_database()
          and application_name='opensteer-integration-test' and wait_event_type='Lock'
        `.execute(database)
            ).rows.some(({ query }) => query.includes(resource)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, claiming]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, claiming]);
      }
    },
  );

  it("fences the Assignment before claiming its Command", async ({ storeFixture }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("assignment-claim-prefix");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "assignment-claim-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Child", type: "text" }],
      title: "Child",
      workspaceId: fixture.workspace.id,
    });
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("threadId", "=", delegated.thread.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const barrier = pauseAfterLock(database, (node) => /"name":"delegations"/u.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("delegations")
        .select("id")
        .where("id", "=", delegated.assignment.id)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "=", command.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let claiming: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      claiming = store.claimCommand(command.id, "assignment-claim-prefix");
      void claiming.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"delegations"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, claiming]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, claiming]);
    }
  });

  it.for(["nested-delegation", "cancel-request", "drain-pending"] as const)(
    "orders Assignment projection fences (%s)",
    async (scenario, { storeFixture }) => {
      const { startRunFixture, store, database, bindAgentControlRun, createSpecializedWorkspace } =
        storeFixture;
      const fixture = await startRunFixture("assignment-projection-prefix");
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "projection-child",
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
        task: [{ text: "Child", type: "text" }],
        title: "Child",
        workspaceId: fixture.workspace.id,
      });
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", delegated.run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "projection-child");
      const binding = await bindAgentControlRun(
        fixture,
        delegated.run.id,
        "projection-child",
        delegated.thread.id,
      );
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: binding.runnerBootId,
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: { status: "running" },
          environmentId: fixture.environmentId,
          ordinal: 0,
          runId: delegated.run.id,
          threadId: delegated.thread.id,
          type: "run.started",
          workspaceId: fixture.workspace.id,
        }),
      });
      const target = await createSpecializedWorkspace(fixture.userId, "projection-request-target");
      const opened =
        scenario !== "nested-delegation"
          ? await store.requests.create({
              callId: "projection-request",
              kind: "browser.access",
              mode: "durable",
              originatingRunId: delegated.run.id,
              originatingThreadId: delegated.thread.id,
              originatingWorkspaceId: fixture.workspace.id,
              targetWorkspaceId: target.id,
              payload: {
                kind: "browser.access",
                reason: "Choose browser",
                suggestion: { kind: "user_choice" },
              },
              presentation: {
                kind: "external",
                subject: { id: target.id, kind: "workspace" },
                title: "Choose browser",
              },
              requestedBy: fixture.userId,
              requiredActor: "requester",
            })
          : null;
      const resource =
        scenario === "nested-delegation"
          ? "causal_chains"
          : scenario === "cancel-request"
            ? "requests"
            : "delegations";
      const run = await database
        .selectFrom("runs")
        .select("causalChainId")
        .where("id", "=", delegated.run.id)
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(resource));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(resource)} where id=${scenario === "nested-delegation" ? run.causalChainId : scenario === "cancel-request" ? opened!.request.id : delegated.assignment.id} for no key update`.execute(
          transaction,
        );
        if (scenario === "drain-pending") {
          await transaction
            .selectFrom("threadStatePending")
            .select("threadId")
            .where("threadId", "=", delegated.thread.id)
            .forUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("delegations")
            .select("id")
            .where("id", "=", delegated.assignment.id)
            .forNoKeyUpdate()
            .execute();
        }
      });
      void peer.catch(() => undefined);
      let mutation: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        mutation =
          scenario === "nested-delegation"
            ? store.delegateThread({
                accessMode: "auto",
                createdBy: fixture.userId,
                environmentId: fixture.environmentId,
                harnessInstanceId: fixture.harnessInstance.id,
                idempotencyKey: "projection-grandchild",
                modelSelection: testModelSelection,
                origin: {
                  kind: "run",
                  parentRunId: delegated.run.id,
                  parentThreadId: delegated.thread.id,
                },
                task: [{ text: "Grandchild", type: "text" }],
                title: "Grandchild",
                workspaceId: fixture.workspace.id,
              })
            : scenario === "cancel-request"
              ? store.cancelAssignment({
                  assignmentId: delegated.assignment.id,
                  actorRunId: fixture.run.id,
                  requestedBy: fixture.userId,
                  idempotencyKey: "projection-cancel",
                })
              : store.drainPendingThreadStates();
        void mutation.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`
          select query from pg_stat_activity where datname=current_database()
          and application_name='opensteer-integration-test' and wait_event_type='Lock'
        `.execute(database)
            ).rows.some(({ query }) => query.includes(resource)),
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
    },
  );

  it.for(["Thread", "Account"] as const)(
    "fences dispatch %s before its messaging receipt",
    async (scope, { storeFixture }) => {
      const { createChannelNoticeFixture, database, store } = storeFixture;
      const fixture = await createChannelNoticeFixture("channel-receipt-prefix", {
        accessMode: "anyone",
      });
      const adopted = await fixture.adopt({ eventId: "receipt-prefix", type: "dm" });
      if (adopted.result.kind !== "adopted" || !adopted.result.run)
        throw new Error("Expected channel Run");
      const run = adopted.result.run;
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "channel-receipt-prefix");
      const barrier = pauseAfterLock(database, (node) =>
        scope === "Thread"
          ? /"name":"threads"/u.test(node)
          : /"name":"channel_?accounts"/iu.test(node),
      );
      const peer = barrier.database.transaction().execute(async (transaction) => {
        if (scope === "Account") {
          await transaction
            .selectFrom("channelAccounts")
            .select("id")
            .where("id", "=", fixture.configured.account.id)
            .forNoKeyUpdate()
            .execute();
          await transaction
            .selectFrom("channelBindings")
            .select("id")
            .where("accountId", "=", fixture.configured.account.id)
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("threads")
            .select("id")
            .where("id", "=", run.threadId)
            .forNoKeyUpdate()
            .execute();
          await transaction
            .selectFrom("commands")
            .select("id")
            .where("id", "=", command.id)
            .forNoKeyUpdate()
            .execute();
        }
      });
      void peer.catch(() => undefined);
      let dispatching: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        dispatching = store.dispatchChannelCommand(command.id, async (beforeAck) => beforeAck());
        void dispatching.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) =>
              query.includes(scope === "Thread" ? '"threads"' : '"channel_accounts"'),
            ),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, dispatching]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, dispatching]);
      }
    },
  );

  it("fences the channel identity before redeeming its link code", async ({ storeFixture }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("link-order");
    await fixture.adopt({ eventId: "link-order-event", type: "dm" });
    const code = await database
      .selectFrom("channelLinkCodes")
      .selectAll()
      .where("accountId", "=", fixture.configured.account.id)
      .executeTakeFirstOrThrow();
    const barrier = pauseAfterLock(database, (node) => /"name":"channel_?identities"/iu.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("channelIdentities")
        .select("id")
        .where("id", "=", code.identityId)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("channelLinkCodes")
        .select("id")
        .where("id", "=", code.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let linking: ReturnType<ChannelStore["linkIdentity"]> | undefined;
    try {
      await barrier.reached;
      linking = fixture.channels.linkIdentity({
        codeHash: code.codeHash,
        userId: fixture.fixture.userId,
      });
      void linking.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"channel_identities"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, linking]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("channelIdentities")
          .select("linkedUserId")
          .where("id", "=", code.identityId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ linkedUserId: fixture.fixture.userId });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, linking]);
    }
  });

  it("uses its Workspace fence for durable Request membership reads", async ({ storeFixture }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
    const fixture = await startRunFixture("request-membership-read");
    const target = await createSpecializedWorkspace(
      fixture.userId,
      "request-membership-read-target",
    );
    const opened = await store.requests.create({
      callId: "membership-read",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      targetWorkspaceId: target.id,
      requestedBy: fixture.userId,
      requiredActor: "requester",
      payload: { kind: "browser.access", reason: "Choose", suggestion: { kind: "user_choice" } },
      presentation: {
        kind: "external",
        title: "Choose",
        subject: { id: target.id, kind: "workspace" },
      },
    });
    const barrier = pauseAfterLock(
      database,
      (node) => node.includes('"name":"requests"') && node.includes("ForNoKeyUpdate"),
    );
    const resolving = new OpensteerStore(barrier.database).requests.resolveBrowserRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    void resolving.catch(() => undefined);
    try {
      await barrier.reached;
      // The Workspace fence already serializes all production membership writes.
      // Inspect actual held locks before resolution commits, not its SQL spelling.
      expect(
        (
          await sql<{ count: number }>`select count(*)::integer as count
        from pgrowlocks('workspace_memberships') where cardinality(pids) > 0`.execute(database)
        ).rows[0]!.count,
      ).toBe(0);
    } finally {
      barrier.release();
      await resolving;
    }
    expect(await store.requests.get(opened.request.id)).toMatchObject({ status: "declined" });
  });

  it("orders access-mode membership fencing before Thread mutation", async ({ storeFixture }) => {
    const { createRunFixture, database, store } = storeFixture;
    const fixture = await createRunFixture("mode-membership-order");
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"workspace_?memberships"/iu.test(node) &&
        node.includes("ForNoKeyUpdate"),
    );
    // Replay the observed membership -> Thread edge against the real mutation.
    // A raw peer isolates the two row fences from unrelated Workspace admission.
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("workspaceMemberships")
        .select("id")
        .where("workspaceId", "=", fixture.workspace.id)
        .where("userId", "=", fixture.userId)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", fixture.thread.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let changing: ReturnType<OpensteerStore["updateThreadAccessMode"]> | undefined;
    try {
      await barrier.reached;
      changing = store.updateThreadAccessMode({
        accessMode: "auto",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      void changing.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"workspace_memberships"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, changing]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(await store.getThreadForOwner(fixture.thread.id, fixture.userId)).toMatchObject({
        accessMode: "auto",
      });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, changing]);
    }
  });

  it("orders injected-message command fencing before its input receipt", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("injected-command-order");
    const steer = await store.enqueueThreadInput({
      content: [{ text: "Steer the active work", type: "text" }],
      idempotencyKey: "injected-command-order",
      policy: "steer",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!steer.command) throw new Error("Expected steer command");
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        node.includes('"name":"commands"') &&
        node.includes("ForNoKeyUpdate"),
    );
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "=", steer.command!.id)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("threadInputs")
        .select("messageId")
        .where("messageId", "=", steer.message.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let injected: ReturnType<OpensteerStore["commitRunnerEvent"]> | undefined;
    try {
      await barrier.reached;
      injected = store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: { messageId: steer.message.id },
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "message.injected",
          workspaceId: fixture.workspace.id,
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      void injected.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"commands"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, injected]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", steer.message.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "delivered" });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, injected]);
    }
  });

  it("orders catalog adoption with execution binding without a deadlock", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("catalog-binding-order");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Bind while adopting", type: "text" }],
      idempotencyKey: "catalog-binding-order",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "catalog-binding-order");
    await database
      .updateTable("providerSessions")
      .set({ continuationIdentity: sql`${JSON.stringify(testContinuationIdentity)}::jsonb` })
      .where("id", "=", turn.run.providerSessionId!)
      .execute();
    const replacement = {
      ...testContinuationIdentity,
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
    };
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"harness_?instances"/iu.test(node) &&
        node.includes("ForNoKeyUpdate"),
    );
    const adopting = new OpensteerStore(barrier.database).recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...testReadyHarnessCatalog(fixture.harnessInstance.id),
          continuationIdentity: replacement,
          supersededContinuationIdentities: [testContinuationIdentity.continuationKey],
        }),
      ],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });
    void adopting.catch(() => undefined);
    let binding: ReturnType<OpensteerStore["acquireExecutionBinding"]> | undefined;
    try {
      await barrier.reached;
      binding = store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: replacement,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "catalog-binding-order",
        membershipGeneration: 1,
        runnerBootId: "catalog-binding-order",
        runnerId: fixture.runnerId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      });
      void binding.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'`.execute(
              database,
            )
          ).rows.some(({ query }) => query.includes('from "harness_instances"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([adopting, binding]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(await store.getThreadForOwner(fixture.thread.id, fixture.userId)).toMatchObject({
        continuationIdentity: replacement,
      });
    } finally {
      barrier.release();
      await Promise.allSettled([adopting, binding]);
    }
  });

  it("moves Threads onto a superseded continuation identity's replacement", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const fixture = await createRunFixture("catalog-supersede");
    const supersededKey = testContinuationIdentity.continuationKey;
    const replacement = {
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
      driverKind: HarnessIdSchema.parse("native"),
    };
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Start the Thread", type: "text" }],
      idempotencyKey: "catalog-supersede-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "catalog-supersede-dispatcher");
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "catalog-supersede-lease",
      membershipGeneration: 1,
      runnerBootId: "catalog-supersede-boot",
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: fixture.thread.id,
    });

    const models = [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ];
    const laptopEnvironmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const laptopHarness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: laptopEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const codexHarness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId: fixture.environmentId,
      name: "Codex",
      stateKind: "isolated",
    });
    // A retired key is only ever retired by the store that owned it: another
    // work location, or another driver, must not drag this Thread anywhere.
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: replacement,
          driverKind: "native",
          harnessInstanceId: laptopHarness.id,
          models,
          status: "ready",
          supersededContinuationIdentities: [supersededKey],
        }),
      ],
      environmentId: laptopEnvironmentId,
      expectedRevisions: new Map([[laptopHarness.id, laptopHarness.runtimeRevision]]),
    });
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: {
            continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
            driverKind: "codex",
          },
          driverKind: "codex",
          harnessInstanceId: codexHarness.id,
          models,
          status: "ready",
          supersededContinuationIdentities: [supersededKey],
        }),
      ],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([[codexHarness.id, codexHarness.runtimeRevision]]),
    });
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      { continuationIdentity: testContinuationIdentity },
    );

    const catalog = HarnessInstanceCatalogSchema.parse({
      continuationIdentity: replacement,
      driverKind: "native",
      harnessInstanceId: fixture.harnessInstance.id,
      models,
      status: "ready",
      supersededContinuationIdentities: [supersededKey],
    });
    await store.recordHarnessCatalogs({
      catalogs: [catalog],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });
    // Recording is the only path a Runner's answer becomes durable, so it also
    // has to be safe to repeat.
    await store.recordHarnessCatalogs({
      catalogs: [catalog],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });

    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      { continuationIdentity: replacement },
    );
  });

  it("pins an admitted Run while an explicit native-session switch races it", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("session-switch-admission");
    const firstSessionId = fixture.thread.providerSessionId;
    expect(firstSessionId).not.toBeNull();
    const admitted = await enqueueHumanTrigger({
      content: [{ text: "Already admitted", type: "text" }],
      idempotencyKey: "session-switch-admitted",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(admitted.run.providerSessionId).toBe(firstSessionId);
    const claude = await store.createHarnessInstance({
      config: { model: "sonnet", modelProviderId: "anthropic" },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Session switch Claude",
      stateKind: "isolated",
    });
    const change = {
      continuation: { expectedProviderSessionId: firstSessionId },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "session-switch-apply",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    };
    await expect(store.updateThreadExecutionSelection(change)).rejects.toMatchObject({
      code: "conflict",
    });
    const retained = await store.getThreadForOwner(fixture.thread.id, fixture.userId);
    expect(retained?.providerSessionId).toBe(firstSessionId);
    expect(retained?.harnessInstanceId).toBe(fixture.harnessInstance.id);
    const persistedRun = await database
      .selectFrom("runs")
      .select(["providerSessionId", "status"])
      .where("id", "=", admitted.run.id)
      .executeTakeFirstOrThrow();
    expect(persistedRun).toEqual({ providerSessionId: firstSessionId, status: "queued" });
  });

  it("refuses idempotent Thread and execution-selection replays after Workspace access is revoked", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("replay-revoked-access");
    const create = {
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "replay-revoked-create",
      modelSelection: testModelSelection,
      title: "Revoked replay target",
      workspaceId: fixture.workspace.id,
    };
    const created = await store.createThread(create);
    const selection = {
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "replay-revoked-selection",
      modelSelection: testModelSelection,
      requestedBy: fixture.userId,
      threadId: created.thread.id,
    };
    await store.updateThreadExecutionSelection(selection);
    await expect(store.findThreadCreationByIdempotency(create)).resolves.toMatchObject({
      thread: { id: created.thread.id },
      wasDuplicate: true,
    });
    await expect(store.createThread(create)).resolves.toMatchObject({ wasDuplicate: true });
    await expect(store.updateThreadExecutionSelection(selection)).resolves.toMatchObject({
      wasDuplicate: true,
    });

    // A committed access change between Host admission and store replay must
    // win over the earlier idempotency receipt.
    const remainingOwnerId = await store.createUser("Remaining Workspace owner");
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
        userId: remainingOwnerId,
        workspaceId: fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    await store.changeWorkspaceMembership({
      actorId: remainingOwnerId,
      state: "revoked",
      targetUserId: fixture.userId,
      workspaceId: fixture.workspace.id,
    });
    await expect(store.findThreadCreationByIdempotency(create)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(store.createThread(create)).rejects.toMatchObject({ code: "forbidden" });
    await expect(store.updateThreadExecutionSelection(selection)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("anchors an event page on a delivered message and retains nearby Run events", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("event-message-anchor");
    const page = await store.threadEventPageForOwner({
      aroundMessageId: fixture.run.seedInputId,
      maxItems: 20,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(page?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message.placed", runId: fixture.run.id }),
        expect.objectContaining({ type: "run.started", runId: fixture.run.id }),
      ]),
    );
    expect(page?.events.map((event) => event.sequence)).toEqual(
      [...(page?.events ?? [])]
        .map((event) => event.sequence)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
    );
    expect(page?.thread.id).toBe(fixture.thread.id);
    expect(page?.thread.providerSessionId).toBe(fixture.thread.providerSessionId);
    const anchor = page?.events.find((event) => event.type === "message.placed");
    expect(anchor).toBeDefined();
    const anchorBytes = Buffer.byteLength(JSON.stringify([anchor]), "utf8");
    const bounded = await store.threadEventPageForOwner({
      aroundMessageId: fixture.run.seedInputId,
      maxBytes: anchorBytes,
      maxItems: 20,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(bounded?.events).toContainEqual(anchor);
    await expect(
      store.threadEventPageForOwner({
        aroundMessageId: fixture.run.seedInputId,
        maxBytes: anchorBytes - 1,
        maxItems: 20,
        ownerId: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("anchors steer history on a rendered Message rather than its later delivery receipt", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("steer-message-anchor");
    const steered = await store.enqueueThreadInput({
      content: [{ text: "Use this constraint", type: "text" }],
      idempotencyKey: "steer-message-anchor-input",
      policy: "steer",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    if (!steered.command) throw new Error("Expected steer command");
    await store.claimCommand(steered.command.id, "steer-message-anchor-dispatcher");
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { messageId: steered.message.id },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "message.injected",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const page = await store.threadEventPageForOwner({
      aroundMessageId: steered.message.id,
      maxItems: 1,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(page?.events).toHaveLength(1);
    expect(["message.created", "message.placed"]).toContain(page?.events[0]?.type);
    expect(page?.events[0]?.data).toMatchObject({ message: { id: steered.message.id } });
  });

  it("keeps a frozen handoff after native reference creation but before first acceptance", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await startRunFixture("first-context-crash");
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const claude = await store.createHarnessInstance({
      config: { model: "sonnet", modelProviderId: "anthropic" },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Handoff Claude",
      stateKind: "isolated",
    });
    const switched = await store.updateThreadExecutionSelection({
      continuation: { expectedProviderSessionId: fixture.thread.providerSessionId },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "first-context-switch",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(switched.thread.id).toBe(fixture.thread.id);
    expect(switched.thread.providerSessionId).not.toBe(fixture.thread.providerSessionId);
    const first = await enqueueHumanTrigger({
      content: [{ text: "Continue in Claude", type: "text" }],
      idempotencyKey: "first-context-input",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(first.run.providerSessionId).toBe(switched.thread.providerSessionId);
    await store.claimCommand(first.command.id, "first-context-dispatcher");
    const beforeNativeStart = await store.loadRunDispatchContext(first.command.id);
    expect(beforeNativeStart.initialContext?.messages.map((message) => message.id)).toContain(
      fixture.run.seedInputId,
    );
    expect(beforeNativeStart.initialContext?.messages.map((message) => message.id)).not.toContain(
      first.run.seedInputId,
    );
    const identity = {
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
      driverKind: HarnessIdSchema.parse("claude"),
    };
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: identity,
      harnessInstanceId: claude.id,
      leaseTokenHash: "first-context-lease",
      membershipGeneration: 1,
      runnerBootId: "first-context-boot",
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: claude.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "allocated-before-first-input",
      runId: first.run.id,
      runnerBootId: "first-context-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    const afterNativeStart = await store.loadRunDispatchContext(first.command.id);
    expect(afterNativeStart.initialContext).toEqual(beforeNativeStart.initialContext);
    expect(afterNativeStart.executionBinding?.providerSessionReference).toBe(
      "allocated-before-first-input",
    );
  });

  it("finalizes a frozen initial context once from ordered candidates", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await startRunFixture("finalized-initial-context");
    const assistantMessageId = createId("message");
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          content: [{ text: "Earlier assistant answer", type: "text" }],
          messageId: assistantMessageId,
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "assistant.message",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 2,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const claude = await store.createHarnessInstance({
      config: { model: "sonnet", modelProviderId: "anthropic" },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Context finalization Claude",
      stateKind: "isolated",
    });
    await store.updateThreadExecutionSelection({
      continuation: { expectedProviderSessionId: fixture.thread.providerSessionId },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "finalized-context-switch",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const next = await enqueueHumanTrigger({
      content: [{ text: "Continue with less context", type: "text" }],
      idempotencyKey: "finalized-context-next",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(next.command.id, "finalized-context-dispatcher");
    const before = (await store.loadRunDispatchContext(next.command.id)).initialContext;
    expect(before?.finalized).toBe(false);
    expect(before?.messages.map((message) => message.id)).toEqual([
      fixture.run.seedInputId,
      assistantMessageId,
    ]);
    await expect(
      store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [assistantMessageId, fixture.run.seedInputId],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [createId("message")],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const finalized = await store.finalizeRunInitialContext({
      commandId: next.command.id,
      messageIds: [assistantMessageId],
    });
    expect(finalized).toEqual({
      finalized: true,
      messages: [expect.objectContaining({ id: assistantMessageId })],
      omittedCount: before!.omittedCount + 1,
      throughSequence: before!.throughSequence,
    });
    expect(
      await store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [fixture.run.seedInputId],
      }),
    ).toEqual(finalized);
    expect((await store.loadRunDispatchContext(next.command.id)).initialContext).toEqual(finalized);
  });

  it("keeps a compatible native continuation across model selection changes", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("execution-selection");
    const first = await enqueueHumanTrigger({
      content: [{ text: "Use the initial selection", type: "text" }],
      idempotencyKey: "execution-selection-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(first.run).toMatchObject({
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      modelSelection: testModelSelection,
    });
    await store.claimCommand(first.command.id, "execution-selection-dispatcher");
    const firstBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "execution-selection-lease",
      membershipGeneration: 1,
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: firstBinding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "native-session-1",
      runId: first.run.id,
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: firstBinding.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
    });
    await store.failCommand(first.command.id, "Initial selection finished unsuccessfully.");

    const claude = await store.createHarnessInstance({
      config: { model: "sonnet", modelProviderId: "anthropic" },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Claude Code",
      stateKind: "isolated",
    });
    const claudeSelection = ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: { effort: "high" },
      providerId: "anthropic",
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: {
          continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
          driverKind: HarnessIdSchema.parse("claude"),
        },
        harnessInstanceId: claude.id,
        idempotencyKey: "execution-selection-incompatible",
        modelSelection: claudeSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const foreignEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Other computer",
    });
    const foreignHarness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: foreignEnvironmentId,
      name: "Other computer Native",
      stateKind: "ambient",
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: foreignHarness.id,
        idempotencyKey: "execution-selection-foreign-environment",
        modelSelection: testModelSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: foreignHarness.id,
        idempotencyKey: "execution-selection-cross-environment",
        modelSelection: testModelSelection,
        title: "Invalid environment binding",
        workspaceId: fixture.workspace.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    const compatible = await store.createHarnessInstance({
      config: { model: "gpt-5.6-sol" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: fixture.environmentId,
      name: "Compatible Native",
      stateKind: "isolated",
    });
    const updated = await store.updateThreadExecutionSelection({
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: compatible.id,
      idempotencyKey: "execution-selection-compatible",
      modelSelection: testModelSelection,
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(updated.thread).toMatchObject({
      continuationIdentity: testContinuationIdentity,
      environmentId: fixture.environmentId,
      harnessInstanceId: compatible.id,
      modelSelection: testModelSelection,
      status: "failed",
    });
    await expect(
      database
        .selectFrom("providerSessions")
        .select(["active", "harnessInstanceId", "providerSessionReference", "status"])
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      active: true,
      harnessInstanceId: compatible.id,
      providerSessionReference: "native-session-1",
      status: "broken",
    });

    const second = await enqueueHumanTrigger({
      content: [{ text: "Use the new selection", type: "text" }],
      idempotencyKey: "execution-selection-second",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(second.run).toMatchObject({
      environmentId: fixture.environmentId,
      harnessInstanceId: compatible.id,
      modelSelection: testModelSelection,
    });
    await store.claimCommand(second.command.id, "execution-selection-dispatcher");
    const secondBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: compatible.id,
      leaseTokenHash: "execution-selection-second-lease",
      membershipGeneration: 1,
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      runId: second.run.id,
      threadId: fixture.thread.id,
    });
    expect(secondBinding).toMatchObject({
      bindingGeneration: firstBinding.bindingGeneration + 1,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "native-session-1",
    });
    await expect(
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: secondBinding.bindingGeneration,
          data: { status: "running" },
          environmentId: fixture.environmentId,
          ordinal: 0,
          runId: second.run.id,
          threadId: fixture.thread.id,
          type: "run.started",
          workspaceId: fixture.workspace.id,
        }),
        runnerBootId: "execution-selection-boot",
        runnerId: fixture.runnerId,
      }),
    ).resolves.toMatchObject({ wasDuplicate: false });
    expect(first.run).toMatchObject({
      harnessInstanceId: fixture.harnessInstance.id,
      modelSelection: testModelSelection,
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "execution-selection-busy",
        modelSelection: testModelSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  // Only a bound Run can have reached a Runner: a Host failure before the
  // binding proves dispatch never began, while one after it is ambiguous.
  it.for([false, true])(
    "refuses a later start only after an ambiguous Host failure (binding created: %s)",
    async (createBinding, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("unstarted-retry");
      const first = await enqueueHumanTrigger({
        content: [{ text: "First attempt", type: "text" }],
        idempotencyKey: "unstarted-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "unstarted-lease",
        membershipGeneration: 1,
        runnerBootId: "unstarted-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      if (createBinding)
        await store.acquireExecutionBinding({ ...bindingInput, runId: first.run.id });
      await store.failCommand(
        first.command.id,
        "Workspace mount unavailable before engine startup",
      );
      const retry = await enqueueHumanTrigger({
        content: [{ text: "Retry", type: "text" }],
        idempotencyKey: "unstarted-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      const started = store.acquireExecutionBinding({ ...bindingInput, runId: retry.run.id });
      if (createBinding) await expect(started).rejects.toThrow("uncertain native start");
      else await expect(started).resolves.toMatchObject({ runnerBootId: "unstarted-boot" });
    },
  );

  it("refuses an unknown first delivery after its native reference was minted", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("minted-reference-unknown-delivery");
    const first = await enqueueHumanTrigger({
      content: [{ text: "First delivery may have begun", type: "text" }],
      idempotencyKey: "minted-reference-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const bindingInput = {
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "minted-reference-lease",
      membershipGeneration: 1,
      runnerBootId: "minted-reference-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    };
    await store.claimCommand(first.command.id, "test");
    const firstBinding = await store.acquireExecutionBinding({
      ...bindingInput,
      runId: first.run.id,
    });
    await store.bindProviderSession({
      bindingGeneration: firstBinding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "minted-before-acceptance",
      runId: first.run.id,
      runnerBootId: bindingInput.runnerBootId,
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    await store.failCommand(first.command.id, "Runner acknowledgement was lost");
    const retry = await enqueueHumanTrigger({
      content: [{ text: "Continue after uncertainty", type: "text" }],
      idempotencyKey: "minted-reference-retry",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(retry.command.id, "test");
    await expect(
      store.acquireExecutionBinding({ ...bindingInput, runId: retry.run.id }),
    ).rejects.toThrow("uncertain native start");
    const retained = await database
      .selectFrom("runs")
      .select(["providerSessionId", "status"])
      .where("id", "=", retry.run.id)
      .executeTakeFirstOrThrow();
    expect(retained).toEqual({
      providerSessionId: firstBinding.providerSessionId,
      status: "starting",
    });
  });

  it("commits a terminal Run while deferring a successor under corrupt engine selection", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("terminal-selection-corruption");
    const followUp = await store.enqueueThreadInput({
      content: [{ text: "Wait for the current Run", type: "text" }],
      idempotencyKey: "terminal-selection-follow-up",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    expect(followUp.run).toBeNull();
    const incompatible = await store.createHarnessInstance({
      config: { model: "sonnet", modelProviderId: "anthropic" },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Corrupt selection fixture",
      stateKind: "isolated",
    });
    await database
      .updateTable("threads")
      .set({ harnessInstanceId: incompatible.id })
      .where("id", "=", fixture.thread.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: { status: "completed" },
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "run.completed",
          workspaceId: fixture.workspace.id,
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      }),
    ).resolves.toMatchObject({ wasDuplicate: false });
    expect(
      await database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", fixture.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "completed" });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", followUp.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "pending" });
  });

  it.for(["run.failed", "run.interrupted"] as const)(
    "allows first startup after an ordered %s receipt without a provider session",
    async (type, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("startup-receipt");
      const first = await enqueueHumanTrigger({
        content: [{ text: "First", type: "text" }],
        idempotencyKey: "receipt-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "receipt-lease",
        membershipGeneration: 1,
        runnerBootId: "receipt-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      const binding = await store.acquireExecutionBinding({
        ...bindingInput,
        runId: first.run.id,
      });
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: bindingInput.runnerBootId,
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          ordinal: 0,
          runId: first.run.id,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
          type,
          data:
            type === "run.failed"
              ? {
                  code: "runner_execution_error",
                  message: "Mount failed",
                  status: "failed",
                  retryable: false,
                }
              : { status: "interrupted" },
        }),
      });
      const retry = await enqueueHumanTrigger({
        content: [{ text: "Retry", type: "text" }],
        idempotencyKey: "receipt-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      await expect(
        store.acquireExecutionBinding({ ...bindingInput, runId: retry.run.id }),
      ).resolves.toMatchObject({ providerSessionReference: null });
    },
  );
});
