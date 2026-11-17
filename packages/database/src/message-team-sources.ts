import type { MessageId, TeamSource, ThreadId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** The team channel and audience each of these messages arrived from, where one did. */
export async function messageTeamSources(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  messageIds: readonly MessageId[],
): Promise<ReadonlyMap<MessageId, TeamSource>> {
  if (!messageIds.length) return new Map();
  const rows = await database
    .selectFrom("threadInputs")
    .select(["messageId", "teamSource"])
    .where("threadId", "=", threadId)
    .where("messageId", "in", messageIds)
    .where("teamSource", "is not", null)
    .execute();
  return new Map(
    rows.flatMap((row) => (row.teamSource ? [[row.messageId, row.teamSource] as const] : [])),
  );
}
