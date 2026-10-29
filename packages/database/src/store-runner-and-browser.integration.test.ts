import type { StoreFixture } from "./store.integration.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  HarnessIdSchema,
  ThreadIdSchema,
  createId,
  type Workspace,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  browserSessionMaxThreads,
  browserUsageRunBatchSize,
  browserUsageTabsPerRun,
  createBrowserSessionId,
  type PendingAgentEvent,
  type RunnerDescriptor,
  type RunnerModuleName,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { describe, expect } from "vitest";
import {
  configuredBootstrapEnrollmentLifetimeMs,
  OpensteerStore,
  type AgentThreadListPage,
} from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testWorkspaceProfile,
  reachOnlyModules,
  writeBrowserUsageArtifact,
  enrollTestRunner,
  testRunnerDescriptor,
  fingerprint,
  pendingEvent,
  liveRequest,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("delivers secret input through ciphertext while redacting durable projections", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("secret-input");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Request a secret", type: "text" }],
      idempotencyKey: "secret-input-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-secret-input");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-secret-input",
      membershipGeneration: 1,
      runnerBootId: "boot-secret-input",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-secret-input",
        runnerId,
      });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
      workspaceId: workspace.id,
    } as const;
    await commit(
      pendingEvent({ ...base, data: { status: "running" }, ordinal: 0, type: "run.started" }),
    );
    const requestId = createId("request");
    await commit(
      pendingEvent({
        ...base,
        data: {
          request: liveRequest({
            harnessInstanceId: thread.harnessInstanceId,
            id: requestId,
            presentation: {
              fields: [
                {
                  id: "password",
                  multiSelect: false,
                  prompt: "Enter the password",
                  secret: true,
                },
              ],
              kind: "form",
              title: "Secret needed",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
            workspaceId: workspace.id,
          }),
        },
        ordinal: 1,
        type: "request.opened",
      }),
    );

    const secretAnswer = "must-not-reach-durable-storage-7e196b";
    const encrypted = sealedTestRequestResponse();
    const secretControl = {
      requestId,
      idempotencyKey: "secret-input-control",
      requestedBy: userId,
      response: { answers: { password: [secretAnswer] }, kind: "form" as const },
      runId: turn.run.id,
      sealedResponse: encrypted,
      threadId: thread.id,
      type: "request.respond" as const,
    };
    const firstResolution = await store.enqueueRunnerControl(secretControl);
    const retriedResolution = await store.enqueueRunnerControl(secretControl);
    expect(firstResolution.wasDuplicate).toBe(false);
    expect(retriedResolution.wasDuplicate).toBe(true);
    await store.claimCommand(firstResolution.command.id, "secret-action-worker");
    await store.succeedCommand(firstResolution.command.id);
    await expect(
      store.enqueueRunnerControl({
        ...secretControl,
        response: { answers: { password: ["different"] }, kind: "form" },
        sealedResponse: {
          ...encrypted,
          requestFingerprint: "hmac-sha256-v1:1:different-action-response",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const storedCommand = await database
      .selectFrom("commands")
      .select(["encryptedRequestResponse", "payload"])
      .where("idempotencyKey", "=", "secret-input-control")
      .executeTakeFirstOrThrow();
    expect(storedCommand.encryptedRequestResponse).toEqual(encrypted.envelope);
    expect(JSON.stringify(storedCommand.payload)).not.toContain(secretAnswer);
    const storedRequest = await database
      .selectFrom("requests")
      .select("response")
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(storedRequest.response)).not.toContain(secretAnswer);

    const durableEvents = await database
      .selectFrom("workspaceEvents")
      .select(["data", "type"])
      .where("runId", "=", turn.run.id)
      .execute();
    expect(durableEvents.some((event) => event.type === "request.resolved")).toBe(true);
    expect(JSON.stringify(durableEvents)).not.toContain(secretAnswer);
    expect(
      await database
        .selectFrom("requests")
        .select(["id", "response", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: requestId,
      response: { answers: { password: [] }, kind: "form" },
      status: "fulfilled",
    });
  });

  it("rolls back a direct command claim when its Run cannot enter starting", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const { thread, userId } = await createRunFixture("claim-atomicity");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Claim this atomically" }],
      idempotencyKey: "claim-atomicity-turn",
      requestedBy: userId,
      threadId: thread.id,
    });

    await sql`
      create function opensteer_test_reject_starting()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.status = 'starting' then
          raise exception 'forced starting failure';
        end if;
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger opensteer_test_reject_starting
      before update on runs
      for each row execute function opensteer_test_reject_starting()
    `.execute(database);

    try {
      await expect(
        store.claimCommand(turn.command.id, "host-worker-claim-atomicity"),
      ).rejects.toThrow(/forced starting failure/);

      expect(
        await database
          .selectFrom("commands")
          .select(["attempts", "dispatcherId", "status"])
          .where("id", "=", turn.command.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ attempts: 0, dispatcherId: null, status: "pending" });
      expect(
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", turn.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "queued" });
    } finally {
      await sql`drop trigger if exists opensteer_test_reject_starting on runs`.execute(database);
      await sql`drop function if exists opensteer_test_reject_starting()`.execute(database);
    }
  });

  it("locks a Run before its Command when claiming ambiguous requeued work", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const { thread, userId } = await createRunFixture("claim-lock-order");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Claim without a Run-to-Command deadlock" }],
      idempotencyKey: "claim-lock-order-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    let releaseRunLock: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });
    let announceRunLock: () => void = () => {};
    const runLockAcquired = new Promise<void>((resolve) => {
      announceRunLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("runs")
        .select("id")
        .where("id", "=", turn.run.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceRunLock();
      await releaseSignal;
    });
    await runLockAcquired;

    const claim = store.claimCommand(turn.command.id, "host-worker-claim-lock-order");
    void claim.catch(() => undefined);
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);

      // A terminal event takes the same Run lock and then the Command lock. If
      // claim held the Command while waiting above, this NOWAIT read would
      // fail and prove the old deadlock cycle still exists.
      await expect(
        database
          .transaction()
          .execute((transaction) =>
            transaction
              .selectFrom("commands")
              .select("id")
              .where("id", "=", turn.command.id)
              .forUpdate()
              .noWait()
              .executeTakeFirstOrThrow(),
          ),
      ).resolves.toEqual({ id: turn.command.id });
    } finally {
      releaseRunLock();
      await blocker;
    }

    await expect(claim).resolves.toMatchObject({
      command: { id: turn.command.id, status: "dispatched" },
    });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "starting" });
  });

  it("locks a Run before retrying its Command and rolls the pair back atomically", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { thread, userId } = await createRunFixture("retry-lock-order");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Retry without a Run-to-Command deadlock" }],
      idempotencyKey: "retry-lock-order-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-retry-lock-order");

    let releaseRunLock: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });
    let announceRunLock: () => void = () => {};
    const runLockAcquired = new Promise<void>((resolve) => {
      announceRunLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("runs")
        .select("id")
        .where("id", "=", turn.run.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceRunLock();
      await releaseSignal;
    });
    await runLockAcquired;

    const retry = store.retryCommand(turn.command.id, new Error("Runner was offline"));
    void retry.catch(() => undefined);
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);
      await expect(
        database
          .transaction()
          .execute((transaction) =>
            transaction
              .selectFrom("commands")
              .select("id")
              .where("id", "=", turn.command.id)
              .forUpdate()
              .noWait()
              .executeTakeFirstOrThrow(),
          ),
      ).resolves.toEqual({ id: turn.command.id });
    } finally {
      releaseRunLock();
      await blocker;
    }
    await retry;
    await expect(
      database
        .selectFrom("commands")
        .select(["dispatcherId", "status"])
        .where("id", "=", turn.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ dispatcherId: null, status: "pending" });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued" });

    await store.claimCommand(turn.command.id, "host-worker-retry-rollback");
    await sql`
      create function opensteer_test_reject_queued()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.status = 'queued' then
          raise exception 'forced queued failure';
        end if;
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger opensteer_test_reject_queued
      before update on runs
      for each row execute function opensteer_test_reject_queued()
    `.execute(database);
    try {
      await expect(
        store.retryCommand(turn.command.id, new Error("Force retry rollback")),
      ).rejects.toThrow(/forced queued failure/);
      await expect(
        database
          .selectFrom("commands")
          .select(["dispatcherId", "status"])
          .where("id", "=", turn.command.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ dispatcherId: "host-worker-retry-rollback", status: "dispatched" });
      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", turn.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "starting" });
    } finally {
      await sql`drop trigger if exists opensteer_test_reject_queued on runs`.execute(database);
      await sql`drop function if exists opensteer_test_reject_queued()`.execute(database);
    }
  });

  it("locks the Workspace before the Thread when admitting inbox input", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, enqueueHumanTrigger } = storeFixture;
    const { thread, userId, workspace } = await createRunFixture("enqueue-lock-order");
    let releaseWorkspaceLock: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseWorkspaceLock = resolve;
    });
    let announceWorkspaceLock: () => void = () => {};
    const workspaceLockAcquired = new Promise<void>((resolve) => {
      announceWorkspaceLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", workspace.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceWorkspaceLock();
      await releaseSignal;
    });
    await workspaceLockAcquired;

    const enqueue = enqueueHumanTrigger({
      content: [{ type: "text", text: "Queue behind the Workspace lock" }],
      idempotencyKey: "enqueue-lock-order-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    void enqueue.catch(() => undefined);
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);
      await expect(
        database
          .transaction()
          .execute((transaction) =>
            transaction
              .selectFrom("threads")
              .select("id")
              .where("id", "=", thread.id)
              .forUpdate()
              .noWait()
              .executeTakeFirstOrThrow(),
          ),
      ).resolves.toEqual({ id: thread.id });
    } finally {
      releaseWorkspaceLock();
      await blocker;
    }

    await expect(enqueue).resolves.toMatchObject({
      command: { status: "pending", type: "run.execute" },
      run: { status: "queued", threadId: thread.id },
    });
  });

  it("projects a non-retryable dispatch failure exactly once without stranding queued work", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { runnerId, thread, userId } = await createRunFixture("dispatch_failure");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "This dispatch will fail" }],
      idempotencyKey: "dispatch-failure-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-dispatch-failure");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-dispatch-failure",
      membershipGeneration: 1,
      runnerBootId: "boot-dispatch-failure",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const laterInput = await store.enqueueThreadInput({
      content: [{ type: "text", text: "This queued turn must survive" }],
      idempotencyKey: "dispatch-failure-later",
      policy: "queue",
      source: { kind: "human" },
      requestedBy: userId,
      threadId: thread.id,
    });

    const failure = await store.failCommand(
      turn.command.id,
      "The selected AI engine is not available.",
    );
    const laterRun = await database
      .selectFrom("runs")
      .selectAll()
      .where("seedInputId", "=", laterInput.message.id)
      .executeTakeFirstOrThrow();
    const laterCommand = await database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", laterRun.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const later = { run: laterRun, command: laterCommand };
    expect(failure).toMatchObject([
      {
        data: {
          code: "dispatch_failed",
          message: "The selected AI engine is not available.",
          retryable: false,
          status: "failed",
        },
        runId: turn.run.id,
        type: "run.failed",
      },
      {
        data: { input: { cancelReason: "run-ended-before-start", state: "cancelled" } },
        runId: turn.run.id,
        type: "thread-input.updated",
      },
      { type: "message.placed", runId: later.run.id },
      { type: "run.queued", runId: later.run.id },
    ]);
    await expect(store.failCommand(turn.command.id, "ambiguous retry")).resolves.toEqual([]);
    expect(JSON.stringify(failure)).not.toContain("top-secret-provider-token");
    expect(
      await database
        .selectFrom("workspaceEvents")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("runId", "=", turn.run.id)
        .where("type", "=", "run.failed")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      database
        .selectFrom("providerSessions")
        .select("status")
        .where("id", "=", binding.providerSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "broken" });
    await expect(
      database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "running" });

    await store.claimCommand(later.command.id, "host-worker-retryable-dispatch");
    const retryEvent = await store.retryCommand(
      later.command.id,
      new Error("Runner temporarily offline"),
    );
    expect(retryEvent).toMatchObject([
      {
        data: { status: "queued" },
        runId: later.run.id,
        type: "run.status",
      },
    ]);
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", later.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued" });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", later.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "pending" });
    expect(
      await database
        .selectFrom("workspaceEvents")
        .select("eventId")
        .where("runId", "=", later.run.id)
        .where("type", "=", "run.failed")
        .execute(),
    ).toEqual([]);
  });

  it("queues the next work item when the first queued Run fails before Runner start", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const { thread, userId } = await createRunFixture("preclaim-failure-queue-drain");
    const first = await store.enqueueThreadInput({
      content: [{ type: "text", text: "First queued task" }],
      idempotencyKey: "preclaim-failure-first",
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    const second = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Second queued task" }],
      idempotencyKey: "preclaim-failure-second",
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    const report = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Passive status report" }],
      idempotencyKey: "preclaim-failure-report",
      policy: "report",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!first.command || !first.run) throw new Error("Expected the first queued Run");
    expect(second).toMatchObject({ command: null, disposition: "pending", run: null });

    await store.claimCommand(first.command.id, "preclaim-failure-dispatcher");
    const events = await store.failCommand(first.command.id, "Failed before Runner start");
    expect(events.map(({ type }) => type)).toEqual([
      "run.failed",
      "thread-input.updated",
      "thread-input.updated",
      "message.placed",
      "run.queued",
    ]);
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", thread.id)
        .orderBy("runOrdinal", "asc")
        .execute(),
    ).resolves.toEqual([
      { seedInputId: first.message.id, status: "failed" },
      { seedInputId: second.message.id, status: "queued" },
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", report.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runId: first.run.id, state: "unknown" });
  });

  it("commits one terminal outcome when dispatch failure races a Runner terminal event", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("dispatch_failure_race");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Race the terminal projection" }],
      idempotencyKey: "dispatch-failure-race-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-dispatch-failure-race");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-dispatch-failure-race",
      membershipGeneration: 1,
      runnerBootId: "boot-dispatch-failure-race",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId,
        ordinal: 0,
        runId: turn.run.id,
        threadId: thread.id,
        type: "run.started",
        workspaceId: workspace.id,
      }),
      runnerBootId: "boot-dispatch-failure-race",
      runnerId,
    });

    const outcomes = await Promise.allSettled([
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: { status: "completed" },
          environmentId,
          ordinal: 1,
          runId: turn.run.id,
          threadId: thread.id,
          type: "run.completed",
          workspaceId: workspace.id,
        }),
        runnerBootId: "boot-dispatch-failure-race",
        runnerId,
      }),
      store.failCommand(turn.command.id, "Dispatch failed concurrently"),
    ]);
    expect(outcomes[1]?.status).toBe("fulfilled");
    const terminalEvents = await database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", turn.run.id)
      .where("type", "in", ["run.completed", "run.failed"])
      .execute();
    expect(terminalEvents).toHaveLength(1);
    const run = await database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", turn.run.id)
      .executeTakeFirstOrThrow();
    expect([
      ["run.completed", "completed"],
      ["run.failed", "failed"],
    ]).toContainEqual([terminalEvents[0]?.type, run.status]);
  });

  it("fails active Runs only for the exact disconnected Runner boot", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("disconnect_recovery");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Wait for my input" }],
      idempotencyKey: "disconnect-recovery-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-disconnect-recovery");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-disconnect-recovery",
      membershipGeneration: 1,
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
      workspaceId: workspace.id,
    } as const;
    const requestId = createId("request");
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        ...base,
        data: { status: "running" },
        ordinal: 0,
        type: "run.started",
      }),
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        ...base,
        data: {
          request: liveRequest({
            harnessInstanceId: thread.harnessInstanceId,
            id: requestId,
            presentation: {
              fields: [{ id: "answer", multiSelect: false, prompt: "Continue?", secret: false }],
              kind: "form",
              title: "Input needed",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
            workspaceId: workspace.id,
          }),
        },
        ordinal: 1,
        type: "request.opened",
      }),
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });

    await expect(
      store.failActiveRunsForRunnerDisconnect({
        activeRunIds: [createId("run")],
        runnerBootId: "boot-disconnect-recovery",
        runnerId,
      }),
    ).resolves.toEqual({ events: [], terminatedRuns: [] });
    await expect(
      store.failActiveRunsForRunnerDisconnect({
        activeRunIds: [turn.run.id],
        runnerBootId: "another-boot",
        runnerId,
      }),
    ).resolves.toEqual({ events: [], terminatedRuns: [] });
    const recovered = await store.failActiveRunsForRunnerDisconnect({
      activeRunIds: [turn.run.id],
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    expect(recovered.terminatedRuns).toEqual([
      { environmentId, runId: turn.run.id, threadId: thread.id },
    ]);
    expect(recovered.events[0]).toMatchObject({
      data: { code: "runner_disconnected", retryable: false, status: "failed" },
      runId: turn.run.id,
      type: "run.failed",
    });
    const lateCancellation = await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { requestId, reason: "source-closed" },
        environmentId,
        ordinal: 2,
        runId: turn.run.id,
        threadId: thread.id,
        type: "request.cancelled",
        workspaceId: workspace.id,
      }),
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    expect(lateCancellation.wasDuplicate).toBe(true);
    const lateTerminal = await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "interrupted" },
        environmentId,
        ordinal: 3,
        runId: turn.run.id,
        threadId: thread.id,
        type: "run.interrupted",
        workspaceId: workspace.id,
      }),
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    expect(lateTerminal.wasDuplicate).toBe(true);
    await expect(
      store.failActiveRunsForRunnerDisconnect({
        activeRunIds: [turn.run.id],
        runnerBootId: "boot-disconnect-recovery",
        runnerId,
      }),
    ).resolves.toEqual({ events: [], terminatedRuns: [] });

    expect(
      await database
        .selectFrom("requests")
        .select(["cancellationReason", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ cancellationReason: "process-lost", status: "cancelled" });
    await expect(
      database
        .selectFrom("commands")
        .select(["status"])
        .where("id", "=", turn.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      database
        .selectFrom("providerSessions")
        .select(["status"])
        .where("id", "=", binding.providerSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "broken" });
    await expect(
      database
        .selectFrom("workspaceEvents")
        .select(["runnerBindingGeneration", "runnerBootId", "runnerId", "runnerOrdinal"])
        .where("eventId", "=", recovered.events[0]!.eventId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runnerBindingGeneration: null,
      runnerBootId: null,
      runnerId: null,
      runnerOrdinal: null,
    });
  });

  it("recovers what a replaced Runner boot left, and fences a racing terminal outcome", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("restart_recovery");
    const abandoned = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Crash before binding" }],
      idempotencyKey: "restart-recovery-abandoned",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(abandoned.command.id, "host-before-restart");
    const abandonedBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-before-restart",
      membershipGeneration: 1,
      runnerBootId: "boot-before-restart",
      runnerId,
      runId: abandoned.run.id,
      threadId: thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: abandonedBinding.bindingGeneration,
      harnessInstanceId: thread.harnessInstanceId,
      providerSessionId: abandonedBinding.providerSessionId,
      providerSessionReference: "native-session-before-restart",
      runId: abandoned.run.id,
      runnerBootId: "boot-before-restart",
      runnerId,
      threadId: thread.id,
    });

    // A native reference permits recovery; cross-boot containment is checked at dispatch.
    const attachAfterRestart = (runnerBootId: string) =>
      store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId,
        runnerId,
      });
    const startupEvents = (await attachAfterRestart("boot-after-restart")).events;
    expect(startupEvents).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ reason: "recovery", attempt: 2 }),
        runId: abandoned.run.id,
        type: "run.restarted",
      }),
    );
    expect(startupEvents.some((event) => event.type === "run.failed")).toBe(false);
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "bindingGeneration"])
        .where("id", "=", abandoned.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued", bindingGeneration: null });
    await expect(
      database
        .selectFrom("runAttempts")
        .select(["reason", "outcome"])
        .where("runId", "=", abandoned.run.id)
        .orderBy("ordinal", "asc")
        .execute(),
    ).resolves.toEqual([
      { reason: "initial", outcome: "interrupted" },
      { reason: "recovery", outcome: null },
    ]);
    await store.enqueueRunnerControl({
      idempotencyKey: "stop-recovered-before-next-race",
      requestedBy: userId,
      runId: abandoned.run.id,
      threadId: thread.id,
      type: "run.interrupt",
    });
    await store.resumeThreadInputQueue({
      idempotencyKey: "resume-after-recovery-stop",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.updateThreadExecutionSelection({
      continuation: { expectedProviderSessionId: abandonedBinding.providerSessionId },
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      idempotencyKey: "restart-recovery-explicit-new-session",
      modelSelection: testModelSelection,
      requestedBy: userId,
      threadId: thread.id,
    });

    const racing = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Race terminal recovery" }],
      idempotencyKey: "restart-recovery-race",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(racing.command.id, "host-after-restart");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-restart-recovery",
      membershipGeneration: 1,
      runnerBootId: "boot-restart-recovery",
      runnerId,
      runId: racing.run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId,
        ordinal: 0,
        runId: racing.run.id,
        threadId: thread.id,
        type: "run.started",
        workspaceId: workspace.id,
      }),
      runnerBootId: "boot-restart-recovery",
      runnerId,
    });
    const completed = store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "completed" },
        environmentId,
        ordinal: 1,
        runId: racing.run.id,
        threadId: thread.id,
        type: "run.completed",
        workspaceId: workspace.id,
      }),
      runnerBootId: "boot-restart-recovery",
      runnerId,
    });
    const outcomes = await Promise.allSettled([
      completed,
      attachAfterRestart("boot-after-second-restart"),
    ]);
    expect(outcomes[1]?.status).toBe("fulfilled");

    const terminalEvents = await database
      .selectFrom("workspaceEvents")
      .select(["type"])
      .where("runId", "=", racing.run.id)
      .where("type", "in", ["run.completed", "run.failed"])
      .execute();
    expect(terminalEvents).toHaveLength(1);
    const run = await database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", racing.run.id)
      .executeTakeFirstOrThrow();
    expect([
      ["run.completed", "completed"],
      ["run.failed", "failed"],
    ]).toContainEqual([terminalEvents[0]?.type, run.status]);
  });

  it("lists and reads only owner-scoped coordination records with bounded messages", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("owner-coordination");
    const secondWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_owner_coordination_second",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-owner-coordination-second",
      name: "Second owned workspace",
      status: "ready",
    });
    const { thread: secondThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-owner-coordination-second",
      modelSelection: testModelSelection,
      parentThreadId: fixture.thread.id,
      title: "Second owned thread",
      workspaceId: secondWorkspace.id,
    });
    const foreignOwnerId = await store.createUser("Foreign owner");
    const foreignWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_owner_coordination_foreign",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: foreignOwnerId,
      idempotencyKey: "workspace-owner-coordination-foreign",
      name: "Foreign workspace",
      status: "ready",
    });
    const { thread: foreignThread } = await store.createThread({
      createdBy: foreignOwnerId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-owner-coordination-foreign",
      modelSelection: testModelSelection,
      title: "Foreign thread",
      workspaceId: foreignWorkspace.id,
    });

    for (const index of [1, 2, 3]) {
      await store.enqueueThreadInput({
        content: [{ text: `Message ${index}`, type: "text" }],
        idempotencyKey: `message-owner-coordination-${index}`,
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
        threadId: secondThread.id,
      });
    }

    expect((await store.listWorkspacesForOwner(fixture.userId)).map(({ id }) => id)).toEqual(
      expect.arrayContaining([fixture.workspace.id, secondWorkspace.id]),
    );
    expect(await store.getWorkspaceForOwner(foreignWorkspace.id, fixture.userId)).toBeNull();
    expect((await store.listThreadsForOwner(fixture.userId)).map(({ id }) => id)).toEqual(
      expect.arrayContaining([fixture.thread.id, secondThread.id]),
    );
    expect(await store.getThreadForOwner(foreignThread.id, fixture.userId)).toBeNull();
    const recent = await store.readThreadForOwner(secondThread.id, fixture.userId, 2);
    expect(
      recent?.messages.map((entry) =>
        entry.content
          .map((part) =>
            part.type === "text"
              ? part.text
              : part.type === "browser-page"
                ? part.title
                : part.name,
          )
          .join(""),
      ),
    ).toEqual(["Message 2", "Message 3"]);
    expect(await store.readThreadForOwner(foreignThread.id, fixture.userId, 2)).toBeNull();
  });

  it("lists agent-visible Threads within their scope, filter, and honest window", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("agent-thread-list");
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_agent_thread_list_specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "workspace-agent-thread-list-specialized",
      name: "Specialized listing workspace",
      status: "ready",
    });
    const makeThread = async (
      suffix: string,
      title: string,
      workspaceId: Workspace["id"],
      parentThreadId?: string,
    ) => {
      const created = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `thread-agent-thread-list-${suffix}`,
        modelSelection: testModelSelection,
        ...(parentThreadId ? { parentThreadId: ThreadIdSchema.parse(parentThreadId) } : {}),
        title,
        workspaceId,
      });
      return created.thread;
    };
    const child = await makeThread(
      "child",
      "Contract review",
      fixture.workspace.id,
      fixture.thread.id,
    );
    const sibling = await makeThread(
      "sibling",
      "Pricing review",
      fixture.workspace.id,
      fixture.thread.id,
    );
    const grandchild = await makeThread(
      "grandchild",
      "Clause extraction",
      fixture.workspace.id,
      child.id,
    );
    const unrelated = await makeThread("unrelated", "Report_2026 100% done", fixture.workspace.id);
    const specializedThread = await makeThread("specialized", "Client onboarding", specialized.id);
    const foreignOwnerId = await store.createUser("Foreign listing owner");
    const foreignWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_agent_thread_list_foreign",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: foreignOwnerId,
      idempotencyKey: "workspace-agent-thread-list-foreign",
      name: "Foreign listing workspace",
      status: "ready",
    });
    const { thread: foreignThread } = await store.createThread({
      createdBy: foreignOwnerId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-agent-thread-list-foreign",
      modelSelection: testModelSelection,
      title: "Foreign review",
      workspaceId: foreignWorkspace.id,
    });
    const ownedIds = [
      fixture.thread.id,
      child.id,
      sibling.id,
      grandchild.id,
      unrelated.id,
      specializedThread.id,
    ];

    const everything = await store.agentThreadPageForOwner({
      maxItems: 50,
      ownerId: fixture.userId,
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect([...everything.threads].map(({ id }) => id).sort()).toEqual([...ownedIds].sort());
    expect(everything.threads.map(({ id }) => id)).not.toContain(foreignThread.id);
    expect(everything.window).toMatchObject({
      hasMore: false,
      itemCount: ownedIds.length,
      nextBefore: null,
      totalItems: ownedIds.length,
    });
    expect(everything.threads.find(({ id }) => id === specializedThread.id)).toMatchObject({
      parentThreadId: null,
      status: "idle",
      title: "Client onboarding",
      workspaceId: specialized.id,
      workspaceName: "Specialized listing workspace",
    });

    const scoped = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      scope: { kind: "workspace", workspaceId: specialized.id },
      scopeId: specializedThread.id,
    });
    expect(scoped.threads.map(({ id }) => id)).toEqual([specializedThread.id]);
    expect(scoped.window.totalItems).toBe(1);

    const lineage = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      scope: { kind: "lineage", threadId: grandchild.id },
      scopeId: grandchild.id,
    });
    expect([...lineage.threads].map(({ id }) => id).sort()).toEqual(
      [fixture.thread.id, child.id, sibling.id, grandchild.id].sort(),
    );

    const paged: string[] = [];
    let before: string | undefined;
    for (let request = 0; request < 10; request += 1) {
      const page: AgentThreadListPage = await store.agentThreadPageForOwner({
        ...(before ? { before } : {}),
        maxItems: 2,
        ownerId: fixture.userId,
        scope: { kind: "user" },
        scopeId: fixture.thread.id,
      });
      paged.push(...page.threads.map(({ id }) => id));
      expect(page.window.totalItems).toBe(ownedIds.length);
      if (!page.window.nextBefore) {
        expect(page.window.hasMore).toBe(false);
        break;
      }
      expect(page.window.hasMore).toBe(true);
      expect(page.window.itemCount).toBe(2);
      before = page.window.nextBefore;
    }
    expect(paged).toEqual(everything.threads.map(({ id }) => id));

    const matched = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      query: "REVIEW",
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect([...matched.threads].map(({ id }) => id).sort()).toEqual([child.id, sibling.id].sort());
    expect(matched.window.totalItems).toBe(2);

    const escaped = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      query: "100%",
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect(escaped.threads.map(({ id }) => id)).toEqual([unrelated.id]);
    const underscore = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      query: "_",
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect(underscore.threads.map(({ id }) => id)).toEqual([unrelated.id]);
    const wildcard = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      query: "%",
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect(wildcard.threads.map(({ id }) => id)).toEqual([unrelated.id]);

    const clamped = await store.agentThreadPageForOwner({
      maxItems: 500,
      ownerId: fixture.userId,
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect(clamped.window.itemCount).toBe(ownedIds.length);

    const truncated = await store.agentThreadPageForOwner({
      maxBytes: 1,
      maxItems: 3,
      ownerId: fixture.userId,
      scope: { kind: "user" },
      scopeId: fixture.thread.id,
    });
    expect(truncated.threads).toHaveLength(0);
    expect(truncated.window).toMatchObject({
      hasMore: true,
      itemCount: 0,
      nextBefore: null,
      totalItems: ownedIds.length,
    });

    await expect(
      store.agentThreadPageForOwner({
        before: everything.window.nextBefore ?? "not-a-cursor",
        ownerId: fixture.userId,
        scope: { kind: "user" },
        scopeId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(
      (
        await store.agentThreadPageForOwner({
          ownerId: foreignOwnerId,
          scope: { kind: "user" },
          scopeId: foreignThread.id,
        })
      ).threads.map(({ id }) => id),
    ).toEqual([foreignThread.id]);
  });

  it("rejects storage capacity policies that do not match their Workspace backing", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const userId = await store.createUser("Storage invariant owner");
    await expect(
      store.createWorkspace({
        backing: {
          bindingId: createId("workspaceBinding"),
          generation: 1,
          kind: "local-directory",
          ownerEnvironmentId: createId("environment"),
          storageAuthorityId: createId("storageAuthority"),
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: userId,
        idempotencyKey: "workspace-invalid-local-capacity",
        name: "Invalid local Workspace",
        status: "ready",
      }),
    ).rejects.toBeDefined();
    await expect(
      store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_invalid_portablefs_capacity",
        },
        capacityPolicy: { kind: "host-filesystem" },
        createdBy: userId,
        idempotencyKey: "workspace-invalid-portablefs-capacity",
        name: "Invalid PortableFS Workspace",
        status: "ready",
      }),
    ).rejects.toBeDefined();
    await expect(
      database
        .selectFrom("workspaces")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ count: "0" });
  });

  it("enforces owner-scoped cross-Workspace lineage and immutable thread bindings", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const userId = await store.createUser("Alex");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: userId,
      environmentId,
      name: "Main",
      runnerId,
      tokenSuffix: "immutable",
    });
    const otherEnvironmentId = await store.createEnvironment({
      kind: "main",
      name: "Other placement",
      runnerId,
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_immutable",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      name: "Workspace",
      idempotencyKey: "workspace-immutable",
      status: "ready",
    });
    expect(workspace.kind).toBe("main");
    const materializedBacking = {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: "wsp_materialized_after_create",
    } as const;
    await store.setWorkspaceProvisioningResult({
      backing: materializedBacking,
      expectedBacking: workspace.backing,
      status: "ready",
      workspaceId: workspace.id,
    });
    await expect(
      store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_immutable",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: userId,
        idempotencyKey: "workspace-immutable",
        name: "Workspace",
        status: "ready",
      }),
    ).resolves.toMatchObject({
      backing: materializedBacking,
      id: workspace.id,
      name: "Workspace",
    });
    await expect(
      store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "ignored_on_retry",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: userId,
        idempotencyKey: "workspace-immutable",
        name: "Changed retry",
        status: "ready",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_second_main",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: userId,
        idempotencyKey: "workspace-second-main",
        kind: "main",
        name: "Second Main",
        status: "ready",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const harnessInstance = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const { thread } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: "thread-immutable",
      modelSelection: testModelSelection,
      title: "Bound thread",
      workspaceId: workspace.id,
    });
    expect(thread.capabilityProfileId).toBe("main");
    const ownerPrincipal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    // The durable rule is a ceiling, not an equality: a root Thread cannot
    // claim a delegated child's profile, while a Thread that deliberately runs
    // below its owner's Main authority — a channel route in "anyone" mode — is
    // allowed exactly because it asks for less.
    const bypassThreadId = createId("thread");
    const rootThreadValues = {
      icon: null,
      iconSource: "provisional" as const,
      color: "blue" as const,
      createdBy: userId,
      createdByPrincipalId: ownerPrincipal.id,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      lineageRootThreadId: bypassThreadId,
      listed: true,
      modelSelection: testModelSelection,
      parentThreadId: null,
      status: "idle" as const,
      workspaceId: workspace.id,
    };
    await expect(
      database
        .insertInto("threads")
        .values({
          ...rootThreadValues,
          capabilityProfileId: "delegated",
          id: bypassThreadId,
          title: "Mismatched capability bypass",
        })
        .execute(),
    ).rejects.toThrow(/capability profile does not match/u);
    const reducedThreadId = createId("thread");
    await expect(
      database
        .insertInto("threads")
        .values({
          ...rootThreadValues,
          capabilityProfileId: "workspace",
          id: reducedThreadId,
          lineageRootThreadId: reducedThreadId,
          title: "Deliberately reduced capability",
        })
        .execute(),
    ).resolves.toHaveLength(1);
    const childInput = {
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: "thread-child",
      modelSelection: testModelSelection,
      parentThreadId: thread.id,
      title: "Delegated child",
      workspaceId: workspace.id,
    } as const;
    const { thread: child } = await store.createThread(childInput);
    expect(child.parentThreadId).toBe(thread.id);
    expect(child.capabilityProfileId).toBe("delegated");
    const repeatedChild = await store.createThread(childInput);
    expect(repeatedChild.wasDuplicate).toBe(true);
    expect(repeatedChild.thread.id).toBe(child.id);
    await expect(
      store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: "thread-child",
        modelSelection: testModelSelection,
        title: "Delegated child",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createThread({ ...childInput, title: "Changed retry title" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const otherWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_other_lineage",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      name: "Other workspace",
      idempotencyKey: "workspace-other-lineage",
      status: "ready",
    });
    expect(otherWorkspace.kind).toBe("specialized");
    const crossWorkspaceCreation = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: "thread-cross-workspace-child",
      modelSelection: testModelSelection,
      parentThreadId: thread.id,
      title: "Cross-Workspace child",
      workspaceId: otherWorkspace.id,
    });
    const crossWorkspaceChild = crossWorkspaceCreation.thread;
    expect(crossWorkspaceChild.parentThreadId).toBe(thread.id);
    expect(crossWorkspaceChild.workspaceId).toBe(otherWorkspace.id);
    expect(crossWorkspaceChild.capabilityProfileId).toBe("delegated");
    expect(crossWorkspaceCreation.event).toMatchObject({
      threadId: crossWorkspaceChild.id,
      type: "thread.created",
      workspaceId: otherWorkspace.id,
    });

    const foreignUserId = await store.createUser("Other owner");
    const foreignWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_foreign_lineage",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: foreignUserId,
      name: "Foreign workspace",
      idempotencyKey: "workspace-foreign-lineage",
      status: "ready",
    });
    await expect(
      store.createThread({
        createdBy: foreignUserId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: "thread-foreign-workspace-child",
        modelSelection: testModelSelection,
        parentThreadId: thread.id,
        title: "Invalid foreign child",
        workspaceId: foreignWorkspace.id,
      }),
    ).rejects.toThrow(/member of both/);
    await expect(
      store.createThread({
        createdBy: foreignUserId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: "thread-wrong-creator",
        modelSelection: testModelSelection,
        title: "Wrong creator",
        workspaceId: otherWorkspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const foreignPrincipal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", foreignUserId)
      .executeTakeFirstOrThrow();
    const foreignBypassThreadId = createId("thread");
    await expect(
      database
        .insertInto("threads")
        .values({
          capabilityProfileId: "workspace",
          createdBy: foreignUserId,
          createdByPrincipalId: foreignPrincipal.id,
          environmentId,
          harnessInstanceId: harnessInstance.id,
          icon: null,
          iconSource: "provisional",
          color: "blue",
          id: foreignBypassThreadId,
          lineageRootThreadId: foreignBypassThreadId,
          listed: true,
          modelSelection: testModelSelection,
          parentThreadId: null,
          status: "idle",
          title: "Bypass attempt",
          workspaceId: otherWorkspace.id,
        })
        .execute(),
    ).rejects.toThrow(/creator must be an active workspace member/);

    await expect(
      database.deleteFrom("threads").where("id", "=", thread.id).execute(),
    ).rejects.toThrow(/foreign key constraint/);

    await expect(
      database
        .updateTable("threads")
        .set({ environmentId: otherEnvironmentId })
        .where("id", "=", thread.id)
        .execute(),
    ).rejects.toThrow(/execution environment.*immutable/);
    await expect(
      database
        .updateTable("threads")
        .set({ parentThreadId: child.id })
        .where("id", "=", thread.id)
        .execute(),
    ).rejects.toThrow(/lineage.*immutable/);
    await expect(
      database
        .updateTable("threads")
        .set({ workspaceId: otherWorkspace.id })
        .where("id", "=", child.id)
        .execute(),
    ).rejects.toThrow(/ownership.*immutable/);
    await expect(
      database
        .updateTable("threads")
        .set({ capabilityProfileId: "workspace" })
        .where("id", "=", thread.id)
        .execute(),
    ).rejects.toThrow(/capability profile.*immutable/);
    await expect(
      database
        .updateTable("workspaces")
        .set({ kind: "specialized" })
        .where("id", "=", workspace.id)
        .execute(),
    ).rejects.toThrow(/workspace kind.*immutable/);
  });

  it("enrolls Main and local Runners with separate one-shot records", async ({ storeFixture }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const mainRunnerId = createId("runner");
    const localRunnerId = createId("runner");
    const mainEnvironmentId = createId("environment");
    const localEnvironmentId = createId("environment");
    const mainTokenHash = `sha256:${createHash("sha256").update("main-token").digest("base64url")}`;
    const localTokenHash = `sha256:${createHash("sha256").update("local-token").digest("base64url")}`;
    const mainEnrollmentId = `ren_${randomUUID()}`;
    const localEnrollmentId = `ren_${randomUUID()}`;
    await Promise.all([
      store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: mainEnrollmentId,
        idempotencyKey: "main-runner-enrollment",
        mainEnrollmentPurpose: "initial",
        name: "Main computer",
        requestFingerprint: "sha256:main-runner-request",
        runnerKind: "main",
        tokenHash: mainTokenHash,
      }),
      store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: localEnrollmentId,
        idempotencyKey: "local-runner-enrollment",
        name: "Alex's Mac",
        requestFingerprint: "sha256:local-runner-request",
        runnerKind: "local",
        tokenHash: localTokenHash,
      }),
    ]);
    expect(
      await store.listPendingRunnerEnrollments({
        includeDeployment: false,
        limit: 100,
        ownerId,
      }),
    ).toEqual([
      expect.objectContaining({ name: "Alex's Mac", ownerKind: "user", runnerKind: "local" }),
    ]);
    const mainKeys = generateKeyPairSync("ed25519");
    const localKeys = generateKeyPairSync("ed25519");
    const mainDescriptor = testRunnerDescriptor({
      environmentId: mainEnvironmentId,
      name: "Main Runner",
      runnerId: mainRunnerId,
      runnerKind: "main",
    });
    const localDescriptor = testRunnerDescriptor({
      environmentId: localEnvironmentId,
      name: "Alex's Mac",
      runnerId: localRunnerId,
      runnerKind: "local",
    });
    const main = await store.enrollRunnerConnection({
      descriptor: mainDescriptor,
      enrollmentTokenHash: mainTokenHash,
      publicKeyFingerprint: fingerprint(mainKeys.publicKey),
      publicKeyPem: mainKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    const local = await store.enrollRunnerConnection({
      descriptor: localDescriptor,
      enrollmentTokenHash: localTokenHash,
      publicKeyFingerprint: fingerprint(localKeys.publicKey),
      publicKeyPem: localKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    expect(main.connectionGeneration).toBe(1);
    expect(local.connectionGeneration).toBe(1);
    expect(
      (await store.listRunners({ includeDeployment: true, limit: 100, ownerId })).runners,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enrollmentId: mainEnrollmentId, id: mainRunnerId }),
        expect.objectContaining({ enrollmentId: localEnrollmentId, id: localRunnerId }),
      ]),
    );
    expect(
      await store.listPendingRunnerEnrollments({
        includeDeployment: true,
        limit: 100,
        ownerId,
      }),
    ).toEqual([]);
    expect(await store.listEnvironments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: mainEnvironmentId,
          name: "Main computer",
          runnerId: mainRunnerId,
        }),
        expect.objectContaining({
          id: localEnvironmentId,
          name: "Alex's Mac",
          runnerId: localRunnerId,
        }),
      ]),
    );
    await store.renameRunner(localRunnerId, ownerId, "Studio Mac");
    await store.authenticateRunnerConnection({ ...localDescriptor, name: "Descriptor name" });
    expect(
      (await store.listRunners({ includeDeployment: false, limit: 100, ownerId })).runners.find(
        (runner) => runner.id === localRunnerId,
      )?.name,
    ).toBe("Studio Mac");
    expect(await store.listEnvironments()).toContainEqual(
      expect.objectContaining({ id: localEnvironmentId, name: "Studio Mac" }),
    );

    const attackerKeys = generateKeyPairSync("ed25519");
    await expect(
      store.enrollRunnerConnection({
        descriptor: testRunnerDescriptor({
          environmentId: createId("environment"),
          name: "Other local Runner",
          runnerId: createId("runner"),
          runnerKind: "local",
        }),
        enrollmentTokenHash: localTokenHash,
        publicKeyFingerprint: fingerprint(attackerKeys.publicKey),
        publicKeyPem: attackerKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("tokenHash", "=", localTokenHash)
      .executeTakeFirstOrThrow();
    const recoveredAfterAmbiguousResponse = await store.enrollRunnerConnection({
      descriptor: {
        ...localDescriptor,
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      },
      enrollmentTokenHash: localTokenHash,
      publicKeyFingerprint: fingerprint(localKeys.publicKey),
      publicKeyPem: localKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    // The rename's reauthentication already advanced the fence once, so the
    // recovered enrollment is this Runner's third connection, not its second.
    expect(recoveredAfterAmbiguousResponse.connectionGeneration).toBe(3);

    const firstPage = await store.listRunners({ includeDeployment: true, limit: 1, ownerId });
    expect(firstPage.runners).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor;
    if (!cursor) throw new Error("Runner inventory cursor is missing");
    const secondPage = await store.listRunners({
      after: cursor,
      includeDeployment: true,
      limit: 1,
      ownerId,
    });
    expect([...firstPage.runners, ...secondPage.runners].map((runner) => runner.id)).toEqual(
      expect.arrayContaining([mainRunnerId, localRunnerId]),
    );

    const foreignOwnerId = await store.createUser("Other owner");
    expect(
      (
        await store.listRunners({
          includeDeployment: true,
          limit: 100,
          ownerId: foreignOwnerId,
        })
      ).runners,
    ).toEqual([expect.objectContaining({ id: mainRunnerId, ownerKind: "deployment" })]);
    await expect(store.revokeRunner(localRunnerId, foreignOwnerId)).rejects.toMatchObject({
      code: "not_found",
    });

    await store.revokeRunner(localRunnerId, ownerId);
    await expect(store.authenticateRunnerConnection(localDescriptor)).rejects.toMatchObject({
      code: "forbidden",
    });
    const inventory = await store.listRunners({ includeDeployment: true, limit: 100, ownerId });
    expect(
      inventory.runners.find((runner) => runner.id === localRunnerId)?.revokedAt,
    ).toBeInstanceOf(Date);
    await expect(store.revokeRunner(localRunnerId, ownerId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses to revoke the computer a Personal Deployment runs on", async ({ storeFixture }) => {
    const { store, enablePersonalRemoteAccess } = storeFixture;
    await store.ensureDeployment({
      canonicalOrigin: "http://127.0.0.1:4310",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
    });
    const ownerId = await store.createUser("Alex");
    const mainRunnerId = createId("runner");
    const lentRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: createId("environment"),
      name: "This Mac",
      runnerId: mainRunnerId,
      tokenSuffix: "personal-main",
    });
    // A local Runner is owned by whoever enrolled it; only a managed one names
    // an owning user separately. On a Personal Deployment it is reachable and
    // nothing else, and it arrives only while there is a route to arrive on.
    await enablePersonalRemoteAccess();
    await enrollTestRunner(store, {
      allowedModules: ["integrations", "messaging", "shell"],
      createdBy: ownerId,
      environmentId: createId("environment"),
      modules: reachOnlyModules,
      name: "Lent laptop",
      runnerId: lentRunnerId,
      runnerKind: "local",
      tokenSuffix: "personal-lent",
    });

    // Administration is not the question: nobody may retire the Runner that is
    // the Deployment, and the refusal has to come from the mutation itself.
    await expect(
      store.revokeRunner(mainRunnerId, ownerId, { allowDeployment: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await store.listRunners({ includeDeployment: true, limit: 100, ownerId })).runners.find(
        (runner) => runner.id === mainRunnerId,
      )?.revokedAt,
    ).toBeNull();

    // The prohibition is about that one Runner, not about Personal Deployments.
    await store.revokeRunner(lentRunnerId, ownerId);
  });

  describe("Personal membership", () => {
    const personalShape = {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    } as const;

    async function personalDeployment(storeFixture: StoreFixture): Promise<void> {
      const { store } = storeFixture;
      await store.ensureDeployment({
        canonicalOrigin: "http://127.0.0.1:4310",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: personalShape,
      });
    }

    /** Mints one enrollment directly, so the grant under test is the only variable. */
    function enrollment(
      storeFixture: StoreFixture,
      input: {
        readonly allowedModules: readonly RunnerModuleName[];
        readonly createdBy: UserId | null;
        readonly runnerKind: "main" | "local" | "managed";
        readonly suffix: string;
      },
    ) {
      const { store } = storeFixture;
      return store.createRunnerEnrollment({
        allowedModules: input.allowedModules,
        createdBy: input.createdBy,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `personal-${input.suffix}`,
        ...(input.runnerKind === "main" ? { mainEnrollmentPurpose: "initial" as const } : {}),
        name: input.runnerKind === "main" ? "Main computer" : `Computer ${input.suffix}`,
        requestFingerprint: `sha256:personal-${input.suffix}`,
        runnerKind: input.runnerKind,
        tokenHash: `sha256:${createHash("sha256").update(`personal-${input.suffix}`).digest("base64url")}`,
      });
    }

    it("issues a non-Main Personal enrollment only for the reachable grant", async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      await personalDeployment(storeFixture);
      const ownerId = await store.createUser("Alex");

      for (const allowedModules of [["agents"], ["agents", "shell"], ["browser"]] as const) {
        await expect(
          enrollment(storeFixture, {
            allowedModules,
            createdBy: ownerId,
            runnerKind: "local",
            suffix: `refused-${allowedModules.join("-") || "empty"}`,
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Only reachable computers can join a Personal Deployment.",
        });
      }
      // A bearer caller reaching the managed path is the same refusal: it is
      // about the Deployment, not about who asked.
      await expect(
        enrollment(storeFixture, {
          allowedModules: ["agents"],
          createdBy: null,
          runnerKind: "managed",
          suffix: "refused-managed",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // The issuance caller supplies the full reachable grant; storage does
      // not turn an empty grant into a different one.
      await expect(
        enrollment(storeFixture, {
          allowedModules: ["integrations", "messaging", "shell"],
          createdBy: ownerId,
          runnerKind: "local",
          suffix: "reachable",
        }),
      ).resolves.toMatchObject({ allowedModules: ["integrations", "messaging", "shell"] });
      await expect(
        enrollment(storeFixture, {
          allowedModules: [],
          createdBy: ownerId,
          runnerKind: "local",
          suffix: "reachable-by-default",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      // The Main Runner is the Deployment, so its bootstrap grant is the one
      // exception and it still carries agents and browser.
      await expect(
        enrollment(storeFixture, {
          allowedModules: ["agents", "browser"],
          createdBy: null,
          runnerKind: "main",
          suffix: "main",
        }),
      ).resolves.toMatchObject({ allowedModules: ["agents", "browser"] });
    });

    it("leaves a server Deployment free to grant whatever it likes", async ({ storeFixture }) => {
      const { store } = storeFixture;
      await store.ensureDeployment({
        canonicalOrigin: "https://server.test.invalid",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: testWorkspaceProfile,
      });
      const ownerId = await store.createUser("Alex");

      await expect(
        enrollment(storeFixture, {
          allowedModules: ["agents", "browser"],
          createdBy: ownerId,
          runnerKind: "local",
          suffix: "server-local",
        }),
      ).resolves.toMatchObject({ allowedModules: ["agents", "browser"] });
    });

    it("refuses a stored credential whose grant no longer fits the Deployment", async ({
      storeFixture,
    }) => {
      const { enablePersonalRemoteAccess, store, database } = storeFixture;
      await personalDeployment(storeFixture);
      await enablePersonalRemoteAccess();
      const ownerId = await store.createUser("Alex");
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      await enrollTestRunner(store, {
        allowedModules: ["integrations", "messaging", "shell"],
        createdBy: ownerId,
        environmentId,
        modules: reachOnlyModules,
        name: "Reachable laptop",
        runnerId,
        runnerKind: "local",
        tokenSuffix: "personal-reach",
      });
      const descriptor = testRunnerDescriptor({
        environmentId,
        modules: reachOnlyModules,
        name: "Reachable laptop",
        runnerId,
        runnerKind: "local",
      });
      await expect(store.authenticateRunnerConnection(descriptor)).resolves.toMatchObject({
        allowedModules: ["integrations", "messaging", "shell"],
      });

      // The grant widens behind the store's back — a restored backup, a
      // Deployment that used to be a server. The credential is intact and the
      // machine still advertises only `shell`, and it is still refused.
      await database
        .updateTable("runners")
        .set({ allowedModules: sql`'["shell"]'::jsonb` })
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();

      await expect(store.authenticateRunnerConnection(descriptor)).rejects.toMatchObject({
        code: "forbidden",
        message: "Only reachable computers can join a Personal Deployment.",
      });
    });

    it("admits a non-Main Personal computer only while remote access is on", async ({
      storeFixture,
    }) => {
      const { store, enablePersonalRemoteAccess, database } = storeFixture;
      await personalDeployment(storeFixture);
      const ownerId = await store.createUser("Alex");
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      const keys = generateKeyPairSync("ed25519");
      const tokenHash = `sha256:${createHash("sha256").update("personal-admission").digest("base64url")}`;
      // Minting the enrollment needs no route: a person may write down a
      // computer before there is any way for it to arrive.
      await store.createRunnerEnrollment({
        allowedModules: ["integrations", "messaging", "shell"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: "personal-admission",
        name: "Reachable laptop",
        requestFingerprint: "sha256:personal-admission",
        runnerKind: "local",
        tokenHash,
      });
      const redeem = () =>
        store.enrollRunnerConnection({
          descriptor: testRunnerDescriptor({
            environmentId,
            modules: reachOnlyModules,
            name: "Reachable laptop",
            runnerId,
            runnerKind: "local",
          }),
          enrollmentTokenHash: tokenHash,
          publicKeyFingerprint: fingerprint(keys.publicKey),
          publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        });

      await expect(redeem()).rejects.toMatchObject({
        code: "forbidden",
        message: "Turn on remote access on this computer to connect other computers.",
      });

      await enablePersonalRemoteAccess();
      await expect(redeem()).resolves.toMatchObject({ connectionGeneration: 1 });

      // Turning it off again refuses the computer that already redeemed, on the
      // credential it kept. Nothing is revoked: the row is still there.
      await database
        .updateTable("personalRemoteAccess")
        .set({ generation: 2, mode: "off", routeOrigin: null, updatedAt: new Date() })
        .where("singletonKey", "=", "personal")
        .executeTakeFirstOrThrow();
      await expect(
        store.authenticateRunnerConnection(
          testRunnerDescriptor({
            environmentId,
            modules: reachOnlyModules,
            name: "Reachable laptop",
            runnerId,
            runnerKind: "local",
          }),
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Turn on remote access on this computer to connect other computers.",
      });
      expect(
        (await store.listRunners({ includeDeployment: true, limit: 100, ownerId })).runners.find(
          (runner) => runner.id === runnerId,
        )?.revokedAt,
      ).toBeNull();
    });

    it("admits the Personal Main computer with remote access off", async ({ storeFixture }) => {
      const { store } = storeFixture;
      await personalDeployment(storeFixture);
      const ownerId = await store.createUser("Alex");
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      // The Main Runner is the machine remote access would be turned on from,
      // so a route it never travels cannot be a condition of it connecting.
      await enrollTestRunner(store, {
        allowedModules: ["agents", "browser", "integrations", "messaging", "shell"],
        createdBy: null,
        environmentId,
        name: "Main computer",
        runnerId,
        tokenSuffix: "personal-main-admitted",
      });

      await expect(
        store.authenticateRunnerConnection(
          testRunnerDescriptor({
            environmentId,
            name: "Main computer",
            runnerId,
            runnerKind: "main",
          }),
        ),
      ).resolves.toMatchObject({
        allowedModules: ["agents", "browser", "integrations", "messaging", "shell"],
      });
      expect(
        await store.listPendingRunnerEnrollments({
          includeDeployment: true,
          limit: 10,
          ownerId,
        }),
      ).toEqual([]);
    });
  });

  it("still lets a server Deployment retire its own main computer", async ({ storeFixture }) => {
    const { store } = storeFixture;
    await store.ensureDeployment({
      canonicalOrigin: "https://server.test.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    });
    const administratorId = await store.createUser("Administrator");
    const mainRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: administratorId,
      environmentId: createId("environment"),
      name: "Deployment computer",
      runnerId: mainRunnerId,
      tokenSuffix: "server-main",
    });

    await store.revokeRunner(mainRunnerId, administratorId, { allowDeployment: true });
  });

  it("fails an Assignment and tells its parent when its queued Run's computer is removed", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("revoke-queued-delegation");
    const lentEnvironmentId = createId("environment");
    const lentRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: fixture.userId,
      environmentId: lentEnvironmentId,
      name: "Lent laptop",
      runnerId: lentRunnerId,
      runnerKind: "local",
      tokenSuffix: "revoke-queued-delegation-lent",
    });
    const lentHarness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: lentEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: lentEnvironmentId,
      harnessInstanceId: lentHarness.id,
      idempotencyKey: "revoke-queued-delegation-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Work on the machine that is about to go away", type: "text" }],
      title: "Stranded worker",
      workspaceId: fixture.workspace.id,
    });
    // Never claimed: this is exactly the Run nothing else would ever fail.
    expect(delegated.run.status).toBe("queued");

    await store.revokeRunner(lentRunnerId, fixture.userId);

    expect(
      await database
        .selectFrom("runs")
        .select(["failure", "status"])
        .where("id", "=", delegated.run.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      failure: { code: "runner_revoked", retryable: false },
      status: "failed",
    });
    const drained = await store.drainPendingAssignmentReturns();
    expect(drained.failures).toEqual([]);
    const assignment = await database
      .selectFrom("delegations")
      .select(["status", "resultRunId", "resultStatus", "resultText"])
      .where("id", "=", delegated.assignment.id)
      .executeTakeFirstOrThrow();
    expect(assignment).toMatchObject({
      resultRunId: delegated.run.id,
      resultStatus: "delivered",
      status: "failed",
    });
    expect(assignment.resultText).toMatch(/^The task stopped because of an error: \S/u);
    const returned = await database
      .selectFrom("messages")
      .select("content")
      .where("threadId", "=", fixture.thread.id)
      .where("kind", "=", "continuation")
      .execute();
    expect(returned).toHaveLength(1);
    expect(JSON.stringify(returned[0]?.content)).toContain("Task failed: Stranded worker");
    await expect(store.drainPendingAssignmentReturns()).resolves.toEqual({
      events: [],
      failures: [],
    });
  });

  it("fails the sibling task without inventing a success when the parent's own computer is removed", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("revoke-parents-own-computer");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "revoke-parents-own-computer-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Work beside the parent", type: "text" }],
      title: "Sibling worker",
      workspaceId: fixture.workspace.id,
    });

    await store.revokeRunner(fixture.runnerId, fixture.userId, { allowDeployment: true });
    const drained = await store.drainPendingAssignmentReturns();
    expect(drained.failures).toEqual([]);

    // The removal ended the work: the task says so plainly rather than
    // staying open forever or reporting a success nobody produced.
    // The parent cannot run anywhere now either, so the return is recorded as
    // undeliverable instead of queueing work no computer can take.
    const assignment = await database
      .selectFrom("delegations")
      .select(["status", "resultReason", "resultStatus", "resultText"])
      .where("id", "=", delegated.assignment.id)
      .executeTakeFirstOrThrow();
    expect(assignment.status).toBe("failed");
    expect(assignment.resultText).toMatch(/^The task stopped because of an error: \S/u);
    expect(assignment).toMatchObject({
      resultReason: "execution-authority-unavailable",
      resultStatus: "undeliverable",
    });
  });

  it("counts the live Threads placed on each computer", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    // One Deployment has exactly one initial Main, so the second computer is a
    // lent one — which is the shape this projection actually serves anyway.
    const first = await createRunFixture("thread-count-first");
    const secondEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: first.userId,
      environmentId: secondEnvironmentId,
      name: "Lent laptop",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "thread-count-second",
    });
    const secondHarness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: secondEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const threadOn = async (
      environmentId: ReturnType<typeof createId<"environment">>,
      harnessInstanceId: typeof first.harnessInstance.id,
      suffix: string,
    ) =>
      (
        await store.createThread({
          createdBy: first.userId,
          environmentId,
          harnessInstanceId,
          idempotencyKey: `thread-count-${suffix}`,
          modelSelection: testModelSelection,
          title: `Thread ${suffix}`,
          workspaceId: first.workspace.id,
        })
      ).thread;
    const extraThread = async (suffix: string) =>
      threadOn(first.environmentId, first.harnessInstance.id, suffix);
    await threadOn(secondEnvironmentId, secondHarness.id, "second-live");
    await extraThread("live");
    const archived = await extraThread("archived");
    await database
      .updateTable("threads")
      .set({ status: "archived" })
      .where("id", "=", archived.id)
      .executeTakeFirstOrThrow();

    // Archived work is not what a person would lose with the computer.
    await expect(
      store.countLiveThreadsByEnvironment([first.environmentId, secondEnvironmentId]),
    ).resolves.toEqual(
      new Map([
        [first.environmentId, 2],
        [secondEnvironmentId, 1],
      ]),
    );
    await expect(store.countLiveThreadsByEnvironment([])).resolves.toEqual(new Map());
  });

  it("resolves an environment's Runner enrollment creator", async ({ storeFixture }) => {
    const { store } = storeFixture;
    const ownerId = await store.createUser("Local Runner owner");
    const localEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: localEnvironmentId,
      name: "Local Runner",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "environment-runner-owner-local",
    });
    await expect(store.environmentRunnerOwner(localEnvironmentId)).resolves.toBe(ownerId);
    await expect(store.environmentRunnerOwner(createId("environment"))).resolves.toBeNull();

    const deploymentEnvironmentId = createId("environment");
    const deploymentRunnerId = createId("runner");
    const deploymentTokenHash = `sha256:${createHash("sha256")
      .update("environment-runner-owner-deployment")
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "environment-runner-owner-deployment",
      mainEnrollmentPurpose: "initial",
      name: "Deployment computer",
      requestFingerprint: "sha256:environment-runner-owner-deployment",
      runnerKind: "main",
      tokenHash: deploymentTokenHash,
    });
    const keys = generateKeyPairSync("ed25519");
    await store.enrollRunnerConnection({
      descriptor: testRunnerDescriptor({
        environmentId: deploymentEnvironmentId,
        name: "Deployment Runner",
        runnerId: deploymentRunnerId,
        runnerKind: "main",
      }),
      enrollmentTokenHash: deploymentTokenHash,
      publicKeyFingerprint: fingerprint(keys.publicKey),
      publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    await expect(store.environmentRunnerOwner(deploymentEnvironmentId)).resolves.toBeNull();
  });

  it.for([
    { deploymentKind: "personal" as const, revoked: false, upgraded: true },
    { deploymentKind: "personal" as const, revoked: true, upgraded: false },
    { deploymentKind: "server" as const, revoked: false, upgraded: false },
  ])(
    "guards the legacy Personal Main browser grant for $deploymentKind revoked=$revoked",
    async ({ deploymentKind, revoked, upgraded }, { storeFixture }) => {
      const { store, database } = storeFixture;
      await store.ensureDeployment({
        canonicalOrigin:
          deploymentKind === "personal" ? "http://127.0.0.1:4310" : "https://host.example.test",
        deploymentId: createId("deployment"),
        deploymentShape: {
          defaultWorkspaceBacking: "local-directory",
          kind: deploymentKind,
        },
        hostInstanceId: createId("hostInstance"),
      });
      const enrollmentId = `ren_${randomUUID()}`;
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      const tokenHash = `sha256:${createHash("sha256")
        .update(`legacy-personal-main-${deploymentKind}-${revoked}`)
        .digest("base64url")}`;
      await store.createRunnerEnrollment({
        allowedModules: ["agents", "integrations", "messaging", "shell"],
        createdBy: null,
        expiresAt: new Date(Date.now() + 60_000),
        id: enrollmentId,
        idempotencyKey: `legacy-personal-main-${deploymentKind}-${revoked}`,
        mainEnrollmentPurpose: "initial",
        name: "Main computer",
        requestFingerprint: `sha256:legacy-personal-main-${deploymentKind}-${revoked}`,
        runnerKind: "main",
        tokenHash,
      });
      const keys = generateKeyPairSync("ed25519");
      await store.enrollRunnerConnection({
        descriptor: testRunnerDescriptor({
          environmentId,
          name: "Main computer",
          runnerId,
          runnerKind: "main",
        }),
        enrollmentTokenHash: tokenHash,
        publicKeyFingerprint: fingerprint(keys.publicKey),
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
      if (revoked) {
        await database
          .updateTable("runners")
          .set({ revokedAt: new Date() })
          .where("id", "=", runnerId)
          .executeTakeFirstOrThrow();
      }
      const before = await database
        .selectFrom("runners")
        .selectAll()
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();

      await expect(store.upgradeLegacyPersonalMainRunnerBrowserGrant()).resolves.toBe(upgraded);

      const after = await database
        .selectFrom("runners")
        .selectAll()
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();
      // This previously issued computer grant already carries its reach
      // modules; the explicit legacy browser upgrade keeps them.
      expect(after).toEqual({
        ...before,
        allowedModules: upgraded
          ? ["agents", "browser", "integrations", "messaging", "shell"]
          : ["agents", "integrations", "messaging", "shell"],
      });
      expect(
        await database
          .selectFrom("runnerEnrollments")
          .select("allowedModules")
          .where("id", "=", enrollmentId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        allowedModules: upgraded
          ? ["agents", "browser", "integrations", "messaging", "shell"]
          : ["agents", "integrations", "messaging", "shell"],
      });
    },
  );

  it("rejects an expired unconsumed Runner enrollment", async ({ storeFixture }) => {
    const { store } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const tokenHash = `sha256:${createHash("sha256").update("expired-token").digest("base64url")}`;
    const keys = generateKeyPairSync("ed25519");
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() - 1_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "expired-local-runner",
      name: "Expired computer",
      requestFingerprint: "sha256:expired-local-runner",
      runnerKind: "local",
      tokenHash,
    });

    await expect(
      store.enrollRunnerConnection({
        descriptor: testRunnerDescriptor({
          environmentId,
          name: "Expired Runner",
          runnerId,
          runnerKind: "local",
        }),
        enrollmentTokenHash: tokenHash,
        publicKeyFingerprint: fingerprint(keys.publicKey),
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.runnerForAuthentication(runnerId)).toBeNull();
  });

  it("bounds configured bootstrap enrollments once without extending them on restart", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Bootstrap owner");
    const runnerTokenHash = `sha256:${createHash("sha256")
      .update("configured-bootstrap-runner")
      .digest("base64url")}`;
    const runnerInput = {
      allowedModules: ["agents"],
      createdBy: ownerId,
      id: `ren_${randomUUID()}`,
      tokenHash: runnerTokenHash,
    } as const;

    await store.ensureBootstrapRunnerEnrollment(runnerInput);
    const runnerCreated = await database
      .selectFrom("runnerEnrollments")
      .select(["createdAt", "expiresAt", "allowedModules"])
      .where("tokenHash", "=", runnerTokenHash)
      .executeTakeFirstOrThrow();
    expect(runnerCreated.allowedModules).toEqual(["agents"]);
    expect(runnerCreated.expiresAt.getTime() - runnerCreated.createdAt.getTime()).toBe(
      configuredBootstrapEnrollmentLifetimeMs,
    );

    const expiredAt = new Date(Date.now() - 1_000);
    await database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: expiredAt })
      .where("tokenHash", "=", runnerTokenHash)
      .executeTakeFirstOrThrow();
    await store.ensureBootstrapRunnerEnrollment(runnerInput);
    const runnerRestarted = await database
      .selectFrom("runnerEnrollments")
      .select("expiresAt")
      .where("tokenHash", "=", runnerTokenHash)
      .executeTakeFirstOrThrow();
    expect(runnerRestarted.expiresAt).toEqual(expiredAt);

    const runnerKeys = generateKeyPairSync("ed25519");
    await expect(
      store.enrollRunnerConnection({
        descriptor: testRunnerDescriptor({
          environmentId: createId("environment"),
          name: "Expired bootstrap Main",
          runnerId: createId("runner"),
          runnerKind: "main",
        }),
        enrollmentTokenHash: runnerTokenHash,
        publicKeyFingerprint: fingerprint(runnerKeys.publicKey),
        publicKeyPem: runnerKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("recovers an expired first-Main bootstrap with one owner-issued initial enrollment", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Initial Main recovery owner");
    const bootstrapTokenHash = `sha256:${createHash("sha256")
      .update("expired-initial-main-bootstrap")
      .digest("base64url")}`;
    await store.ensureBootstrapRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      id: `ren_${randomUUID()}`,
      tokenHash: bootstrapTokenHash,
    });
    await database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("tokenHash", "=", bootstrapTokenHash)
      .executeTakeFirstOrThrow();

    const secondHostStore = new OpensteerStore(database);
    const recoveredTokenHash = `sha256:${"i".repeat(43)}`;
    const recoveryRequest = {
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "recover-expired-first-main",
      mainEnrollmentPurpose: "initial",
      name: "Recovered initial Main",
      requestFingerprint: "sha256:recover-expired-first-main",
      runnerKind: "main",
      tokenHash: recoveredTokenHash,
    } as const;
    const [first, concurrentExactRetry] = await Promise.all([
      store.createRunnerEnrollment(recoveryRequest),
      secondHostStore.createRunnerEnrollment({
        ...recoveryRequest,
        expiresAt: new Date(recoveryRequest.expiresAt.getTime() + 60_000),
        id: `ren_${randomUUID()}`,
      }),
    ]);
    expect(concurrentExactRetry).toEqual(first);
    await expect(
      secondHostStore.createRunnerEnrollment({
        ...recoveryRequest,
        id: `ren_${randomUUID()}`,
        requestFingerprint: "sha256:changed-initial-main-request",
        tokenHash: `sha256:${"j".repeat(43)}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      secondHostStore.createRunnerEnrollment({
        ...recoveryRequest,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "second-pending-initial-main",
        requestFingerprint: "sha256:second-pending-initial-main",
        tokenHash: `sha256:${"k".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/already pending/),
    });

    const runnerId = createId("runner");
    const keys = generateKeyPairSync("ed25519");
    await store.enrollRunnerConnection({
      descriptor: testRunnerDescriptor({
        environmentId: createId("environment"),
        name: "Recovered initial Main",
        runnerId,
        runnerKind: "main",
      }),
      enrollmentTokenHash: recoveredTokenHash,
      publicKeyFingerprint: fingerprint(keys.publicKey),
      publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    expect(await secondHostStore.createRunnerEnrollment(recoveryRequest)).toEqual(first);
    await expect(
      store.createRunnerEnrollment({
        ...recoveryRequest,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "initial-main-after-enrollment",
        requestFingerprint: "sha256:initial-main-after-enrollment",
        tokenHash: `sha256:${"l".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/after a Main has enrolled/),
    });

    const concurrentOwnerId = await store.createUser("Concurrent Host owner");
    const concurrentRequest = (suffix: string) =>
      ({
        allowedModules: ["agents"],
        createdBy: concurrentOwnerId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `concurrent-initial-main-${suffix}`,
        mainEnrollmentPurpose: "initial",
        name: `Concurrent Main ${suffix}`,
        requestFingerprint: `sha256:concurrent-initial-main-${suffix}`,
        runnerKind: "main",
        tokenHash: `sha256:${suffix.repeat(43)}`,
      }) as const;
    const competingHosts = await Promise.allSettled([
      store.createRunnerEnrollment(concurrentRequest("m")),
      secondHostStore.createRunnerEnrollment(concurrentRequest("n")),
    ]);
    expect(competingHosts.filter((result) => result.status === "fulfilled")).toHaveLength(0);
    expect(competingHosts.filter((result) => result.status === "rejected")).toHaveLength(2);
  });

  it("serializes Main enrollment consumption behind the owner issuance fence", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Main issuance race owner");
    const tokenHash = `sha256:${"r".repeat(43)}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "pending-main-for-consumption-race",
      mainEnrollmentPurpose: "initial",
      name: "Main consuming behind fence",
      requestFingerprint: "sha256:pending-main-for-consumption-race",
      runnerKind: "main",
      tokenHash,
    });
    const mainLockKey = "deployment-main-runner-enrollment";
    let releaseMainLock: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseMainLock = resolve;
    });
    let announceMainLock: () => void = () => {};
    const mainLockAcquired = new Promise<void>((resolve) => {
      announceMainLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${mainLockKey}, 0))`.execute(
        transaction,
      );
      announceMainLock();
      await releaseSignal;
    });
    await mainLockAcquired;

    const runnerId = createId("runner");
    const keys = generateKeyPairSync("ed25519");
    const consumption = store.enrollRunnerConnection({
      descriptor: testRunnerDescriptor({
        environmentId: createId("environment"),
        name: "Main consuming behind fence",
        runnerId,
        runnerKind: "main",
      }),
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: fingerprint(keys.publicKey),
      publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting
          from pg_locks
          where locktype = 'advisory'
            and granted = false
            and database = (select oid from pg_database where datname = current_database())
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(await store.runnerForAuthentication(runnerId)).toBeNull();
    } finally {
      releaseMainLock();
      await blocker;
    }
    await expect(consumption).resolves.toMatchObject({ runnerId });

    await expect(
      store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: "second-main-after-race",
        mainEnrollmentPurpose: "initial",
        name: "Second Main",
        requestFingerprint: "sha256:second-main-after-race",
        runnerKind: "main",
        tokenHash: `sha256:${"s".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/after a Main has enrolled/),
    });
  });

  it("permits an explicit replacement Main only after durable revocation", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const oldRunnerId = createId("runner");
    const oldEnvironmentId = createId("environment");
    const oldTokenHash = `sha256:${"o".repeat(43)}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "original-main",
      mainEnrollmentPurpose: "initial",
      name: "Original Main",
      requestFingerprint: "sha256:original-main",
      runnerKind: "main",
      tokenHash: oldTokenHash,
    });
    const oldKeys = generateKeyPairSync("ed25519");
    await store.enrollRunnerConnection({
      descriptor: testRunnerDescriptor({
        environmentId: oldEnvironmentId,
        name: "Original Main",
        runnerId: oldRunnerId,
        runnerKind: "main",
      }),
      enrollmentTokenHash: oldTokenHash,
      publicKeyFingerprint: fingerprint(oldKeys.publicKey),
      publicKeyPem: oldKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });

    const replacementInput = {
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "replacement-main-1",
      requestFingerprint: "sha256:replacement-main-1",
      mainEnrollmentPurpose: "replacement",
      name: "Replacement Main",
      runnerKind: "main",
      tokenHash: `sha256:${"n".repeat(43)}`,
    } as const;
    await expect(store.createRunnerEnrollment(replacementInput)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/must be revoked/),
    });

    await store.revokeRunner(oldRunnerId, ownerId, { allowDeployment: true });
    const issued = await store.createRunnerEnrollment(replacementInput);
    const replay = await store.createRunnerEnrollment({
      ...replacementInput,
      expiresAt: new Date(replacementInput.expiresAt.getTime() + 30_000),
      id: `ren_${randomUUID()}`,
    });
    expect(replay).toEqual(issued);
    await expect(
      store.createRunnerEnrollment({
        ...replacementInput,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "replacement-main-2",
        requestFingerprint: "sha256:replacement-main-2",
        tokenHash: `sha256:${"p".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/already pending/),
    });

    const newRunnerId = createId("runner");
    const newEnvironmentId = createId("environment");
    const newKeys = generateKeyPairSync("ed25519");
    await store.enrollRunnerConnection({
      descriptor: testRunnerDescriptor({
        environmentId: newEnvironmentId,
        name: "Replacement Main",
        runnerId: newRunnerId,
        runnerKind: "main",
      }),
      enrollmentTokenHash: replacementInput.tokenHash,
      publicKeyFingerprint: fingerprint(newKeys.publicKey),
      publicKeyPem: newKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    expect(await store.listEnvironments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldEnvironmentId, runnerId: oldRunnerId }),
        expect.objectContaining({ id: newEnvironmentId, runnerId: newRunnerId }),
      ]),
    );
    await expect(
      store.createRunnerEnrollment({
        ...replacementInput,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "replacement-main-3",
        requestFingerprint: "sha256:replacement-main-3",
        tokenHash: `sha256:${"q".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/must be revoked/),
    });
  });

  it("replays Runner enrollment issuance exactly without persisting the raw token", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const rawToken = "runner-enrollment-plaintext-must-not-be-stored";
    const tokenHash = `sha256:${createHash("sha256").update(rawToken).digest("base64url")}`;
    const firstExpiry = new Date(Date.now() + 60_000);
    const first = await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: firstExpiry,
      id: `ren_${randomUUID()}`,
      idempotencyKey: "local-runner-request-1",
      name: "Local computer",
      requestFingerprint: "sha256:exact-request",
      runnerKind: "local",
      tokenHash,
    });
    const replay = await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(firstExpiry.getTime() + 30_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "local-runner-request-1",
      name: "Local computer",
      requestFingerprint: "sha256:exact-request",
      runnerKind: "local",
      tokenHash,
    });

    expect(replay).toEqual(first);
    await expect(
      store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: ownerId,
        expiresAt: firstExpiry,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "local-runner-request-1",
        name: "Changed computer",
        requestFingerprint: "sha256:changed-request",
        runnerKind: "managed",
        tokenHash: `sha256:${"z".repeat(43)}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const rows = await database.selectFrom("runnerEnrollments").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(tokenHash);
    expect(JSON.stringify(rows)).not.toContain(rawToken);
  });

  it("projects old and recent conversation browser use beyond the bootstrap history limit", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("browser-usage-projection");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "browser-usage-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ type: "text", text: "Browse" }],
      title: "Recent browser task",
      workspaceId: fixture.workspace.id,
    });
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
      workspaceId: fixture.workspace.id,
    });
    const base = Date.parse("2026-10-13T00:00:00.000Z");
    await database
      .insertInto("browserSessionUses")
      .values(
        Array.from({ length: 650 }, (_, index) => ({
          id: `projection-${index}`,
          sessionId,
          threadId: index === 0 ? fixture.thread.id : delegated.thread.id,
          runId: index === 0 ? fixture.run.id : delegated.run.id,
          tabId: `surface-${index}`,
          firstUsedAt: new Date(base + index),
          lastUsedAt: new Date(base + index),
        })),
      )
      .execute();
    // A later reconnect that chose no page never hides the pages the Run used.
    await database
      .insertInto("browserSessionUses")
      .values({
        id: "projection-session-reconnect",
        sessionId,
        threadId: delegated.thread.id,
        runId: delegated.run.id,
        tabId: null,
        firstUsedAt: new Date(base + 1000),
        lastUsedAt: new Date(base + 1000),
      })
      .execute();
    const old = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [fixture.run.id],
    });
    const recent = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: delegated.thread.id,
      runIds: [delegated.run.id],
    });
    expect(old).toHaveLength(2);
    expect(old).toContainEqual(
      expect.objectContaining({ sessionId, runId: fixture.run.id, tabId: "surface-0" }),
    );
    // One membership and the Run's latest distinct pages, newest first.
    expect(recent).toHaveLength(1 + browserUsageTabsPerRun);
    expect(recent.filter((use) => use.runId === delegated.run.id).map((use) => use.tabId)).toEqual(
      Array.from({ length: browserUsageTabsPerRun }, (_, index) => `surface-${649 - index}`),
    );
    expect(recent).toContainEqual(expect.objectContaining({ sessionId, runId: null, tabId: null }));
    const stranger = await store.createUser("Browser usage stranger");
    expect(
      await store.getThreadBrowserUsage({
        ownerId: stranger,
        threadId: fixture.thread.id,
        runIds: [fixture.run.id],
      }),
    ).toEqual([]);
    const otherProfile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-4",
      name: "Private other account",
      ownerId: stranger,
    });
    const otherSessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: otherSessionId,
      leaseGeneration: 1,
      leaseTokenHash: "private-profile-lease",
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: otherProfile.id,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
      workspaceId: fixture.workspace.id,
    });
    await database
      .insertInto("browserSessionUses")
      .values({
        id: "private-profile-shared-workspace",
        sessionId: otherSessionId,
        threadId: fixture.thread.id,
        runId: fixture.run.id,
        tabId: "private-surface",
        firstUsedAt: new Date(base),
        lastUsedAt: new Date(base),
      })
      .execute();
    expect(
      await store.getThreadBrowserUsage({
        ownerId: fixture.userId,
        threadId: fixture.thread.id,
        runIds: [fixture.run.id],
      }),
    ).toEqual(old);
    await writeBrowserUsageArtifact("browser-usage-projection.json", {
      lifetimeUseRows: 651,
      requestedRunBatchLimit: browserUsageRunBatchSize,
      pagesPerRun: browserUsageTabsPerRun,
      oldConversation: old,
      recentConversation: recent,
      exactOldTab: "surface-0",
      latestRecentTab: "surface-649",
      unauthorizedReaderRows: 0,
      foreignProfileRowsInSharedWorkspace: 0,
    });
  });

  it("keeps browser conversation provenance after detach and credits the asking assignment", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("browser-provenance");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "browser-provenance-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ type: "text", text: "Browse" }],
      title: "Browser task",
      workspaceId: fixture.workspace.id,
    });
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
      workspaceId: fixture.workspace.id,
    });
    const attach = {
      agentBindingId: `run:${delegated.run.id}`,
      ownerId: fixture.userId,
      sessionId,
      workspaceId: fixture.workspace.id,
    };
    expect(await store.attachBrowserSession(attach)).toBe(true);
    expect(await store.attachBrowserSession(attach)).toBe(false);
    const use = {
      agentBindingId: attach.agentBindingId,
      ownerId: fixture.userId,
      page: null,
      sessionId,
      tabId: null,
    };
    const credited = await store.recordAgentBrowserUse(use);
    expect(credited.map(({ threadId }) => threadId).sort()).toEqual(
      [fixture.thread.id, delegated.thread.id].sort(),
    );
    expect(credited.every(({ workspaceId }) => workspaceId === fixture.workspace.id)).toBe(true);
    // Both conversations start using the session here, so the catalog names both.
    expect(credited.every(({ joined }) => joined)).toBe(true);
    // Using it again changes when, not which conversations, so it credits nobody anew.
    expect(await store.recordAgentBrowserUse(use)).toEqual([]);
    const catalogThreads = await store.listBrowserSessionThreads({
      ownerId: fixture.userId,
      sessionIds: [sessionId],
    });
    expect([...(catalogThreads.get(sessionId) ?? [])].sort()).toEqual(
      [fixture.thread.id, delegated.thread.id].sort(),
    );
    await store.detachBrowserSessionAttachments(attach.agentBindingId);
    expect(await store.listAttachedRunIdsForBrowserSessions([sessionId])).toEqual(new Map());
    const parentUsage = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [delegated.run.id],
    });
    expect(parentUsage).toEqual([
      expect.objectContaining({ sessionId, runId: null, tabId: null }),
      expect.objectContaining({ sessionId, runId: delegated.run.id, tabId: null }),
    ]);
    // A person opening it can move the existing conversation to the front.
    expect(
      await store.recordBrowserSessionUse({
        ownerId: fixture.userId,
        sessionId,
        threadId: fixture.thread.id,
      }),
    ).toEqual(
      catalogThreads.get(sessionId)?.[0] === fixture.thread.id
        ? []
        : [
            {
              joined: true,
              catalogSessionIds: [sessionId],
              threadId: fixture.thread.id,
              workspaceId: fixture.workspace.id,
            },
          ],
    );
    const stranger = await store.createUser("Other browser reader");
    expect(
      await store.listBrowserSessionThreads({ ownerId: stranger, sessionIds: [sessionId] }),
    ).toEqual(new Map());
    // The catalog names a session's most recently active conversations, and no more.
    const others: ThreadId[] = [];
    for (let index = 0; index <= browserSessionMaxThreads; index += 1) {
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `browser-provenance-other-${index}`,
        modelSelection: testModelSelection,
        title: `Other ${index}`,
        workspaceId: fixture.workspace.id,
      });
      others.push(thread.id);
      expect(
        await store.recordBrowserSessionUse({
          ownerId: fixture.userId,
          sessionId,
          threadId: thread.id,
        }),
      ).toEqual([
        {
          joined: true,
          catalogSessionIds: [sessionId],
          threadId: thread.id,
          workspaceId: fixture.workspace.id,
        },
      ]);
    }
    const bounded = await store.listBrowserSessionThreads({
      ownerId: fixture.userId,
      sessionIds: [sessionId],
    });
    expect(bounded.get(sessionId)).toHaveLength(browserSessionMaxThreads);
    expect(new Set(bounded.get(sessionId))).toEqual(
      new Set(others.slice(-browserSessionMaxThreads)),
    );
    expect(
      await store.recordBrowserSessionUse({
        ownerId: fixture.userId,
        sessionId,
        threadId: fixture.thread.id,
      }),
    ).toEqual([
      {
        joined: true,
        catalogSessionIds: [sessionId],
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      },
    ]);
    const revisitedThreads = await store.listBrowserSessionThreads({
      ownerId: fixture.userId,
      sessionIds: [sessionId],
    });
    expect(revisitedThreads.get(sessionId)?.[0]).toBe(fixture.thread.id);
    expect(revisitedThreads.get(sessionId)).toHaveLength(browserSessionMaxThreads);
    expect(
      await store.recordBrowserSessionUse({
        ownerId: fixture.userId,
        sessionId,
        threadId: fixture.thread.id,
      }),
    ).toEqual([]);
    expect(
      await store.getThreadBrowserUsage({
        ownerId: stranger,
        threadId: fixture.thread.id,
        runIds: [delegated.run.id],
      }),
    ).toEqual([]);
    await expect(
      store.recordBrowserSessionUse({
        ownerId: stranger,
        sessionId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("links every browser page a Run used with its last title and site, credits included pages, and fences live attachments to active Runs", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("browser-pages");
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
      workspaceId: fixture.workspace.id,
    });
    const binding = `run:${fixture.run.id}`;
    const used = (tabId: string | null, page: { title: string; site: string } | null) =>
      store.recordAgentBrowserUse({
        agentBindingId: binding,
        ownerId: fixture.userId,
        page,
        sessionId,
        tabId,
      });
    const credit = (joined: boolean) => [
      {
        joined,
        ...(joined ? { catalogSessionIds: [sessionId] } : {}),
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      },
    ];
    // Each page the Run reaches for the first time is news to its conversation;
    // only the first starts the conversation's use of the session.
    expect(await used("tab-a", { title: "Alpha", site: "https://a.example" })).toEqual(
      credit(true),
    );
    expect(await used("tab-b", { title: "Beta", site: "https://b.example" })).toEqual(
      credit(false),
    );
    // A revisit changes the latest-page order; a changed title changes the projection too.
    expect(await used("tab-a", null)).toEqual(credit(false));
    expect(await used("tab-b", { title: "Beta, signed in", site: "https://b.example" })).toEqual(
      credit(false),
    );
    const pages = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [fixture.run.id],
    });
    expect(pages.filter((use) => use.runId === fixture.run.id)).toEqual([
      expect.objectContaining({ tabId: "tab-b", pageTitle: "Beta, signed in" }),
      expect.objectContaining({
        tabId: "tab-a",
        pageTitle: "Alpha",
        pageSite: "https://a.example",
      }),
    ]);
    expect(pages[0]).toMatchObject({
      runId: null,
      tabId: null,
      pageTitle: "Beta, signed in",
      pageSite: "https://b.example",
    });
    for (let index = 0; index < browserUsageTabsPerRun + 2; index += 1) {
      await used(`tab-extra-${index}`, {
        title: `Extra ${index}`,
        site: "https://extra.example",
      });
    }
    const bounded = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [fixture.run.id],
    });
    expect(bounded.filter((use) => use.runId === fixture.run.id)).toHaveLength(
      browserUsageTabsPerRun,
    );

    expect(
      bounded.filter((use) => use.runId === fixture.run.id).some((use) => use.tabId === "tab-a"),
    ).toBe(false);
    expect(await used("tab-a", { title: "Alpha revisited", site: "https://new.example" })).toEqual(
      credit(false),
    );
    expect(await used("tab-a", { title: "Alpha revisited", site: "https://new.example" })).toEqual(
      [],
    );
    const revisited = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [fixture.run.id],
    });
    expect(revisited.filter((use) => use.runId === fixture.run.id)[0]).toMatchObject({
      tabId: "tab-a",
      pageTitle: "Alpha revisited",
      pageSite: "https://new.example",
    });
    await writeBrowserUsageArtifact("browser-usage-revisit.json", { bounded, revisited });

    // A page the person included credits the conversation with that exact page.
    const included = {
      ownerId: fixture.userId,
      page: { title: "Checkout", site: "https://shop.example" },
      sessionId,
      tabId: "person-tab",
      threadId: fixture.thread.id,
    };
    expect(await store.recordBrowserSessionUse(included)).toEqual(credit(false));
    expect(await store.recordBrowserSessionUse(included)).toEqual([]);
    // A page whose id reads like a membership is still its own page.
    expect(await store.recordBrowserSessionUse({ ...included, tabId: "session" })).toEqual(
      credit(false),
    );
    const withIncluded = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [],
    });
    expect(withIncluded).toContainEqual(
      expect.objectContaining({
        runId: null,
        tabId: "person-tab",
        pageTitle: "Checkout",
        pageSite: "https://shop.example",
      }),
    );
    const outsider = await store.createUser("Browser outsider");
    await expect(
      store.recordBrowserSessionUse({ ...included, ownerId: outsider }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Viewers follow the catalog rule: a fresh session's active Workspace members.
    expect(await store.listBrowserSessionViewers(sessionId)).toEqual({
      userIds: [fixture.userId],
      workspaceId: fixture.workspace.id,
    });
    const privateProfile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-5",
      name: "Outsider's profile",
      ownerId: outsider,
    });
    const privateSessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: privateSessionId,
      leaseGeneration: 1,
      leaseTokenHash: "outsider-lease",
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: privateProfile.id,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
      workspaceId: fixture.workspace.id,
    });
    expect(await store.listBrowserSessionViewers(privateSessionId)).toEqual({
      userIds: [outsider],
      workspaceId: fixture.workspace.id,
    });

    // A live attachment exists only while its Run is active. Finalization holds
    // the Run's row while it ends it; an attach that arrives meanwhile waits
    // for it and then writes nothing.
    expect(
      await store.attachBrowserSession({
        agentBindingId: binding,
        ownerId: fixture.userId,
        sessionId,
        workspaceId: fixture.workspace.id,
      }),
    ).toBe(true);
    await store.detachBrowserSessionAttachments(binding);
    const finalizing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const finalization = database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("runs")
        .set({ completedAt: new Date(), status: "completed" })
        .where("id", "=", fixture.run.id)
        .executeTakeFirstOrThrow();
      finalizing.resolve();
      await finish.promise;
    });
    await finalizing.promise;
    const lateAttach = store.attachBrowserSession({
      agentBindingId: binding,
      ownerId: fixture.userId,
      sessionId,
      workspaceId: fixture.workspace.id,
    });
    await expect
      .poll(async () => {
        const waiting = await sql<{ waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and application_name = 'opensteer-integration-test'
            and wait_event_type = 'Lock'
        `.execute(database);
        return waiting.rows[0]!.waiting;
      })
      .toBeGreaterThanOrEqual(1);
    finish.resolve();
    await finalization;
    expect(await lateAttach).toBe(false);
    expect(await store.listAttachedRunIdsForBrowserSessions([sessionId])).toEqual(new Map());
    // What the Run did stays true after it ended.
    expect(await used("tab-after-end", { title: "Late", site: "https://late.example" })).toEqual(
      credit(false),
    );
    // Trigger and watch bindings are not Runs; their sessions end with them.
    expect(
      await store.attachBrowserSession({
        agentBindingId: "trigger:occurrence:request:browse",
        ownerId: fixture.userId,
        sessionId,
        workspaceId: fixture.workspace.id,
      }),
    ).toBe(true);
    await writeBrowserUsageArtifact("browser-usage-pages.json", {
      sessionId,
      runId: fixture.run.id,
      perRunPages: pages.filter((use) => use.runId === fixture.run.id),
      membership: pages[0],
      boundedRunPages: bounded.filter((use) => use.runId === fixture.run.id).length,
      includedPage: withIncluded.find((use) => use.tabId === "person-tab"),
      outsiderInclusion: "not_found",
      viewers: {
        fresh: await store.listBrowserSessionViewers(sessionId),
        profile: await store.listBrowserSessionViewers(privateSessionId),
      },
      lateAttachAfterRunEnd: false,
      attachedAfterRunEnd: [],
      durableUseAfterRunEnd: "credited",
    });
  });

  it("persists portable browser profiles and keeps active sessions on one placement", async ({
    storeFixture,
  }) => {
    const { store, database, enrollBrowserRunner } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_browser",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-browser",
      name: "Browser workspace",
      status: "ready",
    });
    const profile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-6",
      name: "Default browser",
      ownerId,
    });
    const clientProfile = await store.createBrowserProfile({
      idempotencyKey: "store.integration.test-browser-profile-7",
      name: "Client account",
      ownerId,
    });
    expect(clientProfile.id).not.toBe(profile.id);
    expect(await store.listBrowserProfiles(ownerId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: profile.id }),
        expect.objectContaining({ id: clientProfile.id, name: "Client account" }),
      ]),
    );
    const inheritedMainGrants = await store.listActiveBrowserProfileGrantsForWorkspace(
      workspace.id,
      ownerId,
    );
    expect(inheritedMainGrants).toEqual([
      expect.objectContaining({ profileId: profile.id }),
      expect.objectContaining({ profileId: clientProfile.id }),
    ]);
    expect(
      (await store.listActiveBrowserProfileGrantsForWorkspace(workspace.id, ownerId)).map(
        ({ grantId }) => grantId,
      ),
    ).toEqual(inheritedMainGrants.map(({ grantId }) => grantId));
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_browser_specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-browser-specialized",
      kind: "specialized",
      name: "Browser specialist",
      status: "ready",
    });
    expect(await store.listActiveBrowserProfileGrantsForWorkspace(specialized.id, ownerId)).toEqual(
      [],
    );
    const browserGrant = await store.createBrowserProfileGrant({
      access: "full-control",
      createdBy: ownerId,
      profileId: clientProfile.id,
      workspaceId: specialized.id,
    });
    const secondBrowserGrant = await store.createBrowserProfileGrant({
      access: "full-control",
      createdBy: ownerId,
      profileId: profile.id,
      workspaceId: specialized.id,
    });
    expect(browserGrant.grantId).toMatch(/^bpg_/);
    expect(await store.listActiveBrowserProfileGrantsForWorkspace(specialized.id, ownerId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grantId: browserGrant.grantId, profileId: clientProfile.id }),
        expect.objectContaining({ grantId: secondBrowserGrant.grantId, profileId: profile.id }),
      ]),
    );
    await store.revokeBrowserProfileGrant(browserGrant.grantId, ownerId);
    expect(await store.listActiveBrowserProfileGrantsForWorkspace(specialized.id, ownerId)).toEqual(
      [expect.objectContaining({ grantId: secondBrowserGrant.grantId, profileId: profile.id })],
    );
    await store.revokeBrowserProfileGrant(secondBrowserGrant.grantId, ownerId);
    await expect(
      sql`
        insert into browser_profile_grants (
          id, workspace_id, created_by, profile_id, access
        ) values (
          ${`grt_${randomUUID()}`}, ${specialized.id}, ${ownerId}, ${clientProfile.id},
          ${"full-control"}
        )
      `.execute(database),
    ).rejects.toThrow();
    await expect(
      sql`
        insert into browser_profile_grants (
          id, workspace_id, created_by, profile_id, access
        ) values (
          ${`bpg_${randomUUID()}`}, ${specialized.id}, ${ownerId}, ${clientProfile.id},
          ${"read-only"}
        )
      `.execute(database),
    ).rejects.toThrow();

    // Two computers, each offering a browser: the placement rules below are
    // about a profile never running on two of them at once.
    const hostedRunnerId = await enrollBrowserRunner(ownerId, "Hosted browser");
    const laptopRunnerId = await enrollBrowserRunner(ownerId, "Browser Mac");
    const laptopGrant = await store.createBrowserProfileGrant({
      access: "full-control",
      createdBy: ownerId,
      profileId: profile.id,
      workspaceId: specialized.id,
    });
    expect(laptopGrant.access).toBe("full-control");

    const sessionId = createBrowserSessionId();
    const session = await store.createBrowserSession({
      id: sessionId,
      leaseGeneration: 1,
      leaseTokenHash: "sha256:lease",
      origin: "workspace",
      placementKey: `runner:${hostedRunnerId}:hosted-browser-1`,
      profileId: profile.id,
      runnerId: hostedRunnerId,
      runtimeId: "hosted-browser-1",
      workspaceId: workspace.id,
    });
    expect(session.state).toBe("starting");
    expect((await store.getBrowserSessionForOwner(sessionId, ownerId))?.id).toBe(sessionId);
    expect(
      await store.authorizeBrowserProfileLease({
        leaseTokenHash: "sha256:lease",
        profileId: profile.id,
        sessionId,
      }),
    ).toBe(true);

    const otherSessionId = createBrowserSessionId();
    await expect(
      store.createBrowserSession({
        id: otherSessionId,
        leaseGeneration: 1,
        leaseTokenHash: "sha256:other",
        origin: "workspace",
        placementKey: `runner:${hostedRunnerId}:hosted-browser-1`,
        profileId: profile.id,
        runnerId: hostedRunnerId,
        runtimeId: "hosted-browser-1",
        workspaceId: specialized.id,
      }),
    ).resolves.toMatchObject({ profileId: profile.id });

    await expect(
      store.attachBrowserSession({
        agentBindingId: "trigger:specialized-browser",
        ownerId,
        sessionId: otherSessionId,
        workspaceId: specialized.id,
      }),
    ).resolves.toBe(true);
    await store.attachBrowserSession({
      agentBindingId: "trigger:main-browser",
      ownerId,
      sessionId: otherSessionId,
      workspaceId: workspace.id,
    });
    expect(await store.listActiveBrowserSessionsForAgentBinding("trigger:main-browser")).toEqual([
      expect.objectContaining({ id: otherSessionId }),
    ]);
    // A binding holds a set of sessions, most recently attached first; attaching
    // again only refreshes recency.
    await store.attachBrowserSession({
      agentBindingId: "trigger:main-browser",
      ownerId,
      sessionId,
      workspaceId: workspace.id,
    });
    expect(
      (await store.listActiveBrowserSessionsForAgentBinding("trigger:main-browser")).map(
        ({ id }) => id,
      ),
    ).toEqual([sessionId, otherSessionId]);
    // Attaching again changes who is attached for nobody, so it says so.
    await expect(
      store.attachBrowserSession({
        agentBindingId: "trigger:main-browser",
        ownerId,
        sessionId: otherSessionId,
        workspaceId: workspace.id,
      }),
    ).resolves.toBe(false);
    expect(
      (await store.listActiveBrowserSessionsForAgentBinding("trigger:main-browser")).map(
        ({ id }) => id,
      ),
    ).toEqual([otherSessionId, sessionId]);
    expect(await store.countBrowserSessionAttachments(otherSessionId)).toBe(2);
    expect(
      await store.listActiveBrowserSessionsForAgent({
        allOwnerWorkspaces: false,
        ownerId,
        workspaceId: specialized.id,
      }),
    ).toEqual([expect.objectContaining({ activeAttachmentCount: 2, id: otherSessionId })]);
    expect(
      await store.detachBrowserSessionAttachmentsForProfileGrant({
        ownerId,
        profileId: profile.id,
        workspaceId: specialized.id,
      }),
    ).toBe(1);
    expect(
      await store.listActiveBrowserSessionsForAgentBinding("trigger:specialized-browser"),
    ).toEqual([]);
    expect(
      (await store.listActiveBrowserSessionsForAgentBinding("trigger:main-browser")).map(
        ({ id }) => id,
      ),
    ).toEqual([otherSessionId, sessionId]);
    await expect(store.detachBrowserSessionAttachments("trigger:main-browser")).resolves.toEqual(
      expect.arrayContaining([otherSessionId, sessionId]),
    );
    expect(await store.listActiveBrowserSessionsForAgentBinding("trigger:main-browser")).toEqual(
      [],
    );

    await expect(
      store.createBrowserSession({
        id: createBrowserSessionId(),
        leaseGeneration: 1,
        leaseTokenHash: "sha256:elsewhere",
        origin: "workspace",
        placementKey: `runner:${laptopRunnerId}:local-browser`,
        profileId: profile.id,
        runnerId: laptopRunnerId,
        runtimeId: "local-browser",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(
      (
        await store.transitionBrowserSession({
          from: ["starting"],
          sessionId,
          state: "ready",
        })
      ).session.state,
    ).toBe("ready");
    await store.transitionBrowserSession({ from: ["ready"], sessionId, state: "closing" });
    await store.transitionBrowserSession({ from: ["closing"], sessionId, state: "closed" });
    expect(
      await store.authorizeBrowserProfileLease({
        leaseTokenHash: "sha256:lease",
        profileId: profile.id,
        sessionId,
      }),
    ).toBe(true);
    expect(
      (await store.failActiveBrowserSessions(`runner:${hostedRunnerId}:hosted-browser-1`)).failed,
    ).toBe(1);
    expect((await store.getBrowserSessionForOwner(sessionId, ownerId))?.state).toBe("closed");
    expect(
      await store.authorizeBrowserProfileLease({
        leaseTokenHash: "sha256:other",
        profileId: profile.id,
        sessionId: otherSessionId,
      }),
    ).toBe(true);
    await expect(
      store.createBrowserSession({
        id: createBrowserSessionId(),
        leaseGeneration: 1,
        leaseTokenHash: "sha256:move-too-early",
        origin: "workspace",
        placementKey: `runner:${laptopRunnerId}:local-browser`,
        profileId: profile.id,
        runnerId: laptopRunnerId,
        runtimeId: "local-browser",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const encryptedRevision = Buffer.alloc(30, 1);
    await store.commitBrowserProfileRevision({
      ciphertext: encryptedRevision,
      ciphertextSha256: createHash("sha256").update(encryptedRevision).digest("hex"),
      expectedRevision: 0,
      profileId: profile.id,
    });
    // A profile in use saves repeatedly; only the newest ciphertext is kept.
    const laterRevision = Buffer.alloc(30, 2);
    await store.commitBrowserProfileRevision({
      ciphertext: laterRevision,
      ciphertextSha256: createHash("sha256").update(laterRevision).digest("hex"),
      expectedRevision: 1,
      profileId: profile.id,
    });
    expect(
      await sql<{ revision: number }>`
        select revision from browser_profile_revisions where profile_id = ${profile.id}
      `.execute(database),
    ).toMatchObject({ rows: [{ revision: 2 }] });
    await expect(store.readBrowserProfileRevision(profile.id)).resolves.toMatchObject({
      revision: 2,
    });
    expect(
      await store.authorizeBrowserProfileLease({
        leaseTokenHash: "sha256:lease",
        profileId: profile.id,
        sessionId,
      }),
    ).toBe(false);
    expect(
      await store.authorizeBrowserProfileLease({
        leaseTokenHash: "sha256:other",
        profileId: profile.id,
        sessionId: otherSessionId,
      }),
    ).toBe(false);
    await expect(
      store.createBrowserSession({
        id: createBrowserSessionId(),
        leaseGeneration: 1,
        leaseTokenHash: "sha256:moved",
        origin: "workspace",
        placementKey: `runner:${laptopRunnerId}:local-browser`,
        profileId: profile.id,
        runnerId: laptopRunnerId,
        runtimeId: "local-browser",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({ runnerId: laptopRunnerId });

    const freshSessionId = createBrowserSessionId();
    await expect(
      store.createBrowserSession({
        id: freshSessionId,
        leaseGeneration: 1,
        leaseTokenHash: null,
        origin: "workspace",
        placementKey: `runner:${hostedRunnerId}:hosted-browser-1`,
        profileId: null,
        runnerId: hostedRunnerId,
        runtimeId: "hosted-browser-1",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({ profileId: null, state: "starting" });
    await expect(
      store.createBrowserSession({
        id: createBrowserSessionId(),
        leaseGeneration: 1,
        leaseTokenHash: null,
        origin: "workspace",
        placementKey: `runner:${hostedRunnerId}:hosted-browser-1`,
        profileId: null,
        runnerId: hostedRunnerId,
        runtimeId: "hosted-browser-1",
        workspaceId: workspace.id,
      }),
    ).resolves.toMatchObject({ profileId: null });
    expect(await store.getBrowserSessionForOwner(freshSessionId, ownerId)).toMatchObject({
      id: freshSessionId,
      profileId: null,
    });
    expect((await store.listBrowserSessions(ownerId)).map(({ id }) => id)).toContain(
      freshSessionId,
    );
    expect(
      await store.listActiveBrowserSessionsForAgent({
        allOwnerWorkspaces: false,
        ownerId,
        workspaceId: workspace.id,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: freshSessionId, profileId: null })]),
    );
    const outsiderId = await store.createUser("Outsider");
    expect(await store.getBrowserSessionForOwner(freshSessionId, outsiderId)).toBeNull();
    expect(await store.listBrowserSessions(outsiderId)).toEqual([]);
  });
});
