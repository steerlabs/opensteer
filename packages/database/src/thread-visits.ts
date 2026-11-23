import { OpensteerError, type ThreadId, type ThreadVisit, type UserId } from "@opensteer/core";
import { commitPersonalMutation } from "./personal-mutation.js";
import { unreadTaskContribution } from "./personal-attention-store.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { executionDate } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { sql, type RawBuilder, type Kysely } from "kysely";

export function threadUnreadPredicate(
  completedAt: RawBuilder<Date | null>,
  visitedAt: RawBuilder<Date | null>,
): RawBuilder<boolean> {
  return sql<boolean>`(${completedAt} is not null and (${visitedAt} is null or ${completedAt} > ${visitedAt}))`;
}

export function latestRunCompletion(threadId: RawBuilder<string>): RawBuilder<Date | null> {
  return sql<Date | null>`(select case when status in ('completed', 'failed', 'interrupted') then completed_at end
    from runs where thread_id = ${threadId} and maintenance is null order by run_ordinal desc limit 1)`;
}

export function recordThreadVisit(
  database: Kysely<DatabaseSchema>,
  input: { readonly threadId: ThreadId; readonly visitedAt: string; readonly userId: UserId },
): Promise<ThreadVisit> {
  return commitPersonalMutation(database, async (tx, mutation) => {
    await requirePersonalOwner(tx, input.userId);
    const thread = await tx
      .selectFrom("threads")
      .select("id")
      .where("id", "=", input.threadId)
      .where("removedAt", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (!thread) throw new OpensteerError({ code: "not_found", message: "Task not found" });
    const before = await unreadTaskContribution(tx, thread.id);
    const now = executionDate(tx);
    const visitedAt = new Date(Math.min(Date.parse(input.visitedAt), now.getTime()));
    const newVisit = await tx
      .insertInto("threadVisits")
      .values({
        userId: input.userId,
        threadId: thread.id,
        lastVisitedAt: visitedAt,
        updatedAt: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["threadId", "userId"])
          .doUpdateSet({ lastVisitedAt: visitedAt, updatedAt: now })
          .where("threadVisits.lastVisitedAt", "<", visitedAt),
      )
      .returning(["threadId", "lastVisitedAt"])
      .executeTakeFirst();
    const visit =
      newVisit ??
      (await tx
        .selectFrom("threadVisits")
        .select(["threadId", "lastVisitedAt"])
        .where("threadId", "=", thread.id)
        .where("userId", "=", input.userId)
        .executeTakeFirstOrThrow());
    const result = { threadId: visit.threadId, lastVisitedAt: visit.lastVisitedAt.toISOString() };
    if (newVisit) {
      mutation.count("unreadTaskCount", (await unreadTaskContribution(tx, thread.id)) - before);
      mutation.change(
        { scopeKey: "shell", entityKind: "visit", entityId: thread.id, operation: "upsert" },
        () => ({ ...result, revision: mutation.sequence }),
      );
    }
    return result;
  });
}
