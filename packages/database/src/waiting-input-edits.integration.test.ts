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
    // Other devices learn queue values from the feed, written in the same commit as the card.
    const published = () =>
      f.database
        .selectFrom("clientChanges")
        .select("payload")
        .where("entityKind", "=", "queue-entry")
        .where("entityId", "=", sent.message.id)
        .where("operation", "=", "upsert")
        .orderBy("sequence", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
    expect((await published()).payload).toMatchObject({
      message: { preview: "Original", revision: 0 },
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
    const queue = await f.store.getThreadInputQueue(identity);
    expect(queue.items[0]?.lease).toEqual({
      deviceLabel: "Desktop",
      expiresAt: expect.any(String),
      ownedBySession: false,
    });
    expect((await f.store.getThreadInputQueue(other)).items[0]?.lease).toEqual({
      deviceLabel: "Desktop",
      expiresAt: expect.any(String),
      ownedBySession: true,
    });
    await expect(
      f.store.renewThreadInputLease({ ...other, leaseId: "replacement" }),
    ).resolves.toMatchObject({
      lease: { leaseId: "replacement" },
    });
    const renewed = await f.store.getThreadInputQueue(identity);
    expect(BigInt(renewed.revision)).toBeGreaterThan(BigInt(queue.revision));
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
    const afterEdit = await f.store.getThreadInputQueue(identity);
    expect(BigInt(afterEdit.revision)).toBeGreaterThan(BigInt(renewed.revision));
    expect(afterEdit.items[0]).toMatchObject({
      message: { id: sent.message.id, preview: "Edited", revision: 1 },
      lease: null,
    });
    expect((await published()).payload).toMatchObject({
      message: { preview: "Edited", revision: 1 },
    });
    const retained = await f.database
      .selectFrom("transcriptItems")
      .select(["visible", "position", "view"])
      .where("id", "=", sent.message.id)
      .executeTakeFirstOrThrow();
    expect(retained).toMatchObject({
      visible: false,
      position: null,
      view: { edited: true, published: false },
    });
    await f.store.cancelThreadInput({
      threadId: task.threadId,
      messageId: sent.message.id,
      requestedBy: task.userId,
      idempotencyKey: "cancel-edited",
    });
    const readHead = () =>
      f.database.selectFrom("clientSyncState").select("sequence").executeTakeFirstOrThrow();
    const head = await readHead();
    expect(await f.store.editThreadInput(edit)).toEqual({
      message: saved.message,
      edit: saved.edit,
      revokedGrants: [],
    });
    expect(await readHead()).toEqual(head);
    await expect(
      f.store.editThreadInput({ ...edit, content: [{ type: "text", text: "Different" }] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(f.store.listMessageRevisions(identity)).rejects.toMatchObject({
      code: "not_found",
    });
    const revisions = await f.database
      .selectFrom("messageRevisions")
      .select(["revision", "content", "deviceLabel"])
      .where("messageId", "=", sent.message.id)
      .orderBy("revision", "desc")
      .execute();
    expect(revisions.map((item) => [item.revision, item.content, item.deviceLabel])).toEqual([
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
    await store.expireThreadInputLeases();
    expect(
      await f.database
        .selectFrom("threadInputs")
        .select("editLeaseId")
        .where("messageId", "=", head.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ editLeaseId: null });
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
