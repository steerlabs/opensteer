import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { describeStore } from "./store.integration.test-support.js";
import { OpensteerStore } from "./store.js";

const sessionId = createId("authSession");
describeStore("waiting input edits", (it) => {
  it("appends original and edited revisions, preserves enqueue identity, and replays before eligibility", async ({
    storeFixture: f,
  }) => {
    const task = await f.startRunFixture("Waiting edit");
    const sent = await f.store.enqueueThreadInput({
      threadId: task.threadId,
      requestedBy: task.userId,
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "waiting-original",
      content: [{ type: "text", text: "Original" }],
    });
    const identity = {
      threadId: task.threadId,
      messageId: sent.message.id,
      requestedBy: task.userId,
      sessionId,
      deviceLabel: "Phone",
    };
    const before = await f.database
      .selectFrom("threadInputs")
      .select("requestFingerprint")
      .where("messageId", "=", sent.message.id)
      .executeTakeFirstOrThrow();
    await f.store.takeThreadInputLease({ ...identity, leaseId: "old-lease", takeOver: false });
    const other = { ...identity, sessionId: createId("authSession"), deviceLabel: "Desktop" };
    await f.store.takeThreadInputLease({ ...other, leaseId: "replacement", takeOver: true });
    await expect(
      f.store.renewThreadInputLease({ ...identity, leaseId: "old-lease" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.store.releaseThreadInputLease({ ...identity, leaseId: "old-lease" });
    expect((await f.store.getThreadInputQueue(identity)).items[0]?.lease?.leaseId).toBe(
      "replacement",
    );
    await f.store.releaseThreadInputLease(identity);
    await f.store.takeThreadInputLease({ ...identity, leaseId: "edit-1", takeOver: false });
    await expect(
      f.store.editThreadInput({
        ...identity,
        leaseId: "edit-1",
        expectedRevision: 0,
        idempotencyKey: "add-attachment",
        content: [
          { type: "artifact", artifactId: "new", name: "new.txt", mediaType: "text/plain" },
        ],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const edit = {
      ...identity,
      leaseId: "edit-1",
      expectedRevision: 0,
      idempotencyKey: "save-1",
      content: [{ type: "text", text: "Edited" }],
    };
    const saved = await f.store.editThreadInput(edit);
    expect(saved.edit.revision).toBe(1);
    expect(saved.events.map((event) => event.type)).toEqual([
      "message.updated",
      "thread-input.lease-changed",
    ]);
    await f.store.cancelThreadInput({
      threadId: task.threadId,
      messageId: sent.message.id,
      requestedBy: task.userId,
      idempotencyKey: "cancel-edited",
    });
    expect(await f.store.editThreadInput(edit)).toMatchObject({
      message: saved.message,
      edit: saved.edit,
      events: [],
    });
    await expect(
      f.store.editThreadInput({ ...edit, content: [{ type: "text", text: "Different" }] }),
    ).rejects.toMatchObject({ code: "conflict" });
    const history = await f.store.listMessageRevisions(identity);
    expect(await f.store.listMessageRevisions({ ...identity, before: 1 })).toMatchObject({
      hasMore: false,
      revisions: [{ revision: 0 }],
    });
    expect(
      history.revisions.map((item) => [item.revision, item.content, item.deviceLabel]),
    ).toEqual([
      [1, [{ type: "text", text: "Edited" }], "Phone"],
      [0, [{ type: "text", text: "Original" }], null],
    ]);
    expect(
      await f.database
        .selectFrom("threadInputs")
        .select("requestFingerprint")
        .where("messageId", "=", sent.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it("blocks the queue at a held head and resumes it on execution-clock expiry", async ({
    storeFixture: f,
  }) => {
    const task = await f.createRunFixture("Lease barrier");
    const clock = new ManualClock(Date.now());
    const store = new OpensteerStore(f.database, { executionClock: clock });
    await f.database
      .updateTable("threads")
      .set({ inputQueuePaused: true })
      .where("id", "=", task.threadId)
      .execute();
    const send = (key: string) =>
      store.enqueueThreadInput({
        threadId: task.threadId,
        requestedBy: task.userId,
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
        content: [{ type: "text", text: key }],
      });
    const head = await send("head");
    const tail = await send("tail");
    const identity = {
      threadId: task.threadId,
      messageId: head.message.id,
      requestedBy: task.userId,
      sessionId,
      deviceLabel: "Phone",
    };
    await store.takeThreadInputLease({ ...identity, leaseId: "head-lease", takeOver: false });
    await store.resumeThreadInputQueue({
      threadId: task.threadId,
      requestedBy: task.userId,
      idempotencyKey: "resume-held",
    });
    expect(
      await f.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", task.threadId)
        .execute(),
    ).toEqual([]);
    await store.recoverThreadWorkQueues();
    expect(
      await f.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", task.threadId)
        .execute(),
    ).toEqual([]);
    await expect(
      store.takeThreadInputLease({
        ...identity,
        sessionId: createId("authSession"),
        leaseId: "other",
        takeOver: false,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    clock.advanceBy(120_000);
    const expired = await store.expireThreadInputLeases();
    expect(expired.events.map((event) => event.type)).toContain("run.queued");
    expect(
      await f.database
        .selectFrom("runs")
        .select("seedInputId")
        .where("threadId", "=", task.threadId)
        .execute(),
    ).toEqual([{ seedInputId: head.message.id }]);
    expect(
      (
        await store.getThreadInputQueue({ threadId: task.threadId, requestedBy: task.userId })
      ).items.map((item) => item.message.id),
    ).toEqual([tail.message.id]);
    await expect(
      store.renewThreadInputLease({ ...identity, leaseId: "head-lease" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
