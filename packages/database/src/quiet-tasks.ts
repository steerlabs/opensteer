import { nonTerminalRunStatuses, type ThreadId, type UserId } from "@opensteer/core";
import { sql, type Kysely, type RawBuilder } from "kysely";
import { publishedMessagePredicate } from "./message-visibility.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * A task the Host may move to Done for its creator: finished, read, holding
 * no work and asking nothing, untouched for as many days as its creator chose.
 * Touched means the Host last changed it (a reply, a rename, a reopen) or its
 * creator last read it, so a task never moves while someone is looking at it.
 * Reads `thread`, its creator as `person` and their read marker as `marker`.
 */
function quietTask(now: Date): RawBuilder<boolean> {
  return sql<boolean>`thread.purpose = 'task' and thread.listed and thread.done_at is null
    and thread.status = 'idle' and not thread.input_queue_paused
    and person.disabled_at is null and settings.quiet_task_days > 0
    and greatest(thread.updated_at, marker.updated_at)
      <= ${now}::timestamptz - make_interval(days => settings.quiet_task_days)
    and not exists (
      select 1 from triggers where anchor_thread_id = thread.id and status in ('active', 'paused'))
    and not exists (
      select 1 from runs where thread_id = thread.id
        and status in (${sql.join(nonTerminalRunStatuses.map((status) => sql`${status}`))}))
    and not exists (
      select 1 from thread_inputs where thread_id = thread.id
        and state in ('pending', 'claimed', 'unknown') and policy <> 'report')
    and not exists (
      select 1 from delegations where status = 'open'
        and (child_thread_id = thread.id or parent_thread_id = thread.id))
    and not exists (
      select 1 from requests where originating_thread_id = thread.id and status = 'pending')
    and not exists (
      select 1 from messages message
      left join thread_inputs inbox on inbox.message_id = message.id
      where message.thread_id = thread.id
        and message.sequence > coalesce(marker.sequence, -1)
        and message.kind in ('input', 'assistant', 'run-result')
        and ${publishedMessagePredicate("inbox")}
        and (message.author->>'kind' <> 'human'
          or coalesce(message.author->>'userId', inbox.requested_by) is distinct from thread.created_by))`;
}
const quietTaskSource = sql`threads thread
  join personal_settings settings on settings.owner_id = thread.created_by
  join users person on person.id = settings.owner_id
  left join thread_read_markers marker
    on marker.thread_id = thread.id and marker.user_id = thread.created_by`;
export interface QuietTaskCandidate {
  readonly threadId: ThreadId;
  readonly createdBy: UserId;
  /** When it was last changed, which names this quiet spell: a later touch starts another. */
  readonly updatedAt: Date;
}

/** Quiet tasks after `after`, by id. Unlocked: `setThreadDone` checks again under its locks. */
export async function listQuietTasks(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly now: Date;
    readonly after?: ThreadId;
    readonly limit: number;
  },
): Promise<readonly QuietTaskCandidate[]> {
  const rows = await sql<QuietTaskCandidate>`
    select thread.id as thread_id, thread.created_by, thread.updated_at
    from ${quietTaskSource}
    where ${quietTask(input.now)}
      -- The shortest choice, so the planner can range-scan threads_quiet_candidates.
      and thread.updated_at <= ${input.now}::timestamptz - interval '1 day'
      ${input.after ? sql`and thread.id > ${input.after}` : sql``}
    order by thread.id
    limit ${input.limit}
  `.execute(database);
  return rows.rows;
}
export async function threadIsQuiet(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  now: Date,
): Promise<boolean> {
  const row = await sql<{
    quiet: boolean;
  }>`
    select ${quietTask(now)} as quiet from ${quietTaskSource} where thread.id = ${threadId}
  `.execute(database);
  return row.rows[0]?.quiet === true;
}
