import {
  RequestIdSchema,
  requestIsAgentAnswerable,
  type MessageId,
  type RequestId,
  threadAccessModeAtMost,
  threadReachScope,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { requestFromRow } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { threadExecutionIsAvailableToUser } from "./store-primitives.js";

export const taskQuestionCause = "task-question";

export async function taskQuestionNoticeSource(
  database: Kysely<DatabaseSchema>,
  requestId: RequestId,
) {
  const row = await database
    .selectFrom("requests")
    .innerJoin("runs", "runs.id", "requests.originatingRunId")
    .innerJoin("delegations", "delegations.id", "runs.assignmentId")
    .innerJoin("threads as worker", "worker.id", "requests.originatingThreadId")
    .selectAll("requests")
    .select([
      "delegations.parentRunId",
      "delegations.parentThreadId",
      "worker.title as workerTitle",
    ])
    .where("requests.id", "=", requestId)
    .where("requests.status", "=", "pending")
    .where("requests.responseCommandId", "is", null)
    .where("delegations.origin", "=", "run")
    .where("delegations.status", "=", "open")
    .executeTakeFirst();
  if (!row || !row.parentRunId || !requestIsAgentAnswerable(requestFromRow(row))) return null;
  return {
    request: requestFromRow(row),
    parentRunId: row.parentRunId,
    parentThreadId: row.parentThreadId,
    workerTitle: row.workerTitle,
  };
}

/** The caller holds the notice's Request through lockThreadProjectionParents. */
export async function taskQuestionNoticeIsPending(
  transaction: Transaction<DatabaseSchema>,
  messageId: MessageId,
): Promise<boolean> {
  const input = await transaction
    .selectFrom("threadInputs")
    .select(["authoritySource", "requestedBy", "threadId"])
    .where("messageId", "=", messageId)
    .executeTakeFirst();
  if (!input) return true;
  const source = input.authoritySource;
  if (source?.kind !== "platform" || source.cause !== taskQuestionCause) return true;
  const id = RequestIdSchema.safeParse(source.referenceId);
  if (!id.success) return false;
  const question = await taskQuestionNoticeSource(transaction, id.data);
  if (!question || question.parentThreadId !== input.threadId) return false;
  const threads = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "in", [input.threadId, question.request.originatingThreadId])
    .execute();
  const parent = threads.find(({ id }) => id === input.threadId);
  const worker = threads.find(({ id }) => id === question.request.originatingThreadId);
  if (!parent || !worker || !threadAccessModeAtMost(worker.accessMode, parent.accessMode))
    return false;
  const reach = threadReachScope(parent);
  return (
    !(reach.kind === "workspace" && reach.workspaceId !== worker.workspaceId) &&
    !(reach.kind === "lineage" && reach.lineageRootThreadId !== worker.lineageRootThreadId) &&
    (await threadExecutionIsAvailableToUser(transaction, worker.id, input.requestedBy))
  );
}
