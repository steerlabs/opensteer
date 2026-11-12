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
  const sources = await database
    .selectFrom("threadInputs")
    .innerJoin("channelConversations", (join) =>
      join.on(
        sql<boolean>`channel_conversations.id = thread_inputs.authority_source->>'conversationId'`,
      ),
    )
    .leftJoin("channelIdentities", "channelIdentities.principalId", "threadInputs.actorPrincipalId")
    .select([
      "channelConversations.conversationType",
      "channelIdentities.linkedUserId",
      "channelIdentities.status",
    ])
    .where("threadInputs.threadId", "=", threadId)
    .where("threadInputs.state", "<>", "cancelled")
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "channel-ingress")
    .execute();
  if (!sources.length)
    return !(await database
      .selectFrom("channelConversations")
      .select("id")
      .where("activeThreadId", "=", threadId)
      .executeTakeFirst());
  return sources.every((source) =>
    channelAllowsPersonalContext({
      conversationType: source.conversationType,
      linkedSenderId: source.status === "linked" ? source.linkedUserId : null,
      ownerId: ownerId,
    }),
  );
}
