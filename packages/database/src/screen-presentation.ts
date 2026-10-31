import { type CommandId, type MessageId, type RunId, type ThreadId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { assertActiveGrant } from "./execution-authority.js";
import type { DatabaseSchema } from "./schema.js";

/** Exact actionable input membership, excluding history, passive context and refused hand-offs. */
export async function screenPresentationInput(
  database: Kysely<DatabaseSchema>,
  input: Parameters<typeof assertActiveGrant>[1] & { readonly messageId: MessageId },
  executionNow: () => number,
): Promise<{
  readonly steerCommandId: CommandId | null;
  readonly runId: RunId;
  readonly threadId: ThreadId;
} | null> {
  await assertActiveGrant(database, input, executionNow);
  const row = await database
    .selectFrom("threadInputs")
    .innerJoin("messages", "messages.id", "threadInputs.messageId")
    .innerJoin("threads", "threads.id", "threadInputs.threadId")
    .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
    .innerJoin("runAttempts", "runAttempts.runId", "threadInputs.runId")
    .leftJoin("commands", "commands.id", "threadInputs.steerCommandId")
    .select([
      "messages.author",
      "threadInputs.steerCommandId",
      "commands.type as steerType",
      "commands.status as steerStatus",
    ])
    .where("threadInputs.messageId", "=", input.messageId)
    .where("threadInputs.requestedBy", "=", input.requestedBy)
    .where("threadInputs.runId", "=", input.runId)
    .where("threadInputs.threadId", "=", input.threadId)
    .where("threadInputs.state", "in", ["claimed", "delivered", "unknown"])
    .where("threadInputs.policy", "in", ["queue", "steer"])
    .where("messages.kind", "=", "input")
    .where("messages.quote", "is", null)
    .where("threads.capabilityProfileId", "=", "main")
    .where("workspaces.kind", "=", "main")
    .whereRef("workspaces.homeThreadId", "=", "threads.id")
    .where("runAttempts.status", "=", "current")
    .where("runAttempts.bindingGeneration", "=", input.bindingGeneration)
    .where("runAttempts.runnerId", "=", input.runnerId)
    .where("runAttempts.runnerBootId", "=", input.runnerBootId)
    .where("runAttempts.dispatchedAt", "is not", null)
    .executeTakeFirst();
  if (!row || row.author.kind !== "human") return null;
  if (
    row.steerCommandId &&
    ((row.steerType !== "run.steer" && row.steerType !== "run.restart") ||
      (row.steerStatus !== "dispatched" &&
        row.steerStatus !== "succeeded" &&
        row.steerStatus !== "unknown"))
  )
    return null;
  return {
    steerCommandId: row.steerType === "run.steer" ? row.steerCommandId : null,
    runId: input.runId,
    threadId: input.threadId,
  };
}
