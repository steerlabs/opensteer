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
  const lineage = await threadContextLineage(database, run.threadId, run.requestedBy);
  if (run.connectionId === null) return lineage;
  const runConnection = await database
    .selectFrom("agentConnections")
    .select("bridgeSenders")
    .where("id", "=", run.connectionId)
    .executeTakeFirst();
  return {
    fromChat:
      lineage.fromChat || (runConnection !== undefined && runConnection.bridgeSenders !== null),
    personLineage: false,
    personalContext:
      lineage.personalContext &&
      runConnection !== undefined &&
      runConnection.bridgeSenders !== "anyone",
  };
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
  // Reused workers retain every assigning task's context restriction, a task linked under another
  // (an automation's own task) retains its parent's, and work an automation's program sends
  // anywhere retains its anchor's. Every chat and connected agent is an `agent_connections` row:
  // a chat has `bridge_senders` ('owner' keeps personal context, 'anyone' drops it), while an
  // MCP connected agent has `bridge_senders is null` (keeps personal context, not personLineage).
  const { rows } = await sql<{
    connectionCount: number;
    fromChat: boolean;
    personalContext: boolean;
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
    touched(connection_id) as (
      select thread.origin_connection_id
      from context_threads
      join threads thread on thread.id = context_threads.id
      where thread.origin_connection_id is not null
      union
      select written.connection_id
      from context_threads
      join thread_inputs written on written.thread_id = context_threads.id
      where written.state <> 'cancelled' and written.connection_id is not null
    )
    select
      count(touched.connection_id)::int as connection_count,
      coalesce(bool_or(ac.bridge_senders is not null), false) as from_chat,
      coalesce(
        bool_and(ac.id is not null and ac.bridge_senders is distinct from 'anyone'),
        true
      ) as personal_context
    from touched
    left join agent_connections ac on ac.id = touched.connection_id
  `.execute(database);
  const summary = rows[0];
  return {
    fromChat: summary?.fromChat === true,
    personLineage: (summary?.connectionCount ?? 0) === 0,
    personalContext: summary?.personalContext !== false,
  };
}
