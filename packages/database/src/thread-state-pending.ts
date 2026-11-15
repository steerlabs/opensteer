import type { ThreadId } from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function markThreadStatePending(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<void> {
  await transaction
    .insertInto("threadStatePending")
    .values({
      threadId,
      requestedAt: new Date(),
    })
    .onConflict((conflict) => conflict.column("threadId").doNothing())
    .execute();
}
