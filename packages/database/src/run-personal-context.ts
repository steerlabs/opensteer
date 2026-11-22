import { channelAllowsPersonalContext } from "@opensteer/channel-core";
import type { RunId, ThreadId, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { lineageAllowsPersonalContext } from "./resource-access.js";

/** Re-evaluate every sender represented in this task, including later admitted batches. */
export async function runAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  // The Run's own lineage, read in the same statement: work for a bridge anyone in its
  // conversation may speak to never has the person's personal context.
  const run = await database
    .selectFrom("runs")
    .leftJoin("agentConnections", "agentConnections.id", "runs.connectionId")
    .select(["runs.threadId", "runs.requestedBy", "agentConnections.bridgeSenders"])
    .where("runs.id", "=", runId)
    .executeTakeFirstOrThrow();
  if (!lineageAllowsPersonalContext(run)) return false;
  return threadAllowsPersonalContext(database, run.threadId, run.requestedBy);
}
export async function threadAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
): Promise<boolean> {
  // Reused workers retain every assigning conversation's context restriction, a task linked
  // under another (an automation's own task) retains its parent's, and work an automation's
  // program sends anywhere retains its anchor's.
  const ancestors = await sql<{
    threadId: ThreadId;
    bridgeSenders: "owner" | "anyone" | null;
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
    )
    select context_threads.id as "threadId", origin.bridge_senders as "bridgeSenders"
    from context_threads
    left join threads task on task.id = context_threads.id
    left join agent_connections origin on origin.id = task.origin_connection_id
  `.execute(database);
  // A task in, or under, the lineage of a bridge anyone may speak to has no personal context.
  if (!ancestors.rows.every(lineageAllowsPersonalContext)) return false;
  const threadIds = ancestors.rows.map((row) => row.threadId);
  const sources = await database
    .selectFrom("threadInputs")
    .innerJoin("channelConversations", (join) =>
      join.on(
        sql<boolean>`channel_conversations.id = thread_inputs.authority_source->>'conversationId'`,
      ),
    )
    .leftJoin("channelIdentities", "channelIdentities.principalId", "threadInputs.actorPrincipalId")
    .select([
      "threadInputs.threadId",
      "channelConversations.conversationType",
      "channelIdentities.linkedUserId",
      "channelIdentities.status",
    ])
    .where("threadInputs.threadId", "in", threadIds)
    .where("threadInputs.state", "<>", "cancelled")
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "channel-ingress")
    .execute();
  const represented = new Set(sources.map((source) => source.threadId));
  const unrepresented = threadIds.filter((id) => !represented.has(id));
  if (
    unrepresented.length &&
    (await database
      .selectFrom("channelConversations")
      .select("id")
      .where("activeThreadId", "in", unrepresented)
      .executeTakeFirst())
  )
    return false;
  return sources.every((source) =>
    channelAllowsPersonalContext({
      conversationType: source.conversationType,
      linkedSenderId: source.status === "linked" ? source.linkedUserId : null,
      ownerId: ownerId,
    }),
  );
}
