import type { RunId, ThreadId, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * What a task's context lineage says about whose it is: whether it may carry
 * the person's personal context, whether a chat is anywhere in it, and whether
 * it is the person's own lineage. A chat the person alone speaks in keeps
 * personal context, and is still a chat.
 */
export interface ThreadContextLineage {
  readonly personalContext: boolean;
  readonly fromChat: boolean;
  /**
   * Only the person ever wrote into the task and the tasks it descends from:
   * no chat and no connected agent (its own task, a message it sent, or a
   * message from a Run that was not the person's). A memory pass is driven by
   * Opensteer's own fixed script for the person like any automation of theirs,
   * so it stays the person's own. Lineage narrows and never widens back: once
   * a connected agent or a chat has written into a task, that task is not the
   * person's own again.
   */
  readonly personLineage: boolean;
}

/** Re-evaluate every sender represented in this task, including later admitted batches. */
export async function runAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  return (await runContextLineage(database, runId)).personalContext;
}

export async function runContextLineage(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<ThreadContextLineage> {
  const run = await database
    .selectFrom("runs")
    .select(["threadId", "requestedBy", "connectionId"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return queryContextLineage(database, run.threadId, run.connectionId);
}

export async function threadAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
): Promise<boolean> {
  return (await threadContextLineage(database, threadId, ownerId)).personalContext;
}

export async function threadContextLineage(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  _ownerId: UserId,
): Promise<ThreadContextLineage> {
  return queryContextLineage(database, threadId, null);
}

async function queryContextLineage(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  runConnectionId: string | null,
): Promise<ThreadContextLineage> {
  // Reused workers retain every assigning conversation's context restriction, a task linked
  // under another (an automation's own task) retains its parent's, and work an automation's
  // program sends anywhere retains its anchor's. Chats are connections in `agent_connections`
  // with `bridge_senders` set ('me' keeps personal context, 'anyone' drops it; both are chats
  // and neither is the person's own lineage).
  const result = await sql<{
    total: number;
    chatCount: number;
    nonPersonalCount: number;
  }>`
    with recursive context_threads(id) as (
      select ${threadId}::text
      union
      select parent.id from context_threads current
      cross join lateral (
        select source_run.thread_id as id
        from thread_inputs input
        join runs source_run on source_run.id = input.authority_source->>'runId'
        where input.thread_id = current.id and input.state <> 'cancelled'
          and input.authority_source->>'kind' = 'thread-agent'
        union
        select trigger.anchor_thread_id as id
        from thread_inputs input
        join trigger_occurrences occurrence
          on occurrence.id = input.authority_source->>'occurrenceId'
        join triggers trigger on trigger.id = occurrence.trigger_id
        where input.thread_id = current.id and input.state <> 'cancelled'
          and input.authority_source->>'kind' = 'trigger-occurrence'
        union
        select trigger.anchor_thread_id as id
        from thread_inputs input
        join triggers trigger on trigger.id = input.authority_source->>'triggerId'
        where input.thread_id = current.id and input.state <> 'cancelled'
          and input.authority_source->>'kind' = 'watch-observation'
        union
        select parent_thread_id as id from delegations where child_thread_id = current.id
        union
        select parent_thread_id as id from threads
        where id = current.id and parent_thread_id is not null
      ) parent
    ),
    touched_connections(connection_id) as (
      select thread.origin_connection_id
      from context_threads
      join threads thread on thread.id = context_threads.id
      where thread.origin_connection_id is not null
      union
      select written.connection_id
      from context_threads
      join thread_inputs written on written.thread_id = context_threads.id
      where written.state <> 'cancelled' and written.connection_id is not null
      union
      select ${runConnectionId}::text
      where ${runConnectionId}::text is not null
    )
    select
      count(*)::int as total,
      count(*) filter (where conn.bridge_senders is not null)::int as chat_count,
      count(*) filter (where conn.id is null or conn.bridge_senders = 'anyone')::int
        as non_personal_count
    from touched_connections tc
    left join agent_connections conn on conn.id = tc.connection_id
  `.execute(database);
  const row = result.rows[0];
  const total = row?.total ?? 0;
  const chatCount = row?.chatCount ?? 0;
  const nonPersonalCount = row?.nonPersonalCount ?? 0;
  return {
    fromChat: chatCount > 0,
    personLineage: total === 0,
    personalContext: nonPersonalCount === 0,
  };
}
