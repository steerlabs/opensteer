import { createId, harnessSessionBrokenFailureCode } from "@opensteer/core";
import { expect } from "vitest";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Broken provider session recovery", (it) => {
  it("rotates the active provider session on harness_session_broken so the next run starts fresh with portable context", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId, environmentId } = await createRunFixture("session-broken");
    const firstTurn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Build the extension" }],
      idempotencyKey: "session-broken-turn-1",
    });
    await store.claimCommand(firstTurn.command.id, "recovery-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "broken-lease-1",
      runnerBootId: "broken-boot-1",
      runnerId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: thread.harnessInstanceId,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "native-antigravity-session-1",
      runId: firstTurn.run.id,
      runnerBootId: "broken-boot-1",
      runnerId,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    };
    const commit = (
      ordinal: number,
      type: Parameters<typeof pendingEvent>[0]["type"],
      data: Record<string, unknown>,
    ) =>
      store.commitRunnerEvent({
        environmentId,
        runnerId,
        runnerBootId: "broken-boot-1",
        event: pendingEvent({ ...base, ordinal, type, data } as Parameters<typeof pendingEvent>[0]),
      });

    await commit(0, "run.started", { status: "running" });
    await commit(1, "assistant.message", {
      content: [{ text: "Started analyzing the extension.", type: "text" }],
      messageId: createId("message"),
    });
    await commit(2, "run.failed", {
      code: harnessSessionBrokenFailureCode,
      message: "Antigravity's saved conversation can no longer be sent to the model.",
      retryable: true,
      status: "failed",
    });

    const sessions = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("threadId", "=", thread.id)
      .orderBy("createdAt", "asc")
      .execute();
    expect(sessions).toHaveLength(2);
    const [retired, replacement] = sessions;
    expect(retired).toMatchObject({
      active: false,
      id: binding.providerSessionId,
      providerSessionReference: "native-antigravity-session-1",
      status: "broken",
    });
    expect(replacement).toMatchObject({
      active: true,
      harnessInstanceId: retired!.harnessInstanceId,
      providerSessionReference: null,
      status: "starting",
    });

    const secondTurn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "please continue" }],
      idempotencyKey: "session-broken-turn-2",
    });
    expect(secondTurn.run.providerSessionId).toBe(replacement!.id);
    await store.claimCommand(secondTurn.command.id, "recovery-dispatcher");

    const nextRun = await database
      .selectFrom("runs")
      .select(["initialContext", "providerSessionId"])
      .where("id", "=", secondTurn.run.id)
      .executeTakeFirstOrThrow();
    expect(nextRun.providerSessionId).toBe(replacement!.id);
    expect(nextRun.initialContext).toMatchObject({
      messageIds: expect.arrayContaining([firstTurn.message.id]),
    });
  });

  it("assigns an already-waiting follow-up run to the replacement provider session with portable context", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId, environmentId } =
      await createRunFixture("session-broken-queued");
    const firstTurn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Start work" }],
      idempotencyKey: "session-broken-queued-1",
    });
    await store.claimCommand(firstTurn.command.id, "recovery-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "broken-queued-lease-1",
      runnerBootId: "broken-queued-boot-1",
      runnerId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: thread.harnessInstanceId,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "native-antigravity-session-queued",
      runId: firstTurn.run.id,
      runnerBootId: "broken-queued-boot-1",
      runnerId,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    };
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "broken-queued-boot-1",
      event: pendingEvent({
        ...base,
        ordinal: 0,
        type: "run.started",
        data: { status: "running" },
      }),
    });
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "broken-queued-boot-1",
      event: pendingEvent({
        ...base,
        ordinal: 1,
        type: "assistant.message",
        data: {
          content: [{ text: "Halfway through.", type: "text" }],
          messageId: createId("message"),
        },
      }),
    });

    // Enqueue a follow-up message while Run 1 is still active.
    await store.enqueueThreadInput({
      content: [{ text: "queued follow-up", type: "text" }],
      idempotencyKey: "session-broken-queued-followup",
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: thread.id,
    });

    // Fail Run 1 with harness_session_broken; finalizeRunOutcome rotates the session AND ensures the queued Run.
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "broken-queued-boot-1",
      event: pendingEvent({
        ...base,
        ordinal: 2,
        type: "run.failed",
        data: {
          code: harnessSessionBrokenFailureCode,
          message: "Saved conversation is corrupted.",
          retryable: true,
          status: "failed",
        },
      }),
    });

    const replacement = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    expect(replacement.id).not.toBe(binding.providerSessionId);
    expect(replacement.providerSessionReference).toBeNull();

    const queuedRun = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    expect(queuedRun.providerSessionId).toBe(replacement.id);
    const queuedCommand = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", queuedRun.id)
      .executeTakeFirstOrThrow();
    await store.claimCommand(queuedCommand.id, "recovery-dispatcher");

    const claimedQueuedRun = await database
      .selectFrom("runs")
      .select(["initialContext", "providerSessionId"])
      .where("id", "=", queuedRun.id)
      .executeTakeFirstOrThrow();
    expect(claimedQueuedRun.providerSessionId).toBe(replacement.id);
    expect(claimedQueuedRun.initialContext).toMatchObject({
      messageIds: expect.arrayContaining([firstTurn.message.id]),
    });
  });

  it("keeps the active provider session on ordinary harness_error failures", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId, environmentId } = await createRunFixture("session-kept");
    const firstTurn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Do something" }],
      idempotencyKey: "session-kept-turn-1",
    });
    await store.claimCommand(firstTurn.command.id, "kept-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "kept-lease-1",
      runnerBootId: "kept-boot-1",
      runnerId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: thread.harnessInstanceId,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "native-antigravity-session-2",
      runId: firstTurn.run.id,
      runnerBootId: "kept-boot-1",
      runnerId,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: firstTurn.run.id,
      threadId: thread.id,
    };
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "kept-boot-1",
      event: pendingEvent({
        ...base,
        ordinal: 0,
        type: "run.started",
        data: { status: "running" },
      }),
    });
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "kept-boot-1",
      event: pendingEvent({
        ...base,
        ordinal: 1,
        type: "run.failed",
        data: {
          code: "harness_error",
          message: "Transient network timeout",
          retryable: true,
          status: "failed",
        },
      }),
    });

    const sessions = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("threadId", "=", thread.id)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      active: true,
      id: binding.providerSessionId,
      providerSessionReference: "native-antigravity-session-2",
      status: "broken",
    });
  });
});
