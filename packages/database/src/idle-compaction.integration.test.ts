import { projectThreadState } from "./thread-status.js";
import {
  compactionIsEligible,
  compactionReturnHint,
  compactionReturnHints,
} from "./compaction-eligibility.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { threadPathLinks, jsonValue } from "./store-primitives.js";
import { admitIdleCompaction } from "./idle-compaction-store.js";
import { findPersonalSettings } from "./personal-settings-store.js";
import { createId, HarnessIdSchema, ModelIdSchema } from "@opensteer/core";
import { expect, vi } from "vitest";
import {
  type StoreFixture,
  describeStore,
  pendingEvent,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  testModelSelection,
} from "./store.integration.test-support.js";

describeStore("Claude compaction persistence", (it) => {
  it("batches return hints identically for a mixed task page", async ({ storeFixture }) => {
    const { database, thread, createRunFixture } = await compactionFixture(storeFixture);
    const { thread: other } = await createRunFixture("no-context");
    const original = await database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
    const session = await database
      .selectFrom("providerSessions")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const archivedId = createId("thread");
    await database
      .insertInto("threads")
      .values({ ...original, id: archivedId, status: "archived" })
      .execute();
    await database
      .insertInto("providerSessions")
      .values({ ...session, id: createId("providerSession"), threadId: archivedId })
      .execute();
    const ids = [thread.id, other.id, archivedId];
    for (const paused of [false, true]) {
      await database
        .updateTable("threads")
        .set({ inputQueuePaused: paused })
        .where("id", "=", thread.id)
        .execute();
      const expected = await Promise.all(
        ids.map(async (id) => [id, await compactionReturnHint(database, id)] as const),
      );
      const queries = vi.spyOn(database.getExecutor(), "executeQuery");
      const hints = await compactionReturnHints(database, ids);
      expect(queries.mock.calls.length).toBe(1);
      queries.mockRestore();
      for (const [id, hint] of expected) expect(hints.get(id) ?? null).toEqual(hint);
    }
  });
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
    const { store, database, userId, thread, source, sessionId, now, runnerId } =
      await compactionFixture(storeFixture, 200_000);
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
  it("rejects stale model evidence at timer admission and clears the snapshot and hint", async ({
    storeFixture,
  }) => {
    const { store, database, thread, userId, sessionId, source, now } = await compactionFixture(
      storeFixture,
      200_000,
    );
    const changed = { ...thread.modelSelection, modelId: ModelIdSchema.parse("changed-model") };
    await store.updateThreadExecutionSelection({
      threadId: thread.id,
      requestedBy: userId,
      harnessInstanceId: thread.harnessInstanceId,
      continuationIdentity: {
        ...testContinuationIdentity,
        driverKind: HarnessIdSchema.parse("claude"),
      },
      modelSelection: changed,
      idempotencyKey: "change-model",
    });
    expect(
      await admitIdleCompaction(database, {
        threadId: thread.id,
        requestedBy: userId,
        nowMs: now,
        maintenance: {
          kind: "claude-compaction",
          reason: "idle",
          sourceRunId: source.run.id,
          providerSessionId: sessionId,
        },
      }),
    ).toBeNull();
    expect(
      (
        await database
          .selectFrom("providerSessions")
          .select("contextSnapshot")
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow()
      ).contextSnapshot,
    ).toBeNull();
    expect((await store.getThreadForOwner(thread.id, userId))?.returnHint).toBeNull();
    const events: import("@opensteer/core").AgentEvent[] = [];
    await store.drainPendingThreadStates((batch) => {
      events.push(...batch);
    });
    expect(events.find((event) => event.type === "thread.state-changed")?.data).toMatchObject({
      returnHint: null,
    });
  });
  it("rechecks source selections at execution binding even with retained evidence", async ({
    storeFixture,
  }) => {
    const { store, database, thread, userId, sessionId, source, now, runnerId } =
      await compactionFixture(storeFixture, 200_000);
    const admitted = await admitIdleCompaction(database, {
      threadId: thread.id,
      requestedBy: userId,
      nowMs: now,
      maintenance: {
        kind: "claude-compaction",
        reason: "idle",
        sourceRunId: source.run.id,
        providerSessionId: sessionId,
      },
    });
    expect(admitted).not.toBeNull();
    await store.claimCommand(admitted!.command!.id, "selection-dispatcher");
    await database
      .updateTable("threads")
      .set({
        modelSelection: jsonValue({
          ...thread.modelSelection,
          modelId: ModelIdSchema.parse("changed-model"),
        }),
      })
      .where("id", "=", thread.id)
      .execute();
    await expect(
      store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(now + 60_000),
        continuationIdentity: {
          ...testContinuationIdentity,
          driverKind: HarnessIdSchema.parse("claude"),
        },
        harnessInstanceId: thread.harnessInstanceId,
        leaseTokenHash: "selection-lease",
        runnerBootId: "selection-boot",
        runnerId,
        runId: admitted!.run!.id,
        threadId: thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("publishes authoritative activity time when maintenance changes the return hint", async ({
    storeFixture,
  }) => {
    const { database, thread, userId, sessionId, source, now } = await compactionFixture(
      storeFixture,
      200_000,
    );
    const admitted = await admitIdleCompaction(database, {
      threadId: thread.id,
      requestedBy: userId,
      nowMs: now,
      maintenance: {
        kind: "claude-compaction",
        reason: "idle",
        sourceRunId: source.run.id,
        providerSessionId: sessionId,
      },
    });
    expect(admitted).not.toBeNull();
    const before = await database
      .selectFrom("threads")
      .select("updatedAt")
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
    const events = await withPersonalTransaction(database, (tx) =>
      projectThreadState(tx, thread.id, new Date(now + 60_000), true),
    );
    expect(events[0]?.data).toMatchObject({ updatedAt: before.updatedAt.toISOString() });
    expect(
      (
        await database
          .selectFrom("threads")
          .select("updatedAt")
          .where("id", "=", thread.id)
          .executeTakeFirstOrThrow()
      ).updatedAt,
    ).toEqual(before.updatedAt);
  });
  it("orders one chosen compaction ahead of concurrent human inputs", async ({ storeFixture }) => {
    const { store, database, userId, thread } = await compactionFixture(storeFixture);
    const sends = await Promise.all(
      ["device-a", "device-b"].map((idempotencyKey) =>
        store.enqueueThreadInput({
          threadId: thread.id,
          requestedBy: userId,
          source: { kind: "human" },
          policy: "queue",
          content: [{ type: "text", text: "Continue" }],
          idempotencyKey,
          compaction: "compactFirst",
        }),
      ),
    );
    const runs = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .orderBy("runOrdinal")
      .execute();
    expect(runs.filter((run) => run.maintenance)).toHaveLength(1);
    expect(runs[1]?.maintenance?.reason).toBe("before-send");
    expect(sends.every((send) => send.disposition === "pending")).toBe(true);
  });
  it("binds a chosen compaction with its paired input and advances after failure", async ({
    storeFixture,
  }) => {
    const { store, database, userId, thread, source, runnerId } =
      await compactionFixture(storeFixture);
    const hint = await compactionReturnHint(database, thread.id);
    expect(hint).toMatchObject({ eligible: true, sourceRunId: source.run.id });
    const sent = await store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: userId,
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Continue" }],
      idempotencyKey: "p".repeat(255),
      compaction: "compactFirst",
    });
    const maintenance = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("maintenance", "is not", null)
      .executeTakeFirstOrThrow();
    expect(maintenance.maintenance?.pairedInputId).toBe(sent.message.id);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", maintenance.id)
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, "paired-dispatcher");
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        ...testContinuationIdentity,
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "paired-lease",
      runnerBootId: "paired-boot",
      runnerId,
      runId: maintenance.id,
      threadId: thread.id,
    });
    expect(
      await compactionIsEligible(
        database,
        thread.id,
        maintenance.maintenance!,
        Date.now(),
        maintenance.id,
      ),
    ).toBe(true);
    await withPersonalTransaction(database, (tx) =>
      finalizeRunTransaction(tx, {
        links: threadPathLinks,
        runId: maintenance.id,
        status: "failed",
        source: "host",
        completedAt: new Date(),
        failure: {
          status: "failed",
          code: "compaction-failed",
          message: "Unavailable",
          retryable: false,
        },
        queuedInputCancellation: "seed-input",
      }),
    );
    expect((await compactionReturnHint(database, thread.id))?.eligible).toBe(false);
    const pending = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", sent.message.id)
      .executeTakeFirstOrThrow();
    expect(pending.state).toBe("pending");
    const next = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .orderBy("runOrdinal", "desc")
      .executeTakeFirstOrThrow();
    expect(next).toMatchObject({
      seedInputId: sent.message.id,
      maintenance: null,
      status: "queued",
      providerSessionId: maintenance.providerSessionId,
    });
  });
  it("derives future return hints and publishes policy changes", async ({ storeFixture }) => {
    const { store, database, thread, userId, sessionId, source, now } =
      await compactionFixture(storeFixture);
    const session = await database
      .selectFrom("providerSessions")
      .select("contextSnapshot")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("providerSessions")
      .set({
        contextSnapshot: {
          ...session.contextSnapshot!,
          measuredAt: now,
          requestStartedAt: null,
          promptCacheTtlMs: null,
        },
      })
      .where("id", "=", sessionId)
      .execute();
    await withPersonalTransaction(database, (tx) => projectThreadState(tx, thread.id));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const eligibleAt = now + 70 * 60_000;
      vi.setSystemTime(eligibleAt - 1);
      const hint = await compactionReturnHint(database, thread.id);
      expect(hint).toMatchObject({ eligible: true, eligibleAt });
      const maintenance = {
        kind: "claude-compaction",
        reason: "before-send",
        sourceRunId: source.run.id,
        providerSessionId: sessionId,
      } as const;
      expect(await compactionIsEligible(database, thread.id, maintenance, Date.now())).toBe(false);
      vi.setSystemTime(eligibleAt);
      expect(await compactionIsEligible(database, thread.id, maintenance, Date.now())).toBe(true);
      const activity = await database
        .selectFrom("threads")
        .select("updatedAt")
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow();
      await store.notificationState.setIdleCompactionPolicy({ userId, policy: { mode: "off" } });
      const events: import("@opensteer/core").AgentEvent[] = [];
      await store.drainPendingThreadStates((batch) => {
        events.push(...batch);
      });
      expect(
        events.find(
          (event) => event.type === "thread.state-changed" && event.threadId === thread.id,
        )?.data,
      ).toMatchObject({ returnHint: { ...hint, eligible: false } });
      expect((await store.getThreadForOwner(thread.id, userId))?.returnHint?.eligible).toBe(false);
      expect(
        (
          await database
            .selectFrom("threads")
            .select("updatedAt")
            .where("id", "=", thread.id)
            .executeTakeFirstOrThrow()
        ).updatedAt,
      ).toEqual(activity.updatedAt);
    } finally {
      vi.useRealTimers();
    }
  });
  it("Stop holds the paired message and Resume runs it without another compaction", async ({
    storeFixture,
  }) => {
    const { store, database, userId, thread, runnerId, environmentId } =
      await compactionFixture(storeFixture);
    const sent = await store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: userId,
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Continue" }],
      idempotencyKey: "stop-paired",
      compaction: "compactFirst",
    });
    const maintenance = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("maintenance", "is not", null)
      .executeTakeFirstOrThrow();
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", maintenance.id)
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, "stop-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        ...testContinuationIdentity,
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "stop-lease",
      runnerBootId: "stop-boot",
      runnerId,
      runId: maintenance.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "stop-boot",
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        environmentId,
        runId: maintenance.id,
        threadId: thread.id,
        type: "run.started",
        ordinal: 0,
        data: { status: "running" },
      }),
    });
    expect(await store.getThreadForOwner(thread.id, userId)).toMatchObject({ status: "idle" });
    await store.enqueueRunnerControl({
      type: "run.interrupt",
      threadId: thread.id,
      runId: maintenance.id,
      requestedBy: userId,
      idempotencyKey: "stop",
    });
    expect((await store.getThreadForOwner(thread.id, userId))?.inputQueuePaused).toBe(true);
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", sent.message.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("pending");
    await store.commitRunnerEvent({
      environmentId,
      runnerId,
      runnerBootId: "stop-boot",
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        environmentId,
        runId: maintenance.id,
        threadId: thread.id,
        type: "run.interrupted",
        ordinal: 1,
        data: { status: "interrupted" },
      }),
    });
    await store.resumeThreadInputQueue({
      threadId: thread.id,
      requestedBy: userId,
      idempotencyKey: "resume",
    });
    const runs = await database
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", thread.id)
      .orderBy("runOrdinal")
      .execute();
    expect(runs.filter((run) => run.maintenance)).toHaveLength(1);
    expect(runs.at(-1)).toMatchObject({
      seedInputId: sent.message.id,
      maintenance: null,
      status: "queued",
    });
  });
  for (const claimed of [false, true]) {
    it(`gates old Runners and supersedes unstarted background compaction (claimed: ${claimed})`, async ({
      storeFixture,
    }) => {
      const { store, database, userId, thread, runnerId, sessionId, source, now } =
        await compactionFixture(storeFixture);
      const runner = await database
        .selectFrom("runners")
        .select("capabilities")
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("runners")
        .set({
          capabilities: jsonValue(runner.capabilities.filter((c) => c !== "claude-compaction-v1")),
        })
        .where("id", "=", runnerId)
        .execute();
      expect((await compactionReturnHint(database, thread.id))?.eligible).toBe(false);
      expect(
        await admitIdleCompaction(database, {
          threadId: thread.id,
          requestedBy: userId,
          maintenance: {
            kind: "claude-compaction",
            reason: "before-send",
            sourceRunId: source.run.id,
            providerSessionId: sessionId,
          },
        }),
      ).toBeNull();
      await database
        .updateTable("runners")
        .set({ capabilities: jsonValue(runner.capabilities) })
        .where("id", "=", runnerId)
        .execute();
      const background = await admitIdleCompaction(database, {
        threadId: thread.id,
        requestedBy: userId,
        nowMs: now - 200_000,
        maintenance: {
          kind: "claude-compaction",
          reason: "idle",
          sourceRunId: source.run.id,
          providerSessionId: sessionId,
        },
      });
      expect(background?.run).toBeTruthy();
      if (claimed) await store.claimCommand(background!.command!.id, "background-unbound");
      await store.enqueueThreadInput({
        threadId: thread.id,
        requestedBy: userId,
        source: { kind: "human" },
        policy: "queue",
        content: [{ type: "text", text: "Continue" }],
        idempotencyKey: "supersede",
      });
      expect(
        (
          await database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", background!.run!.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("interrupted");
    });
  }
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

async function compactionFixture(storeFixture: StoreFixture, staleMs = 400_000) {
  const { store, database, createRunFixture, enqueueHumanTrigger } = storeFixture;
  const { userId, environmentId, runnerId } = await createRunFixture("compaction-send");
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
        requestStartedAt: now - staleMs,
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
  return { ...storeFixture, userId, thread, source, sessionId, runnerId, environmentId, now };
}
