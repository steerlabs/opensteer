import { expect, test } from "vitest";
import { refreshLatestRunCompletion } from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";

test("clearing an already-read completion stamps a head even when the unread count stays zero", async () => {
  const fixture = await createPersonalStateFixture("read-completion-cleared");
  const { database, run } = fixture;
  try {
    const prior = new Date("2000-01-01");
    await database
      .updateTable("threads")
      .set({ latestRunCompletedAt: prior })
      .where("id", "=", run.threadId)
      .execute();
    await database
      .insertInto("threadVisits")
      .values({
        threadId: run.threadId,
        userId: run.userId,
        lastVisitedAt: new Date("2000-01-02"),
        updatedAt: new Date(),
      })
      .execute();
    await commitPersonalMutation(database, (tx, mutation) =>
      refreshLatestRunCompletion(tx, mutation, run.threadId, 0),
    );
    const head = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "unreadTaskCount"])
      .executeTakeFirstOrThrow();
    const thread = await database
      .selectFrom("threads")
      .select(["revision", "latestRunCompletedAt"])
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    expect(head.unreadTaskCount).toBe(0);
    expect(thread).toEqual({ revision: head.sequence, latestRunCompletedAt: null });
    expect(
      await database
        .selectFrom("clientChanges")
        .select("scopeKey")
        .where("sequence", "=", head.sequence)
        .orderBy("scopeKey")
        .execute(),
    ).toEqual([{ scopeKey: "shell" }, { scopeKey: `thread:${run.threadId}` }]);
  } finally {
    await fixture.close();
  }
});
