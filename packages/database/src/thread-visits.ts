import { sql, type RawBuilder } from "kysely";

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
