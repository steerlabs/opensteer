import { expect } from "vitest";
import { readPersonalTaskPage } from "./personal-task-store.js";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Provider retry persistence and projections", (it) => {
  it("projects run.retry onto runs, transcript run items, and active task rows, and clears on recovery and failure", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId, environmentId } = await createRunFixture("provider-retry");
    const turn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Set up Sales CRM" }],
      idempotencyKey: "provider-retry-turn",
    });
    await store.claimCommand(turn.command.id, "retry-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "retry-lease",
      runnerBootId: "retry-boot",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
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
        runnerBootId: "retry-boot",
        event: pendingEvent({ ...base, ordinal, type, data } as Parameters<typeof pendingEvent>[0]),
      });

    await commit(0, "run.started", { status: "running" });
    await commit(1, "run.retry", {
      status: "retrying",
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: 308_000,
      code: "model_capacity",
      message: "Selected model is at capacity.",
    });

    const readRun = () =>
      database
        .selectFrom("runs")
        .select("providerRetry")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow();
    const readRunItem = () =>
      database
        .selectFrom("transcriptItems")
        .select("view")
        .where("runId", "=", turn.run.id)
        .where("kind", "=", "run")
        .executeTakeFirstOrThrow();
    const readActiveTask = async () => {
      const page = await readPersonalTaskPage(database, {
        viewerId: userId,
        window: "active",
      });
      return page.tasks.find((task) => task.id === thread.id);
    };

    const expectedRetry = {
      status: "retrying",
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: 308_000,
      code: "model_capacity",
      message: "Selected model is at capacity.",
    };
    expect((await readRun()).providerRetry).toEqual(expectedRetry);
    expect((await readRunItem()).view).toMatchObject({ retry: expectedRetry });
    expect((await readActiveTask())?.retry).toEqual(expectedRetry);

    // Recovery clears runs.provider_retry, the transcript item's retry, and the task row's retry.
    await commit(2, "run.retry", {
      status: "recovered",
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: 308_000,
      code: "model_capacity",
      message: "Selected model is at capacity.",
    });
    expect((await readRun()).providerRetry).toBeNull();
    expect((await readRunItem()).view).not.toHaveProperty("retry");
    expect((await readActiveTask())?.retry).toBeNull();

    // Terminal failure also clears an active retry.
    await commit(3, "run.retry", {
      status: "retrying",
      attempt: 3,
      maxAttempts: 5,
      message: "Selected model is at capacity.",
    });
    expect((await readRun()).providerRetry).toMatchObject({ status: "retrying", attempt: 3 });

    await commit(4, "run.failed", {
      status: "failed",
      code: "harness_error",
      message: "Provider stayed in retries for 10 minutes: Selected model is at capacity.",
      retryable: false,
    });
    expect((await readRun()).providerRetry).toBeNull();
    expect((await readRunItem()).view).not.toHaveProperty("retry");
  });
});
