import { type RunMaintenance, type ThreadId, type UserId, OpensteerError } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { enqueueThreadInputInTransaction } from "./thread-inbox.js";

export async function admitIdleCompaction(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly maintenance: RunMaintenance;
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
    readonly nowMs?: number;
  },
) {
  try {
    return await withPersonalTransaction(database, async (transaction) => {
      const result = await enqueueThreadInputInTransaction(transaction, {
        ...input,
        ...(input.nowMs === undefined ? {} : { maintenanceNowMs: input.nowMs }),
        content: [{ type: "text", text: "/compact" }],
        idempotencyKey: `compact:${input.maintenance.providerSessionId}:${input.maintenance.sourceRunId}`,
        policy: "queue",
        source: {
          kind: "platform",
          cause: "claude-compaction",
          sourceRunId: input.maintenance.sourceRunId,
        },
      });
      if (!result.wasDuplicate && (!result.run?.maintenance || !result.command))
        throw new OpensteerError({ code: "conflict", message: "Compaction was not admitted" });
      return result.wasDuplicate ? null : result;
    });
  } catch (error) {
    if (error instanceof OpensteerError && error.code === "conflict") return null;
    throw error;
  }
}

export async function idleCompactionCandidates(
  database: Kysely<DatabaseSchema>,
  threadId?: ThreadId,
) {
  const policy = await database
    .selectFrom("personalSettings")
    .select("idleCompactionPolicy")
    .executeTakeFirst();
  if (policy?.idleCompactionPolicy.mode !== "beforeCacheExpires") return [];
  return database
    .selectFrom("providerSessions")
    .innerJoin("threads", "threads.id", "providerSessions.threadId")
    .select([
      "providerSessions.id as providerSessionId",
      "providerSessions.contextSnapshot",
      "threads.id as threadId",
      "threads.createdBy as requestedBy",
      "threads.environmentId",
    ])
    .where("providerSessions.active", "=", true)
    .where("providerSessions.contextSnapshot", "is not", null)
    .$if(threadId !== undefined, (q) => q.where("threads.id", "=", threadId!))
    .execute();
}
