import { findPersonalSettings } from "./personal-settings-store.js";
import { createId } from "@opensteer/core";
import { expect } from "vitest";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Claude compaction persistence", (it) => {
  it("persists the owner's policy and refuses another person", async ({ storeFixture }) => {
    const { store, database, createRunFixture } = storeFixture;
    const { userId } = await createRunFixture("compaction-policy");
    await expect(
      store.notificationState.setIdleCompactionPolicy({
        userId: createId("user"),
        policy: { mode: "off" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await store.notificationState.setIdleCompactionPolicy({
      userId,
      policy: { mode: "beforeCacheExpires" },
    });
    expect((await findPersonalSettings(database))?.idleCompactionPolicy).toEqual({
      mode: "beforeCacheExpires",
    });
  });
  it("persists fenced context evidence and clears it at a native compaction boundary", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId, environmentId } =
      await createRunFixture("compaction-context");
    const turn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Continue" }],
      idempotencyKey: "context",
    });
    await store.claimCommand(turn.command.id, "context-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "context-lease",
      runnerBootId: "context-boot",
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
    const data = {
      usedTokens: 200_000,
      measuredAt: 1_000,
      requestStartedAt: 900,
      promptCacheTtlMs: 300_000 as const,
    };
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "context-boot",
      event: pendingEvent({ ...base, type: "run.context-measured", ordinal: 0, data }),
    });
    const read = () =>
      database
        .selectFrom("providerSessions")
        .select("contextSnapshot")
        .where("id", "=", binding.providerSessionId)
        .executeTakeFirstOrThrow();
    expect((await read()).contextSnapshot).toEqual({
      ...data,
      sourceRunId: turn.run.id,
      bindingGeneration: binding.bindingGeneration,
      ordinal: 0,
    });
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "context-boot",
      event: pendingEvent({
        ...base,
        type: "run.compaction",
        ordinal: 1,
        data: { status: "created", reason: "automatic" },
      }),
    });
    expect((await read()).contextSnapshot).toBeNull();
  });
  it("terminalizes lost maintenance without creating a recovery attempt", async ({
    storeFixture,
  }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, thread, runnerId } = await createRunFixture("compaction-recovery");
    const turn = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "/compact" }],
      idempotencyKey: "maintenance",
    });
    await store.claimCommand(turn.command.id, "maintenance-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "maintenance-lease",
      runnerBootId: "maintenance-boot",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    await database
      .updateTable("runs")
      .set({
        maintenance: {
          kind: "claude-compaction",
          reason: "idle",
          sourceRunId: turn.run.id,
          providerSessionId: binding.providerSessionId,
        },
      })
      .where("id", "=", turn.run.id)
      .execute();
    await database
      .updateTable("providerSessions")
      .set({
        providerSessionReference: "existing-session",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where("id", "=", binding.providerSessionId)
      .execute();
    await store.recoverRunsWithExpiredExecutionBindings();
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", turn.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("failed");
    const attempts = await database
      .selectFrom("runAttempts")
      .select("reason")
      .where("runId", "=", turn.run.id)
      .execute();
    expect(attempts.some((attempt) => attempt.reason === "recovery")).toBe(false);
  });
});
