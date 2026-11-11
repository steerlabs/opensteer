import { channelAllowsPersonalContext } from "@opensteer/channel-core";
import type { RunId } from "@opensteer/core";
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
    .where("threadInputs.threadId", "=", run.threadId)
    .where("threadInputs.state", "<>", "cancelled")
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "channel-ingress")
    .execute();
  if (!sources.length)
    return !(await database
      .selectFrom("channelConversations")
      .select("id")
      .where("activeThreadId", "=", run.threadId)
      .executeTakeFirst());
  return sources.every((source) =>
    channelAllowsPersonalContext({
      conversationType: source.conversationType,
      linkedSenderId: source.status === "linked" ? source.linkedUserId : null,
      ownerId: run.requestedBy,
    }),
  );
}
