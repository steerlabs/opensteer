import { createId } from "@opensteer/core";
import { expect, test } from "vitest";
import { createStoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";

test("an anchored read reserves its turn and can continue paging older turns", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("anchored-page");
    await database
      .updateTable("transcriptItems")
      .set({ visible: false, isTurnStart: false })
      .where("threadId", "=", run.threadId)
      .execute();
    const message = await database
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", run.threadId)
      .limit(1)
      .executeTakeFirstOrThrow();
    const ids = Array.from({ length: 22 }, () => createId("message"));
    await database
      .insertInto("messages")
      .values(
        ids.map((id, index) => ({
          ...message,
          content: jsonValue(message.content),
          id,
          sequence: String(index + 20),
        })),
      )
      .execute();
    await database
      .insertInto("transcriptItems")
      .values(
        ids.map((id, index) => ({
          id,
          messageId: id,
          threadId: run.threadId,
          runId: run.runId,
          attemptId: null,
          nodeId: null,
          position: String(index + 1),
          kind: "message" as const,
          visible: true,
          isTurnStart: true,
          createdAt: message.createdAt,
          view: { preview: "Turn" },
        })),
      )
      .execute();
    const query = {
      viewerId: run.userId,
      scope: { kind: "thread" as const, threadId: run.threadId },
    };
    const anchorItemId = ids[1]!;
    const page = await readTranscriptPage(database, {
      ...query,
      anchorItemId,
      maxTurns: 10,
      limit: 50,
    });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") throw new Error("The anchor must have a page");
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(1, 11));
    expect(page.nextBefore?.beforeId).toBe(anchorItemId);
    const older = await readTranscriptPage(database, { ...query, cursor: page.nextBefore! });
    expect(older).toMatchObject({ kind: "page", items: [{ id: ids[0] }], hasMore: false });
    const newer = await readTranscriptPage(database, { ...query, after: page.nextAfter! });
    expect(newer).toMatchObject({
      kind: "page",
      items: ids.slice(11).map((id) => expect.objectContaining({ id })),
      nextAfter: null,
    });
    await database
      .updateTable("transcriptItems")
      .set({ view: { preview: "x".repeat(1024) } })
      .where("threadId", "=", run.threadId)
      .execute();
    const bytePage = await readTranscriptPage(database, { ...query, limit: 20, maxBytes: 8192 });
    if (bytePage.kind !== "page" || !bytePage.nextBefore)
      throw new Error("Expected a trimmed page");
    expect(bytePage.items.length).toBeGreaterThan(0);
    expect(bytePage.items.length).toBeLessThan(20);
    expect(Buffer.byteLength(JSON.stringify(bytePage))).toBeLessThanOrEqual(8192);
    expect(bytePage.nextBefore.beforeId).toBe(bytePage.items[0]?.id);
    const byteOlder = await readTranscriptPage(database, { ...query, cursor: bytePage.nextBefore });
    if (byteOlder.kind !== "page") throw new Error("Expected an older page");
    expect([...byteOlder.items, ...bytePage.items].map(({ id }) => id)).toEqual(ids);
    await database
      .updateTable("transcriptItems")
      .set({ revision: "9" })
      .where("id", "=", anchorItemId)
      .execute();
    expect(
      await readTranscriptItem(database, { ...query, itemId: anchorItemId, expectedRevision: "8" }),
    ).toEqual({ kind: "revision-conflict", revision: "9" });
    await database
      .updateTable("messages")
      .set({ content: jsonValue([{ type: "text", text: "x".repeat(1_100_000) }] as const) })
      .where("id", "=", anchorItemId)
      .execute();
    expect(await readTranscriptItem(database, { ...query, itemId: anchorItemId })).toMatchObject({
      kind: "item",
      body: null,
      truncated: true,
      item: { id: anchorItemId },
    });
  } finally {
    await fixture.close();
  }
});
