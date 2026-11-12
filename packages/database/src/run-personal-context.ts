import { channelAllowsPersonalContext } from "@opensteer/channel-core";
import type { RunId, ThreadId, UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** Re-evaluate every sender represented in this task, including later admitted batches. */
export async function runAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  const run = await database
    .selectFrom("runs")
    .select(["threadId", "requestedBy"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return threadAllowsPersonalContext(database, run.threadId, run.requestedBy);
}
export async function threadAllowsPersonalContext(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  ownerId: UserId,
): Promise<boolean> {
  // Reused workers retain every assigning conversation's context restriction.
  const ancestors = await sql<{ threadId: ThreadId }>`
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
        select parent_thread_id as id from delegations where child_thread_id = current.id
      ) parent
    )
    select id as thread_id from context_threads
  `.execute(database);
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
