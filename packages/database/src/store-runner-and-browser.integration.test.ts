import { withTimeout } from "@opensteer/shared/withTimeout";
import { lockDeploymentEvents } from "./personal-transaction.js";

import { createId, type ThreadId, type UserId } from "@opensteer/core";
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
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, vi } from "vitest";
import { configuredBootstrapEnrollmentLifetimeMs, OpensteerStore } from "./index.js";
import type { StoreFixture } from "./store.integration.test-support.js";
import {
  describeStore,
  enrollTestRunner,
  fingerprint,
  liveRequest,
  pendingEvent,
  reachOnlyModules,
  sealedTestRequestResponse,
  testContinuationIdentity,
  testModelSelection,
  testRunnerDescriptor,
  writeBrowserUsageArtifact,
} from "./store.integration.test-support.js";
async function personalDeployment({ store }: StoreFixture): Promise<void> {
  await store.ensureDeployment({
    canonicalOrigin: "http://127.0.0.1:4310",
    hostInstanceId: createId("hostInstance"),
    deploymentShape: { kind: "personal" },
  });
}
describeStore("PostgreSQL store", (it) => {
  it("delivers secret input through ciphertext while redacting durable projections", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("secret-input");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          text: "Request a secret",
          type: "text",
        },
      ],
      idempotencyKey: "secret-input-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-secret-input");
    const binding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-secret-input",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
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
    } as const;
    await commit(
      pendingEvent({
        ...base,
        data: {
          status: "running",
        },
        ordinal: 0,
        type: "run.started",
      }),
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
      response: {
        answers: {
          password: [secretAnswer],
        },
        kind: "form" as const,
      },
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
        response: {
          answers: {
            password: ["different"],
          },
          kind: "form",
        },
        sealedResponse: {
          ...encrypted,
          requestFingerprint: "hmac-sha256-v1:1:different-action-response",
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
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
      .selectFrom("deploymentEvents")
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
      response: {
        answers: {
          password: [],
        },
        kind: "form",
      },
      status: "fulfilled",
    });
  });
  it("rolls back a direct command claim when its Run cannot enter starting", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const { thread, userId } = await createRunFixture("claim-atomicity");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Claim this atomically",
        },
      ],
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
      ).toEqual({
        attempts: 0,
        dispatcherId: null,
        status: "pending",
      });
      expect(
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", turn.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: "queued",
      });
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
      content: [
        {
          type: "text",
          text: "Claim without a Run-to-Command deadlock",
        },
      ],
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
      await vi.waitFor(
        async () => {
          const result = await sql<{
            readonly waiting: number;
          }>`
            select count(*)::integer as waiting
            from pg_locks locks
            join pg_stat_activity activity on activity.pid = locks.pid
            where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
          `.execute(database);
          expect(
            Number(result.rows[0]?.waiting ?? 0),
            "The operation never waited on its database lock",
          ).toBeGreaterThan(0);
        },
        { timeout: 1_000, interval: 5 },
      );

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
      ).resolves.toEqual({
        id: turn.command.id,
      });
    } finally {
      releaseRunLock();
      await blocker;
    }
    await expect(claim).resolves.toMatchObject({
      command: {
        id: turn.command.id,
        status: "dispatched",
      },
    });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "starting",
    });
  });
  it("locks a Run before retrying its Command and rolls the pair back atomically", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { thread, userId } = await createRunFixture("retry-lock-order");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Retry without a Run-to-Command deadlock",
        },
      ],
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
      await vi.waitFor(
        async () => {
          const result = await sql<{
            readonly waiting: number;
          }>`
            select count(*)::integer as waiting
            from pg_locks locks
            join pg_stat_activity activity on activity.pid = locks.pid
            where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
          `.execute(database);
          expect(
            Number(result.rows[0]?.waiting ?? 0),
            "The operation never waited on its database lock",
          ).toBeGreaterThan(0);
        },
        { timeout: 1_000, interval: 5 },
      );
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
      ).resolves.toEqual({
        id: turn.command.id,
      });
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
    ).resolves.toEqual({
      dispatcherId: null,
      status: "pending",
    });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "queued",
    });
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
      ).resolves.toEqual({
        dispatcherId: "host-worker-retry-rollback",
        status: "dispatched",
      });
      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", turn.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: "starting",
      });
    } finally {
      await sql`drop trigger if exists opensteer_test_reject_queued on runs`.execute(database);
      await sql`drop function if exists opensteer_test_reject_queued()`.execute(database);
    }
  });
  it("locks the Deployment before the Thread when admitting inbox input", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, enqueueHumanTrigger } = storeFixture;
    const { thread, userId } = await createRunFixture("enqueue-lock-order");
    let releaseDeploymentLock: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseDeploymentLock = resolve;
    });
    let announceDeploymentLock: () => void = () => {};
    const deploymentLockAcquired = new Promise<void>((resolve) => {
      announceDeploymentLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await lockDeploymentEvents(transaction);
      announceDeploymentLock();
      await releaseSignal;
    });
    await withTimeout(deploymentLockAcquired, 1_000, {
      timeoutError: () => new Error("The Deployment lock was never acquired"),
    });
    const enqueue = enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Queue behind the Deployment lock",
        },
      ],
      idempotencyKey: "enqueue-lock-order-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    void enqueue.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          const result = await sql<{
            readonly waiting: number;
          }>`
            select count(*)::integer as waiting
            from pg_locks locks
            join pg_stat_activity activity on activity.pid = locks.pid
            where locks.granted = false
            and locks.locktype = 'transactionid'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
          `.execute(database);
          expect(
            Number(result.rows[0]?.waiting ?? 0),
            "The operation never waited on its database lock",
          ).toBeGreaterThan(0);
        },
        { timeout: 1_000, interval: 5 },
      );
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
      ).resolves.toEqual({
        id: thread.id,
      });
    } finally {
      releaseDeploymentLock();
      await blocker;
    }
    await expect(enqueue).resolves.toMatchObject({
      command: {
        status: "pending",
        type: "run.execute",
      },
      run: {
        status: "queued",
        threadId: thread.id,
      },
    });
  });
  it("projects a non-retryable dispatch failure exactly once without stranding queued work", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { runnerId, thread, userId } = await createRunFixture("dispatch_failure");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "This dispatch will fail",
        },
      ],
      idempotencyKey: "dispatch-failure-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-dispatch-failure");
    const binding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-dispatch-failure",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      runnerBootId: "boot-dispatch-failure",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const laterInput = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "This queued turn must survive",
        },
      ],
      idempotencyKey: "dispatch-failure-later",
      policy: "queue",
      source: {
        kind: "human",
      },
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
    const later = {
      run: laterRun,
      command: laterCommand,
    };
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
        data: {
          input: {
            cancelReason: "run-ended-before-start",
            state: "cancelled",
          },
        },
        runId: turn.run.id,
        type: "thread-input.updated",
      },
      {
        type: "message.placed",
        runId: later.run.id,
      },
      {
        type: "run.queued",
        runId: later.run.id,
      },
      // The queued Run hides the failed completion from unread on every device.
      { type: "thread.state-changed", data: { latestRunCompletedAt: null } },
      { type: "thread.state-changed", data: { latestRunCompletedAt: null } },
    ]);
    await expect(store.failCommand(turn.command.id, "ambiguous retry")).resolves.toEqual([]);
    expect(JSON.stringify(failure)).not.toContain("top-secret-provider-token");
    expect(
      await database
        .selectFrom("deploymentEvents")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("runId", "=", turn.run.id)
        .where("type", "=", "run.failed")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      count: "1",
    });
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "failed",
    });
    await expect(
      database
        .selectFrom("providerSessions")
        .select("status")
        .where("id", "=", binding.providerSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "broken",
    });
    await expect(
      database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "running",
    });
    await store.claimCommand(later.command.id, "host-worker-retryable-dispatch");
    const retryEvent = await store.retryCommand(
      later.command.id,
      new Error("Runner temporarily offline"),
    );
    expect(retryEvent).toMatchObject([
      {
        data: {
          status: "queued",
        },
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
    ).resolves.toEqual({
      status: "queued",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", later.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "pending",
    });
    expect(
      await database
        .selectFrom("deploymentEvents")
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
      content: [
        {
          type: "text",
          text: "First queued task",
        },
      ],
      idempotencyKey: "preclaim-failure-first",
      policy: "queue",
      requestedBy: userId,
      source: {
        kind: "human",
      },
      threadId: thread.id,
    });
    const second = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Second queued task",
        },
      ],
      idempotencyKey: "preclaim-failure-second",
      policy: "queue",
      requestedBy: userId,
      source: {
        kind: "human",
      },
      threadId: thread.id,
    });
    const report = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Passive status report",
        },
      ],
      idempotencyKey: "preclaim-failure-report",
      policy: "report",
      requestedBy: userId,
      source: {
        kind: "human",
      },
      threadId: thread.id,
    });
    if (!first.command || !first.run) throw new Error("Expected the first queued Run");
    expect(second).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
    await store.claimCommand(first.command.id, "preclaim-failure-dispatcher");
    const events = await store.failCommand(first.command.id, "Failed before Runner start");
    expect(events.map(({ type }) => type)).toEqual([
      "run.failed",
      "thread-input.updated",
      "thread-input.updated",
      "message.placed",
      "run.queued",
      "thread.state-changed",
      "thread.state-changed",
    ]);
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", thread.id)
        .orderBy("runOrdinal", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        seedInputId: first.message.id,
        status: "failed",
      },
      {
        seedInputId: second.message.id,
        status: "queued",
      },
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", report.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: first.run.id,
      state: "unknown",
    });
  });
  it("commits one terminal outcome when dispatch failure races a Runner terminal event", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } =
      await createRunFixture("dispatch_failure_race");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Race the terminal projection",
        },
      ],
      idempotencyKey: "dispatch-failure-race-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-dispatch-failure-race");
    const binding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-dispatch-failure-race",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      runnerBootId: "boot-dispatch-failure-race",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId,
        ordinal: 0,
        runId: turn.run.id,
        threadId: thread.id,
        type: "run.started",
      }),
      runnerBootId: "boot-dispatch-failure-race",
      runnerId,
    });
    const outcomes = await Promise.allSettled([
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId,
          ordinal: 1,
          runId: turn.run.id,
          threadId: thread.id,
          type: "run.completed",
        }),
        runnerBootId: "boot-dispatch-failure-race",
        runnerId,
      }),
      store.failCommand(turn.command.id, "Dispatch failed concurrently"),
    ]);
    expect(outcomes[1]?.status).toBe("fulfilled");
    const terminalEvents = await database
      .selectFrom("deploymentEvents")
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
    const { environmentId, runnerId, thread, userId } =
      await createRunFixture("disconnect_recovery");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Wait for my input",
        },
      ],
      idempotencyKey: "disconnect-recovery-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-disconnect-recovery");
    const binding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-disconnect-recovery",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
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
    } as const;
    const requestId = createId("request");
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        ...base,
        data: {
          status: "running",
        },
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
              fields: [
                {
                  id: "answer",
                  multiSelect: false,
                  prompt: "Continue?",
                  secret: false,
                },
              ],
              kind: "form",
              title: "Input needed",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
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
    ).resolves.toEqual({
      events: [],
      terminatedRuns: [],
    });
    await expect(
      store.failActiveRunsForRunnerDisconnect({
        activeRunIds: [turn.run.id],
        runnerBootId: "another-boot",
        runnerId,
      }),
    ).resolves.toEqual({
      events: [],
      terminatedRuns: [],
    });
    const recovered = await store.failActiveRunsForRunnerDisconnect({
      activeRunIds: [turn.run.id],
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    expect(recovered.terminatedRuns).toEqual([
      {
        environmentId,
        runId: turn.run.id,
        threadId: thread.id,
      },
    ]);
    expect(recovered.events[0]).toMatchObject({
      data: {
        code: "runner_disconnected",
        retryable: false,
        status: "failed",
      },
      runId: turn.run.id,
      type: "run.failed",
    });
    const lateCancellation = await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          requestId,
          reason: "source-closed",
        },
        environmentId,
        ordinal: 2,
        runId: turn.run.id,
        threadId: thread.id,
        type: "request.cancelled",
      }),
      runnerBootId: "boot-disconnect-recovery",
      runnerId,
    });
    expect(lateCancellation.wasDuplicate).toBe(true);
    const lateTerminal = await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "interrupted",
        },
        environmentId,
        ordinal: 3,
        runId: turn.run.id,
        threadId: thread.id,
        type: "run.interrupted",
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
    ).resolves.toEqual({
      events: [],
      terminatedRuns: [],
    });
    expect(
      await database
        .selectFrom("requests")
        .select(["cancellationReason", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      cancellationReason: "process-lost",
      status: "cancelled",
    });
    await expect(
      database
        .selectFrom("commands")
        .select(["status"])
        .where("id", "=", turn.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      database
        .selectFrom("providerSessions")
        .select(["status"])
        .where("id", "=", binding.providerSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "broken",
    });
    await expect(
      database
        .selectFrom("deploymentEvents")
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
    const { environmentId, runnerId, thread, userId } = await createRunFixture("restart_recovery");
    const abandoned = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Crash before binding",
        },
      ],
      idempotencyKey: "restart-recovery-abandoned",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(abandoned.command.id, "host-before-restart");
    const abandonedBinding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-before-restart",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
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
        data: expect.objectContaining({
          reason: "recovery",
          attempt: 2,
        }),
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
    ).resolves.toEqual({
      status: "queued",
      bindingGeneration: null,
    });
    await expect(
      database
        .selectFrom("runAttempts")
        .select(["reason", "outcome"])
        .where("runId", "=", abandoned.run.id)
        .orderBy("ordinal", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        reason: "initial",
        outcome: "interrupted",
      },
      {
        reason: "recovery",
        outcome: null,
      },
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
      continuation: {
        expectedProviderSessionId: abandonedBinding.providerSessionId,
      },
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      idempotencyKey: "restart-recovery-explicit-new-session",
      modelSelection: testModelSelection,
      requestedBy: userId,
      threadId: thread.id,
    });
    const racing = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Race terminal recovery",
        },
      ],
      idempotencyKey: "restart-recovery-race",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(racing.command.id, "host-after-restart");
    const binding = await store.acquireExecutionBinding({
      leaseTokenHash: "lease-restart-recovery",
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      runnerBootId: "boot-restart-recovery",
      runnerId,
      runId: racing.run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId,
        ordinal: 0,
        runId: racing.run.id,
        threadId: thread.id,
        type: "run.started",
      }),
      runnerBootId: "boot-restart-recovery",
      runnerId,
    });
    const completed = store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId,
        ordinal: 1,
        runId: racing.run.id,
        threadId: thread.id,
        type: "run.completed",
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
      .selectFrom("deploymentEvents")
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
  it("lists the owner's tasks and bounds messages while rejecting another person", async ({
    storeFixture: f,
  }) => {
    const task = await f.createRunFixture("owner-coordination");
    const child = (
      await f.store.createThread({
        createdBy: task.userId,
        environmentId: task.environmentId,
        harnessInstanceId: task.harnessInstance.id,
        idempotencyKey: "coordination-child",
        modelSelection: testModelSelection,
        parentThreadId: task.threadId,
        title: "Child",
      })
    ).thread;
    for (let i = 1; i <= 3; i++)
      await f.store.enqueueThreadInput({
        requestedBy: task.userId,
        threadId: child.id,
        idempotencyKey: `coordination-${i}`,
        policy: "queue",
        source: { kind: "human" },
        content: [{ type: "text", text: `Message ${i}` }],
      });
    expect((await f.store.listThreadsForOwner(task.userId)).map((thread) => thread.id)).toEqual(
      expect.arrayContaining([task.threadId, child.id]),
    );
    const recent = await f.store.readThreadForOwner(child.id, task.userId, 2);
    expect(
      recent?.messages.map((message) =>
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      ),
    ).toEqual(["Message 2", "Message 3"]);
    const outsider = await f.store.createUser("Other person");
    await expect(
      f.store.createThread({
        createdBy: outsider,
        environmentId: task.environmentId,
        harnessInstanceId: task.harnessInstance.id,
        idempotencyKey: "foreign-create",
        modelSelection: testModelSelection,
        title: "Forbidden",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.store.readThreadForOwner(child.id, outsider, 2)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("lists personal and lineage scopes with escaped filters and complete pagination", async ({
    storeFixture: f,
  }) => {
    const root = await f.createRunFixture("agent-thread-list");
    const make = async (key: string, title: string, parentThreadId?: ThreadId) =>
      (
        await f.store.createThread({
          createdBy: root.userId,
          environmentId: root.environmentId,
          harnessInstanceId: root.harnessInstance.id,
          idempotencyKey: `agent-list-${key}`,
          modelSelection: testModelSelection,
          title,
          ...(parentThreadId ? { parentThreadId } : {}),
        })
      ).thread;
    const child = await make("child", "Contract review", root.threadId),
      sibling = await make("sibling", "Pricing review", root.threadId),
      grandchild = await make("grandchild", "Clause extraction", child.id),
      unrelated = await make("unrelated", "Report_2026 100% done");
    const scope = { kind: "personal" } as const;
    const read = (input: { before?: string; query?: string; maxItems?: number } = {}) =>
      f.store.agentThreadPageForOwner({
        ownerId: root.userId,
        scopeId: root.threadId,
        scope,
        ...input,
      });
    const all = await read();
    expect(new Set(all.threads.map((thread) => thread.id))).toEqual(
      new Set([root.threadId, child.id, sibling.id, grandchild.id, unrelated.id]),
    );
    const lineage = await f.store.agentThreadPageForOwner({
      ownerId: root.userId,
      scopeId: grandchild.id,
      scope: { kind: "lineage", threadId: grandchild.id },
    });
    expect(new Set(lineage.threads.map((thread) => thread.id))).toEqual(
      new Set([root.threadId, child.id, sibling.id, grandchild.id]),
    );
    const ids: ThreadId[] = [];
    let before: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await read({ maxItems: 2, ...(before ? { before } : {}) });
      ids.push(...page.threads.map((thread) => thread.id));
      expect(page.window.totalItems).toBe(5);
      if (!page.window.nextBefore) break;
      before = page.window.nextBefore;
    }
    expect(ids).toEqual(all.threads.map((thread) => thread.id));
    expect(new Set((await read({ query: "REVIEW" })).threads.map((thread) => thread.id))).toEqual(
      new Set([child.id, sibling.id]),
    );
    for (const query of ["%", "_", "100%"])
      expect((await read({ query })).threads.map((thread) => thread.id)).toEqual([unrelated.id]);
    await expect(read({ before: "invalid" })).rejects.toMatchObject({ code: "bad_request" });
    const outsider = await f.store.createUser("Other person");
    await expect(
      f.store.agentThreadPageForOwner({ ownerId: outsider, scopeId: root.threadId, scope }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("enrolls Main and local Runners with separate one-shot records", async ({ storeFixture }) => {
    await personalDeployment(storeFixture);
    const { store, database, enablePersonalRemoteAccess } = storeFixture;
    await enablePersonalRemoteAccess();
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
        allowedModules: ["browser", "integrations", "messaging", "shell"],
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
      expect.objectContaining({
        name: "Alex's Mac",
        ownerKind: "user",
        runnerKind: "local",
      }),
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
      modules: reachOnlyModules,
      environmentId: localEnvironmentId,
      name: "Alex's Mac",
      runnerId: localRunnerId,
      runnerKind: "local",
    });
    const main = await store.enrollRunnerConnection({
      descriptor: mainDescriptor,
      enrollmentTokenHash: mainTokenHash,
      publicKeyFingerprint: fingerprint(mainKeys.publicKey),
      publicKeyPem: mainKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    const local = await store.enrollRunnerConnection({
      descriptor: localDescriptor,
      enrollmentTokenHash: localTokenHash,
      publicKeyFingerprint: fingerprint(localKeys.publicKey),
      publicKeyPem: localKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    expect(main.connectionGeneration).toBe(1);
    expect(local.connectionGeneration).toBe(1);
    expect(
      (
        await store.listRunners({
          includeDeployment: true,
          limit: 100,
          ownerId,
        })
      ).runners,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollmentId: mainEnrollmentId,
          id: mainRunnerId,
        }),
        expect.objectContaining({
          enrollmentId: localEnrollmentId,
          id: localRunnerId,
        }),
      ]),
    );
    expect(
      await store.listPendingRunnerEnrollments({
        includeDeployment: true,
        limit: 100,
        ownerId,
      }),
    ).toEqual([]);
    expect(await store.listEnvironments()).toEqual([
      expect.objectContaining({
        id: mainEnvironmentId,
        name: "Main computer",
        runnerId: mainRunnerId,
      }),
    ]);
    await expect(store.environmentRunnerOwner(mainEnvironmentId)).resolves.toBe(ownerId);
    const tabOpenedAt = async () =>
      (
        await store.listRunners({
          includeDeployment: false,
          limit: 100,
          ownerId,
        })
      ).runners.find((runner) => runner.id === localRunnerId)?.tabOpenedAt;
    expect(await tabOpenedAt()).toBeNull();
    await expect(store.openPhoneTab(localRunnerId)).resolves.toBe(true);
    const opened = await tabOpenedAt();
    expect(opened).toBeInstanceOf(Date);
    await expect(store.openPhoneTab(localRunnerId)).resolves.toBe(false);
    expect(await tabOpenedAt()).toEqual(opened);
    await store.closePhoneTab(localRunnerId);
    expect(await tabOpenedAt()).toBeNull();
    await store.renameRunner(localRunnerId, ownerId, "Studio Mac");
    await store.authenticateRunnerConnection({
      ...localDescriptor,
      name: "Descriptor name",
    });
    expect(
      (
        await store.listRunners({
          includeDeployment: false,
          limit: 100,
          ownerId,
        })
      ).runners.find((runner) => runner.id === localRunnerId)?.name,
    ).toBe("Studio Mac");
    expect(await store.listEnvironments()).not.toContainEqual(
      expect.objectContaining({ id: localEnvironmentId }),
    );
    const attackerKeys = generateKeyPairSync("ed25519");
    await expect(
      store.enrollRunnerConnection({
        descriptor: testRunnerDescriptor({
          modules: reachOnlyModules,
          environmentId: createId("environment"),
          name: "Other local Runner",
          runnerId: createId("runner"),
          runnerKind: "local",
        }),
        enrollmentTokenHash: localTokenHash,
        publicKeyFingerprint: fingerprint(attackerKeys.publicKey),
        publicKeyPem: attackerKeys.publicKey
          .export({
            format: "pem",
            type: "spki",
          })
          .toString(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await database
      .updateTable("runnerEnrollments")
      .set({
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where("tokenHash", "=", localTokenHash)
      .executeTakeFirstOrThrow();
    const recoveredAfterAmbiguousResponse = await store.enrollRunnerConnection({
      descriptor: {
        ...localDescriptor,
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      },
      enrollmentTokenHash: localTokenHash,
      publicKeyFingerprint: fingerprint(localKeys.publicKey),
      publicKeyPem: localKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    // The rename's reauthentication already advanced the fence once, so the
    // recovered enrollment is this Runner's third connection, not its second.
    expect(recoveredAfterAmbiguousResponse.connectionGeneration).toBe(3);
    const firstPage = await store.listRunners({
      includeDeployment: true,
      limit: 1,
      ownerId,
    });
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
    ).toEqual([
      expect.objectContaining({
        id: mainRunnerId,
        ownerKind: "deployment",
      }),
    ]);
    await expect(store.revokeRunner(localRunnerId, foreignOwnerId)).rejects.toMatchObject({
      code: "not_found",
    });
    await store.revokeRunner(localRunnerId, ownerId);
    await expect(store.authenticateRunnerConnection(localDescriptor)).rejects.toMatchObject({
      code: "forbidden",
    });
    const inventory = await store.listRunners({
      includeDeployment: true,
      limit: 100,
      ownerId,
    });
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
      deploymentShape: {
        kind: "personal",
      },
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
      allowedModules: ["browser", "integrations", "messaging", "shell"],
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
      store.revokeRunner(mainRunnerId, ownerId, {
        allowDeployment: true,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      (
        await store.listRunners({
          includeDeployment: true,
          limit: 100,
          ownerId,
        })
      ).runners.find((runner) => runner.id === mainRunnerId)?.revokedAt,
    ).toBeNull();

    // The prohibition is about that one Runner, not about Personal Deployments.
    await store.revokeRunner(lentRunnerId, ownerId);
  });
  describe("Personal membership", () => {
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
        ...(input.runnerKind === "main"
          ? {
              mainEnrollmentPurpose: "initial" as const,
            }
          : {}),
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
      ).rejects.toMatchObject({
        code: "forbidden",
      });

      // The issuance caller supplies the full reachable grant; storage does
      // not turn an empty grant into a different one.
      await expect(
        enrollment(storeFixture, {
          allowedModules: ["browser", "integrations", "messaging", "shell"],
          createdBy: ownerId,
          runnerKind: "local",
          suffix: "reachable",
        }),
      ).resolves.toMatchObject({
        allowedModules: ["browser", "integrations", "messaging", "shell"],
      });
      await expect(
        enrollment(storeFixture, {
          allowedModules: [],
          createdBy: ownerId,
          runnerKind: "local",
          suffix: "reachable-by-default",
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
      // The Main Runner is the Deployment, so its bootstrap grant is the one
      // exception and it still carries agents and browser.
      await expect(
        enrollment(storeFixture, {
          allowedModules: ["agents", "browser"],
          createdBy: null,
          runnerKind: "main",
          suffix: "main",
        }),
      ).resolves.toMatchObject({
        allowedModules: ["agents", "browser"],
      });
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
        allowedModules: ["browser", "integrations", "messaging", "shell"],
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
        allowedModules: ["browser", "integrations", "messaging", "shell"],
      });

      // The grant widens behind the store's back — a restored backup, a
      // Deployment that used to be a server. The credential is intact and the
      // machine still advertises only `shell`, and it is still refused.
      await database
        .updateTable("runners")
        .set({
          allowedModules: sql`'["shell"]'::jsonb`,
        })
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
        allowedModules: ["browser", "integrations", "messaging", "shell"],
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
          publicKeyPem: keys.publicKey
            .export({
              format: "pem",
              type: "spki",
            })
            .toString(),
        });
      await expect(redeem()).rejects.toMatchObject({
        code: "forbidden",
        message: "Turn on remote access on this computer to connect other computers.",
      });
      await enablePersonalRemoteAccess();
      await expect(redeem()).resolves.toMatchObject({
        connectionGeneration: 1,
      });

      // Turning it off again refuses the computer that already redeemed, on the
      // credential it kept. Nothing is revoked: the row is still there.
      await database
        .updateTable("personalRemoteAccess")
        .set({
          generation: 2,
          mode: "off",
          routeOrigin: null,
          updatedAt: new Date(),
        })
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
        (
          await store.listRunners({
            includeDeployment: true,
            limit: 100,
            ownerId,
          })
        ).runners.find((runner) => runner.id === runnerId)?.revokedAt,
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

  it("counts live tasks on the hosting computer and excludes archived tasks", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const first = await createRunFixture("thread-count-first");
    const extraThread = async (suffix: string) =>
      (
        await store.createThread({
          createdBy: first.userId,
          environmentId: first.environmentId,
          harnessInstanceId: first.harnessInstance.id,
          idempotencyKey: `thread-count-${suffix}`,
          modelSelection: testModelSelection,
          title: `Task ${suffix}`,
        })
      ).thread;
    await extraThread("live");
    const archived = await extraThread("archived");
    await database
      .updateTable("threads")
      .set({ status: "archived" })
      .where("id", "=", archived.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.countLiveThreadsByEnvironment([first.environmentId, createId("environment")]),
    ).resolves.toEqual(new Map([[first.environmentId, 2]]));
    await expect(store.countLiveThreadsByEnvironment([])).resolves.toEqual(new Map());
  });
  it("keeps reachable computers out of execution environments and resolves the hosting enrollment creator", async ({
    storeFixture,
  }) => {
    const { store, enablePersonalRemoteAccess } = storeFixture;
    await enablePersonalRemoteAccess();
    const ownerId = await store.createUser("Local Runner owner");
    const localEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      modules: reachOnlyModules,
      createdBy: ownerId,
      environmentId: localEnvironmentId,
      name: "Local Runner",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "environment-runner-owner-local",
    });
    await expect(store.environmentRunnerOwner(localEnvironmentId)).resolves.toBeNull();
    await expect(store.environmentRunnerOwner(createId("environment"))).resolves.toBeNull();
    const deploymentEnvironmentId = createId("environment");
    const deploymentRunnerId = createId("runner");
    const deploymentTokenHash = `sha256:${createHash("sha256").update("environment-runner-owner-deployment").digest("base64url")}`;
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
      publicKeyPem: keys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    await expect(store.environmentRunnerOwner(deploymentEnvironmentId)).resolves.toBeNull();
  });

  it("rejects an expired unconsumed Runner enrollment", async ({ storeFixture }) => {
    await personalDeployment(storeFixture);
    const { store } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const tokenHash = `sha256:${createHash("sha256").update("expired-token").digest("base64url")}`;
    const keys = generateKeyPairSync("ed25519");
    await store.createRunnerEnrollment({
      allowedModules: ["browser", "integrations", "messaging", "shell"],
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
          modules: reachOnlyModules,
          environmentId,
          name: "Expired Runner",
          runnerId,
          runnerKind: "local",
        }),
        enrollmentTokenHash: tokenHash,
        publicKeyFingerprint: fingerprint(keys.publicKey),
        publicKeyPem: keys.publicKey
          .export({
            format: "pem",
            type: "spki",
          })
          .toString(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await store.runnerForAuthentication(runnerId)).toBeNull();
  });
  it("bounds configured bootstrap enrollments once without extending them on restart", async ({
    storeFixture,
  }) => {
    await personalDeployment(storeFixture);
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Bootstrap owner");
    const runnerTokenHash = `sha256:${createHash("sha256").update("configured-bootstrap-runner").digest("base64url")}`;
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
      .set({
        expiresAt: expiredAt,
      })
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
        publicKeyPem: runnerKeys.publicKey
          .export({
            format: "pem",
            type: "spki",
          })
          .toString(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("recovers an expired first-Main bootstrap with one owner-issued initial enrollment", async ({
    storeFixture,
  }) => {
    await personalDeployment(storeFixture);
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Initial Main recovery owner");
    const bootstrapTokenHash = `sha256:${createHash("sha256").update("expired-initial-main-bootstrap").digest("base64url")}`;
    await store.ensureBootstrapRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      id: `ren_${randomUUID()}`,
      tokenHash: bootstrapTokenHash,
    });
    await database
      .updateTable("runnerEnrollments")
      .set({
        expiresAt: new Date(Date.now() - 1_000),
      })
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
    ).rejects.toMatchObject({
      code: "conflict",
    });
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
      publicKeyPem: keys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
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
    await personalDeployment(storeFixture);
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
      publicKeyPem: keys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    try {
      await vi.waitFor(
        async () => {
          const result = await sql<{
            readonly waiting: number;
          }>`
            select count(*)::integer as waiting
            from pg_locks
            where locktype = 'advisory'
            and granted = false
            and database = (select oid from pg_database where datname = current_database())
          `.execute(database);
          expect(
            Number(result.rows[0]?.waiting ?? 0),
            "The operation never waited on its database lock",
          ).toBeGreaterThan(0);
        },
        { timeout: 1_000, interval: 5 },
      );
      expect(await store.runnerForAuthentication(runnerId)).toBeNull();
    } finally {
      releaseMainLock();
      await blocker;
    }
    await expect(consumption).resolves.toMatchObject({
      runnerId,
    });
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
  it("refuses to remove the hosting computer or replace it while it still hosts the Deployment", async ({
    storeFixture,
  }) => {
    await personalDeployment(storeFixture);
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
      publicKeyPem: oldKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
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
    await expect(
      store.revokeRunner(oldRunnerId, ownerId, { allowDeployment: true }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("cannot be removed"),
    });
    expect(await store.runnerForAuthentication(oldRunnerId)).not.toBeNull();
    await expect(store.createRunnerEnrollment(replacementInput)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/must be revoked/),
    });
  });

  it("replays Runner enrollment issuance exactly without persisting the raw token", async ({
    storeFixture,
  }) => {
    await personalDeployment(storeFixture);
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Alex");
    const rawToken = "runner-enrollment-plaintext-must-not-be-stored";
    const tokenHash = `sha256:${createHash("sha256").update(rawToken).digest("base64url")}`;
    const firstExpiry = new Date(Date.now() + 60_000);
    const first = await store.createRunnerEnrollment({
      allowedModules: ["browser", "integrations", "messaging", "shell"],
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
      allowedModules: ["browser", "integrations", "messaging", "shell"],
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
        allowedModules: ["browser", "integrations", "messaging", "shell"],
        createdBy: ownerId,
        expiresAt: firstExpiry,
        id: `ren_${randomUUID()}`,
        idempotencyKey: "local-runner-request-1",
        name: "Changed computer",
        requestFingerprint: "sha256:changed-request",
        runnerKind: "local",
        tokenHash: `sha256:${"z".repeat(43)}`,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
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
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          type: "text",
          text: "Browse",
        },
      ],
      title: "Recent browser task",
    });
    const browserRunnerId = await storeFixture.enrollBrowserRunner(
      fixture.userId,
      "Browser history fixture",
    );
    const sessionId = createBrowserSessionId();
    await nativeSession(store, {
      ownerId: fixture.userId,
      id: sessionId,
      origin: "agent",
      placementKey: `runner:${browserRunnerId}:browser`,
      profileId: null,
      runnerId: browserRunnerId,
      runtimeId: "browser",
    });
    const base = Date.parse("2026-10-13T00:00:00.000Z");
    await database
      .insertInto("browserSessionUses")
      .values(
        Array.from(
          {
            length: 650,
          },
          (_, index) => ({
            id: `projection-${index}`,
            sessionId,
            threadId: index === 0 ? fixture.thread.id : delegated.thread.id,
            runId: index === 0 ? fixture.run.id : delegated.run.id,
            tabId: `surface-${index}`,
            firstUsedAt: new Date(base + index),
            lastUsedAt: new Date(base + index),
          }),
        ),
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
    // Unused newer sessions must not displace this conversation's history.
    const newer = await database
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("browserSessions")
      .values(
        Array.from(
          {
            length: 101,
          },
          (_, index) => {
            const id = createBrowserSessionId();
            return {
              ...newer,
              id,
              tabGroupId: id,
              state: "closed" as const,
              createdAt: new Date(Date.now() + index + 1),
            };
          },
        ),
      )
      .execute();
    await database
      .updateTable("browserSessions")
      .set({
        state: "closed",
      })
      .where("id", "=", sessionId)
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
      expect.objectContaining({
        sessionId,
        runId: fixture.run.id,
        tabId: "surface-0",
      }),
    );
    // One membership and the Run's latest distinct pages, newest first.
    expect(recent).toHaveLength(1 + browserUsageTabsPerRun);
    expect(recent.filter((use) => use.runId === delegated.run.id).map((use) => use.tabId)).toEqual(
      Array.from(
        {
          length: browserUsageTabsPerRun,
        },
        (_, index) => `surface-${649 - index}`,
      ),
    );
    expect(recent).toContainEqual(
      expect.objectContaining({
        sessionId,
        runId: null,
        tabId: null,
      }),
    );
    const stranger = await store.createUser("Browser usage stranger");
    expect(
      await store.getThreadBrowserUsage({
        ownerId: stranger,
        threadId: fixture.thread.id,
        runIds: [fixture.run.id],
      }),
    ).toEqual([]);
    await writeBrowserUsageArtifact("browser-usage-projection.json", {
      lifetimeUseRows: 651,
      requestedRunBatchLimit: browserUsageRunBatchSize,
      pagesPerRun: browserUsageTabsPerRun,
      oldConversation: old,
      recentConversation: recent,
      exactOldTab: "surface-0",
      latestRecentTab: "surface-649",
      unauthorizedReaderRows: 0,
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
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          type: "text",
          text: "Browse",
        },
      ],
      title: "Browser task",
    });
    const sessionId = createBrowserSessionId();
    await nativeSession(store, {
      ownerId: fixture.userId,
      id: sessionId,
      origin: "agent",
      placementKey: `runner:${fixture.runnerId}:browser`,
      profileId: null,
      runnerId: fixture.runnerId,
      runtimeId: "browser",
    });
    const attach = {
      agentBindingId: `run:${delegated.run.id}`,
      ownerId: fixture.userId,
      sessionId,
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
      expect.objectContaining({
        sessionId,
        runId: null,
        tabId: null,
      }),
      expect.objectContaining({
        sessionId,
        runId: delegated.run.id,
        tabId: null,
      }),
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
            },
          ],
    );
    const stranger = await store.createUser("Other browser reader");
    expect(
      await store.listBrowserSessionThreads({
        ownerId: stranger,
        sessionIds: [sessionId],
      }),
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
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("links every browser page a Run used with its last title and site, credits included pages, and fences live attachments to active Runs", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("browser-pages");
    const browserRunnerId = await storeFixture.enrollBrowserRunner(
      fixture.userId,
      "Browser history fixture",
    );
    const sessionId = createBrowserSessionId();
    await nativeSession(store, {
      ownerId: fixture.userId,
      id: sessionId,
      origin: "agent",
      placementKey: `runner:${browserRunnerId}:browser`,
      profileId: null,
      runnerId: browserRunnerId,
      runtimeId: "browser",
    });
    const binding = `run:${fixture.run.id}`;
    const used = (
      tabId: string | null,
      page: {
        title: string;
        site: string;
      } | null,
    ) =>
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
        ...(joined
          ? {
              catalogSessionIds: [sessionId],
            }
          : {}),
        threadId: fixture.thread.id,
      },
    ];
    // Each page the Run reaches for the first time is news to its conversation;
    // only the first starts the conversation's use of the session.
    expect(
      await used("tab-a", {
        title: "Alpha",
        site: "https://a.example",
      }),
    ).toEqual(credit(true));
    expect(
      await used("tab-b", {
        title: "Beta",
        site: "https://b.example",
      }),
    ).toEqual(credit(false));
    // A revisit changes the latest-page order; a changed title changes the projection too.
    expect(await used("tab-a", null)).toEqual(credit(false));
    expect(
      await used("tab-b", {
        title: "Beta, signed in",
        site: "https://b.example",
      }),
    ).toEqual(credit(false));
    const pages = await store.getThreadBrowserUsage({
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
      runIds: [fixture.run.id],
    });
    expect(pages.filter((use) => use.runId === fixture.run.id)).toEqual([
      expect.objectContaining({
        tabId: "tab-b",
        pageTitle: "Beta, signed in",
      }),
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
    expect(
      await used("tab-a", {
        title: "Alpha revisited",
        site: "https://new.example",
      }),
    ).toEqual(credit(false));
    expect(
      await used("tab-a", {
        title: "Alpha revisited",
        site: "https://new.example",
      }),
    ).toEqual([]);
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
    await writeBrowserUsageArtifact("browser-usage-revisit.json", {
      bounded,
      revisited,
    });

    // A page the person included credits the conversation with that exact page.
    const included = {
      ownerId: fixture.userId,
      page: {
        title: "Checkout",
        site: "https://shop.example",
      },
      sessionId,
      tabId: "person-tab",
      threadId: fixture.thread.id,
    };
    expect(await store.recordBrowserSessionUse(included)).toEqual(credit(false));
    expect(await store.recordBrowserSessionUse(included)).toEqual([]);
    // A page whose id reads like a membership is still its own page.
    expect(
      await store.recordBrowserSessionUse({
        ...included,
        tabId: "session",
      }),
    ).toEqual(credit(false));
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
      store.recordBrowserSessionUse({
        ...included,
        ownerId: outsider,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // Every session belongs to the personal owner.
    expect(await store.listBrowserSessionViewers(sessionId)).toEqual({
      userIds: [fixture.userId],
    });
    // A live attachment exists only while its Run is active. Finalization holds
    // the Run's row while it ends it; an attach that arrives meanwhile waits
    // for it and then writes nothing.
    expect(
      await store.attachBrowserSession({
        agentBindingId: binding,
        ownerId: fixture.userId,
        sessionId,
      }),
    ).toBe(true);
    await store.detachBrowserSessionAttachments(binding);
    const finalizing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const finalization = database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("runs")
        .set({
          completedAt: new Date(),
          status: "completed",
        })
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
    });
    await expect
      .poll(async () => {
        const waiting = await sql<{
          waiting: number;
        }>`
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
    expect(
      await used("tab-after-end", {
        title: "Late",
        site: "https://late.example",
      }),
    ).toEqual(credit(false));
    // Trigger and watch bindings are not Runs; their sessions end with them.
    expect(
      await store.attachBrowserSession({
        agentBindingId: "trigger:occurrence:request:browse",
        ownerId: fixture.userId,
        sessionId,
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
      },
      lateAttachAfterRunEnd: false,
      attachedAfterRunEnd: [],
      durableUseAfterRunEnd: "credited",
    });
  });
  it("binds empty native profiles once and fences readiness and inventory after revocation", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const { binding, profile, ownerId } = await nativeProfileFixture(
      storeFixture,
      "native-authority",
    );
    expect(await store.getBrowserProfileStorage(profile.id)).toEqual({
      kind: "unbound",
    });
    expect(await store.bindBrowserProfile(binding)).toEqual({
      kind: "local",
      binding,
      initialized: false,
    });
    expect(
      await store.bindBrowserProfile({
        ...binding,
        bindingId: randomUUID(),
      }),
    ).toEqual({
      kind: "local",
      binding,
      initialized: false,
    });
    await expect(
      store.acknowledgeBrowserProfileReady({
        ...binding,
        bindingId: randomUUID(),
      }),
    ).rejects.toThrow();
    await store.acknowledgeBrowserProfileReady(binding);
    expect(await store.getBrowserProfileStorage(profile.id)).toEqual({
      kind: "local",
      binding,
      initialized: true,
    });
    await expect(
      store.reconcileBrowserProfileInventory({
        phase: "ready",
        binding: {
          ...binding,
          storageInstanceId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    await store.revokeRunner(binding.runnerId, ownerId, {
      allowDeployment: true,
    });
    await expect(
      store.reconcileBrowserProfileInventory({
        phase: "ready",
        binding,
      }),
    ).rejects.toThrow("cannot hold your browser profiles");
    await expect(store.acknowledgeBrowserProfileReady(binding)).rejects.toThrow("unavailable");
    await expect(store.getBrowserProfileStorage(profile.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await store.listBrowserProfileErasureJobs(binding.runnerId)).toEqual([]);
  });
  it("counts unfinished erasures against profile creation capacity until disk deletion completes", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const { ownerId, binding, profile } = await nativeProfileFixture(storeFixture, "capacity");
    await store.bindBrowserProfile(binding);
    await store.acknowledgeBrowserProfileReady(binding);
    await store.deleteBrowserProfile({
      ownerId,
      profileId: profile.id,
    });
    await database
      .insertInto("browserProfiles")
      .values(
        Array.from(
          {
            length: 126,
          },
          (_, index) => ({
            id: createId("browserProfile"),
            ownerId,
            homeRunnerId: binding.runnerId,
            name: `Profile ${index}`,
          }),
        ),
      )
      .execute();
    await store.createBrowserProfile({
      ownerId,
      name: "Last available slot",
      idempotencyKey: "capacity-last-slot",
    });
    const create = {
      ownerId,
      name: "Overflow",
      idempotencyKey: "capacity-overflow",
    };
    await expect(store.createBrowserProfile(create)).rejects.toMatchObject({
      code: "conflict",
    });
    const [job] = await store.listBrowserProfileErasureJobs(binding.runnerId);
    expect(job).toBeDefined();
    await store.acknowledgeBrowserProfileDeletion({
      binding,
      deletionId: job!.deletionId,
      state: "pending-restart",
    });
    await expect(store.createBrowserProfile(create)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await store.listPendingBrowserProfileDeletions(ownerId)).toHaveLength(1);
    await store.acknowledgeBrowserProfileDeletion({
      binding,
      deletionId: job!.deletionId,
      state: "deleted",
    });
    await expect(store.createBrowserProfile(create)).resolves.toMatchObject({
      name: "Overflow",
    });
  });
});
async function nativeProfileFixture(fixture: StoreFixture, name: string) {
  const { store } = fixture;
  const base = await fixture.createRunFixture("native-" + name);
  const ownerId = base.userId;
  await fixture.enablePersonalRemoteAccess();
  const runnerId = createId("runner");
  await enrollTestRunner(store, {
    allowedModules: ["browser", "integrations", "messaging", "shell"],
    modules: reachOnlyModules,
    createdBy: ownerId,
    environmentId: createId("environment"),
    name: "Native " + name,
    runnerId,
    runnerKind: "local",
    tokenSuffix: "native-profile-" + name,
  });
  const deployment = await store.database
    .selectFrom("deployments")
    .select("id")
    .executeTakeFirstOrThrow();
  const profile = await store.createBrowserProfile({
    ownerId,
    name,
    idempotencyKey: name,
  });
  return {
    ownerId,
    profile,
    binding: {
      version: 1 as const,
      deploymentId: deployment.id,
      runnerId,
      profileId: profile.id,
      storageInstanceId: randomUUID(),
      bindingId: randomUUID(),
      engine: "electron" as const,
    },
  };
}
async function nativeSession(
  store: OpensteerStore,
  input: Parameters<OpensteerStore["createBrowserSession"]>[0],
) {
  if (input.profileId) {
    const storage = await store.getBrowserProfileStorage(input.profileId);
    if (storage.kind === "unbound") {
      const existing = await store.database
        .selectFrom("deployments")
        .select("id")
        .executeTakeFirst();
      const deployment =
        existing ??
        (await store.ensureDeployment({
          canonicalOrigin: "http://127.0.0.1:4310",
          hostInstanceId: createId("hostInstance"),
          deploymentShape: { kind: "personal" },
        }));
      await store.bindBrowserProfile({
        version: 1,
        deploymentId: deployment.id,
        profileId: input.profileId,
        runnerId: input.runnerId,
        storageInstanceId: "20000000-0000-4000-8000-000000000001",
        bindingId: randomUUID(),
        engine: "chromium",
      });
    }
  }
  return store.createBrowserSession(input);
}
