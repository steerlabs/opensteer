import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

describeStore("personal computer attention", (it) => {
  it("counts all pending Requests and finds unread published results outside the task page without mutation locks", async ({
    storeFixture: f,
  }) => {
    const task = await f.startRunFixture("attention-result");
    const attention = () => f.store.notificationState.attention(task.userId);
    expect(await attention()).toEqual({ needsYou: 0, unread: false });
    for (let i = 0; i < 3; i++) {
      await f.store.requests.create({
        callId: `attention-request-${i}`,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: task.run.id,
        originatingThreadId: task.thread.id,
        requestedBy: task.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Read a source",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: { kind: "task", id: task.thread.id },
        },
      });
    }
    await f.store.commitRunnerEvent({
      environmentId: task.environmentId,
      runnerId: task.runnerId,
      runnerBootId: task.runnerBootId,
      event: pendingEvent({
        type: "assistant.message",
        environmentId: task.environmentId,
        threadId: task.thread.id,
        runId: task.run.id,
        bindingGeneration: task.bindingGeneration,
        ordinal: 1,
        data: { messageId: createId("message"), content: [{ type: "text", text: "Result ready" }] },
      }),
    });
    await f.store.commitRunnerEvent({
      environmentId: task.environmentId,
      runnerId: task.runnerId,
      runnerBootId: task.runnerBootId,
      event: pendingEvent({
        type: "run.completed",
        environmentId: task.environmentId,
        threadId: task.thread.id,
        runId: task.run.id,
        bindingGeneration: task.bindingGeneration,
        ordinal: 2,
        data: { status: "completed" },
      }),
    });
    await f.store.createThread({
      createdBy: task.userId,
      environmentId: task.environmentId,
      harnessInstanceId: task.harnessInstance.id,
      modelSelection: task.thread.modelSelection,
      title: "Newest task",
      idempotencyKey: "newest-task",
    });
    const page = await f.store.ownerThreadPageForOwner({ ownerId: task.userId, maxItems: 1 });
    expect(page.threads.map((thread) => thread.id)).not.toContain(task.thread.id);
    await f.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        await sql`set transaction read only`.execute(tx);
        const { NotificationStateStore } = await import("./notification-state.js");
        expect(await new NotificationStateStore(tx).attention(task.userId)).toEqual({
          needsYou: 3,
          unread: true,
        });
      });
    const completed = await f.database
      .selectFrom("runs")
      .select("completedAt")
      .where("id", "=", task.run.id)
      .executeTakeFirstOrThrow();
    await f.store.notificationState.visit({
      threadId: task.thread.id,
      userId: task.userId,
      visitedAt: completed.completedAt!.toISOString(),
    });
    expect(await attention()).toEqual({ needsYou: 3, unread: false });
    const stranger = await f.store.createUser("Other person");
    await expect(f.store.notificationState.attention(stranger)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
