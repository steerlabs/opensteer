import type { ThreadId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function freshContextBoundary(
  database: Kysely<DatabaseSchema>,
  run: { readonly threadId: ThreadId; readonly runOrdinal: number },
): Promise<string | null> {
  // Freezing dispatch context commits with queued -> starting, even if native startup fails.
  const boundary = await database
    .selectFrom("runs")
    .innerJoin("threadInputs", "threadInputs.messageId", "runs.seedInputId")
    .innerJoin("messages", "messages.id", "runs.seedInputId")
    .select("messages.sequence")
    .where("runs.threadId", "=", run.threadId)
    .where("runs.runOrdinal", "<=", run.runOrdinal)
    .where("runs.reportContext", "is not", null)
    .where("threadInputs.freshContext", "=", true)
    .orderBy("runs.runOrdinal", "desc")
    .limit(1)
    .executeTakeFirst();
  return boundary?.sequence ?? null;
}
