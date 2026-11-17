import { createId } from "@opensteer/core";
import { expect, test } from "vitest";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { readTranscriptPage } from "./personal-sync-store.js";

test("an anchored read reserves its turn and can continue paging older turns", async () => {
  const fixture = await createPersonalStateFixture("anchored-page");
  const { database, run } = fixture;
  try {
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
  } finally {
    await fixture.close();
  }
});
