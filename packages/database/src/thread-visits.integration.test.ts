import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

describeStore("thread visits", (it) => {
  const databaseTime = async (db: Parameters<typeof count>[0]) =>
    (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)).rows[0]!.now.getTime();

  const count = async (db: import("kysely").Kysely<import("./schema.js").DatabaseSchema>) =>
    (await db.selectFrom("clientSyncState").select("unreadTaskCount").executeTakeFirstOrThrow())
      .unreadTaskCount;

  it("keeps concurrent visits monotonic, clamps the future and rejects anyone except the owner", async ({
    storeFixture: f,
  }) => {
    const task = await f.startRunFixture("visit-owner");
    const visit = (visitedAt: string) =>
      f.store.recordThreadVisit({ threadId: task.thread.id, userId: task.userId, visitedAt });
    const before = await f.store.getThreadForOwner(task.thread.id, task.userId);
    await Promise.all([visit("2026-01-02T00:00:00.000Z"), visit("2026-01-01T00:00:00.000Z")]);
    expect((await f.store.getThreadForOwner(task.thread.id, task.userId))?.lastVisitedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    const lower = Date.now();
    const future = await visit("2099-01-01T00:00:00.000Z");
    expect(Date.parse(future.lastVisitedAt)).toBeGreaterThanOrEqual(lower);
    expect(Date.parse(future.lastVisitedAt)).toBeLessThanOrEqual(Date.now());
    const after = await f.store.getThreadForOwner(task.thread.id, task.userId);
    expect(after).toMatchObject({
      updatedAt: before!.updatedAt,
      doneAt: before!.doneAt,
      status: before!.status,
      askedAt: before!.askedAt,
    });
    await expect(
      f.store.recordThreadVisit({
        threadId: task.thread.id,
        userId: createId("user"),
        visitedAt: future.lastVisitedAt,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await f.store.notificationState.visitPage({ userId: task.userId, limit: 1 })).visits,
    ).toEqual([future]);
  });
  it.for(["completed", "failed", "interrupted"] as const)(
    "makes an empty $0 completion readable, with Host time and a newer active run hiding it",
    async (status, { storeFixture: f }) => {
      const task = await f.startRunFixture(`visit-${status}`);
      const lower = await databaseTime(f.database);
      const common = {
        environmentId: task.environmentId,
        threadId: task.thread.id,
        runId: task.run.id,
        bindingGeneration: task.bindingGeneration,
        ordinal: 1,
        emittedAt: "2099-01-01T00:00:00.000Z",
      };
      const event =
        status === "completed"
          ? pendingEvent({ ...common, type: "run.completed", data: { status: "completed" } })
          : status === "failed"
            ? pendingEvent({
                ...common,
                type: "run.failed",
                data: { code: "failed", message: "Failed", retryable: false, status: "failed" },
              })
            : pendingEvent({ ...common, type: "run.interrupted", data: { status: "interrupted" } });
      await f.store.commitRunnerEvent({
        environmentId: task.environmentId,
        runnerId: task.runnerId,
        runnerBootId: task.runnerBootId,
        event: { ...event, emittedAt: "2099-01-01T00:00:00.000Z" },
      });
      const thread = (await f.store.getThreadForOwner(task.thread.id, task.userId))!;
      expect(Date.parse(thread.latestRunCompletedAt!)).toBeGreaterThanOrEqual(lower);
      expect(Date.parse(thread.latestRunCompletedAt!)).toBeLessThanOrEqual(
        await databaseTime(f.database),
      );
      expect(await count(f.database)).toBe(1);
      await f.store.recordThreadVisit({
        threadId: thread.id,
        userId: task.userId,
        visitedAt: thread.latestRunCompletedAt!,
      });
      expect(await count(f.database)).toBe(0);
      await f.store.enqueueThreadInput({
        threadId: thread.id,
        requestedBy: task.userId,
        content: [{ type: "text", text: "Again" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: `visit-again-${status}`,
      });
      expect(
        (await f.store.getThreadForOwner(thread.id, task.userId))?.latestRunCompletedAt,
      ).toBeNull();
      expect(await count(f.database)).toBe(0);
    },
  );
  it("uses Host time for reply publication and completion even when the Runner clock is wrong", async ({
    storeFixture: f,
  }) => {
    const task = await f.startRunFixture("visit-clock");
    const messageId = createId("message");
    const common = {
      environmentId: task.environmentId,
      threadId: task.thread.id,
      runId: task.run.id,
      bindingGeneration: task.bindingGeneration,
    };
    const event = {
      ...pendingEvent({
        ...common,
        type: "assistant.message",
        ordinal: 1,
        data: { messageId, content: [{ type: "text", text: "Ready" }] },
      }),
      emittedAt: "2099-01-01T00:00:00.000Z",
    };
    const commit = () =>
      f.store.commitRunnerEvent({
        environmentId: task.environmentId,
        runnerId: task.runnerId,
        runnerBootId: task.runnerBootId,
        event,
      });
    expect((await commit()).replayed).toBe(false);
    expect((await commit()).replayed).toBe(true);
    const message = await f.database
      .selectFrom("messages")
      .select("createdAt")
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    expect(message.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    const beforeFinish = await databaseTime(f.database);
    await f.store.commitRunnerEvent({
      environmentId: task.environmentId,
      runnerId: task.runnerId,
      runnerBootId: task.runnerBootId,
      event: {
        ...pendingEvent({
          ...common,
          type: "run.completed",
          ordinal: 2,
          data: { status: "completed" },
        }),
        emittedAt: "2001-01-01T00:00:00.000Z",
      },
    });
    const run = await f.database
      .selectFrom("runs")
      .select(["completedAt", "terminalReplyMessageId"])
      .where("id", "=", task.run.id)
      .executeTakeFirstOrThrow();
    expect(run.terminalReplyMessageId).toBe(messageId);
    expect(run.completedAt!.getTime()).toBeGreaterThanOrEqual(beforeFinish);
    expect(run.completedAt!.getTime()).toBeLessThanOrEqual(await databaseTime(f.database));
  });
});
