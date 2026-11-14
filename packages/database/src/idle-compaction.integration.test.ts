import { jsonValue } from "./store-primitives.js";
import { admitIdleCompaction } from "./idle-compaction-store.js";
import { findPersonalSettings } from "./personal-settings-store.js";
import { createId, HarnessIdSchema } from "@opensteer/core";
import { expect } from "vitest";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  testModelSelection,
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
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "context-boot",
      event: pendingEvent({
        ...base,
        type: "run.started",
        ordinal: 0,
        data: { status: "running" },
      }),
    });
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
      event: pendingEvent({ ...base, type: "run.context-measured", ordinal: 1, data }),
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
      ordinal: 1,
    });
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "context-boot",
      event: pendingEvent({
        ...base,
        type: "run.compaction",
        ordinal: 2,
        data: { status: "created", reason: "automatic" },
      }),
    });
    expect((await read()).contextSnapshot).toBeNull();
  });
  it("admits one maintenance Run across concurrent wakes and reasons", async ({ storeFixture }) => {
    const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const { userId, environmentId, runnerId } = await createRunFixture("compaction-admission");
    const runner = await database
      .selectFrom("runners")
      .select("capabilities")
      .where("id", "=", runnerId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runners")
      .set({ capabilities: jsonValue([...runner.capabilities, "claude-compaction-v1"]) })
      .where("id", "=", runnerId)
      .execute();
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId,
      name: "Claude",
      stateKind: "isolated",
    });
    await store.recordHarnessCatalogs({
      environmentId,
      catalogs: [testReadyHarnessCatalog(harness.id)],
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    const { thread } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harness.id,
      modelSelection: testModelSelection,
      idempotencyKey: "claude-task",
      title: "Claude task",
    });
    const source = await enqueueHumanTrigger({
      threadId: thread.id,
      requestedBy: userId,
      content: [{ type: "text", text: "Long conversation" }],
      idempotencyKey: "source",
    });
    const sessionId = source.run.providerSessionId!;
    const now = Date.now();
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", source.run.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({ state: "delivered", runId: source.run.id })
      .where("messageId", "=", source.message.id)
      .execute();
    await database
      .updateTable("providerSessions")
      .set({
        providerSessionReference: "native-reference",
        contextSnapshot: {
          usedTokens: 200_000,
          measuredAt: now,
          requestStartedAt: now - 200_000,
          promptCacheTtlMs: 300_000,
          sourceRunId: source.run.id,
          bindingGeneration: 1,
          ordinal: 0,
        },
      })
      .where("id", "=", sessionId)
      .execute();
    await database
      .updateTable("personalSettings")
      .set({ idleCompactionPolicy: { mode: "beforeCacheExpires" } })
      .execute();
    const maintenance = {
      kind: "claude-compaction",
      reason: "idle",
      sourceRunId: source.run.id,
      providerSessionId: sessionId,
    } as const;
    const results = await Promise.all([
      admitIdleCompaction(database, {
        threadId: thread.id,
        requestedBy: userId,
        maintenance,
        nowMs: now,
      }),
      admitIdleCompaction(database, {
        threadId: thread.id,
        requestedBy: userId,
        maintenance,
        nowMs: now,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await admitIdleCompaction(database, {
        threadId: thread.id,
        requestedBy: userId,
        maintenance: { ...maintenance, reason: "before-send" },
        nowMs: now + 100_000,
      }),
    ).toBeNull();

    const runs = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("maintenance", "is not", null)
      .execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.maintenance).toEqual(maintenance);
    expect(
      await database.selectFrom("commands").select("id").where("runId", "=", runs[0]!.id).execute(),
    ).toHaveLength(1);
    const report = await store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: userId,
      source: { kind: "human" },
      policy: "report",
      content: [{ type: "text", text: "Pending report" }],
      idempotencyKey: "report-after-admission",
    });
    const admitted = results.find(Boolean)!;
    await store.claimCommand(admitted.command!.id, "maintenance-claim");
    const claimed = await database
      .selectFrom("threadInputs")
      .select(["state", "runId"])
      .where("messageId", "=", report.message.id)
      .executeTakeFirstOrThrow();
    expect(claimed).toMatchObject({ state: "pending", runId: null });
    const run = await database
      .selectFrom("runs")
      .select("reportContext")
      .where("id", "=", runs[0]!.id)
      .executeTakeFirstOrThrow();
    expect(run.reportContext?.messageIds).toEqual([]);
    await expect(
      store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(now + 60_000),
        continuationIdentity: {
          ...testContinuationIdentity,
          driverKind: HarnessIdSchema.parse("claude"),
        },
        harnessInstanceId: thread.harnessInstanceId,
        leaseTokenHash: "compaction-binding",
        runnerBootId: "compaction-boot",
        runnerId,
        runId: runs[0]!.id,
        threadId: thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
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
