import { createId } from "@opensteer/core";
import { NotificationStore } from "./notification-store.js";
import { expect } from "vitest";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

describeStore("thread visits", (it) => {
  it("keeps concurrent visits monotonic, clamps the future and rejects anyone except the owner", async ({
    storeFixture: f,
  }) => {
    const task = await f.startRunFixture("visit-owner");
    const visit = (visitedAt: string) =>
      f.store.notificationState.visit({ threadId: task.thread.id, userId: task.userId, visitedAt });
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
      f.store.notificationState.visit({
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
      const lower = Date.now();
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
      expect(Date.parse(thread.latestRunCompletedAt!)).toBeLessThanOrEqual(Date.now());
      expect((await f.store.notificationState.attention(task.userId)).unread).toBe(true);
      await f.store.notificationState.visit({
        threadId: thread.id,
        userId: task.userId,
        visitedAt: thread.latestRunCompletedAt!,
      });
      expect((await f.store.notificationState.attention(task.userId)).unread).toBe(false);
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
      expect((await f.store.notificationState.attention(task.userId)).unread).toBe(false);
    },
  );
  it("uses Host publication time for replies and push even when the Runner clock is wrong", async ({
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
    const accepted = await commit();
    expect(Date.parse(accepted.event.createdAt)).toBeLessThanOrEqual(Date.now());
    expect((await commit()).wasDuplicate).toBe(true);
    const message = await f.database
      .selectFrom("messages")
      .select("createdAt")
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    const completed = await f.store.commitRunnerEvent({
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
    const notifications = new NotificationStore(f.database);
    const replies = await notifications.decide(completed.event);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.view.occurredAt).toBe(message.createdAt.toISOString());
    await f.store.notificationState.visit({
      threadId: task.thread.id,
      userId: task.userId,
      visitedAt: message.createdAt.toISOString(),
    });
    expect(await notifications.decide(completed.event)).toEqual([]);
  });
});
