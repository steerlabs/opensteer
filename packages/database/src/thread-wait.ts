import {
  OpensteerError,
  type AssignmentId,
  type MessageId,
  type RunId,
  type ThreadId,
  type UserId,
  type Sequence,
  SequenceSchema,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { publishedMessagePredicate } from "./message-visibility.js";
import { messageFromRow } from "./thread-row-mappers.js";
import { boundedSerializedPrefix } from "./message-window.js";

/** A repeatable snapshot so a completion and its reply cannot be observed apart. */
export function readThreadWaitSnapshot(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly userId: UserId;
    readonly afterMessageId?: MessageId;
    readonly afterSequence?: Sequence;
    readonly runId?: RunId;
    readonly assignmentId?: AssignmentId;
  },
) {
  return withDatabaseTransaction(
    database,
    async (tx) => {
      const thread = await tx
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .select("threads.id")
        .where("threads.id", "=", input.threadId)
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .executeTakeFirst();
      if (!thread)
        throw new OpensteerError({ code: "forbidden", message: "Thread is unavailable" });
      const visible = tx
        .selectFrom("messages")
        .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
        .where("messages.threadId", "=", input.threadId)
        .where(publishedMessagePredicate("threadInputs"));
      let after = input.afterSequence;
      if (input.afterMessageId) {
        const anchor = await visible
          .select("messages.sequence")
          .where("messages.id", "=", input.afterMessageId)
          .executeTakeFirst();
        if (!anchor)
          throw new OpensteerError({
            code: "not_found",
            message: "Message is unavailable in this conversation",
          });
        after = SequenceSchema.parse(anchor.sequence);
      }
      const latest = await visible
        .select("messages.sequence")
        .orderBy("messages.sequence", "desc")
        .limit(1)
        .executeTakeFirst();
      const messages =
        after === undefined
          ? []
          : await visible
              .selectAll("messages")
              .where("messages.sequence", ">", after)
              .orderBy("messages.sequence", "asc")
              .limit(101)
              .execute();
      const kept = boundedSerializedPrefix(messages.map(messageFromRow), 100, 400 * 1024).items;
      let runQuery = tx
        .selectFrom("runs")
        .select(["id", "status"])
        .where("threadId", "=", input.threadId);
      if (input.assignmentId) runQuery = runQuery.where("assignmentId", "=", input.assignmentId);
      const run = await (
        input.runId
          ? runQuery.where("id", "=", input.runId)
          : runQuery.orderBy("runOrdinal", "desc").limit(1)
      ).executeTakeFirst();
      let requestQuery = tx
        .selectFrom("requests")
        .select(["id", "kind"])
        .where("originatingThreadId", "=", input.threadId)
        .where("status", "=", "pending");
      if (input.assignmentId)
        requestQuery = requestQuery.where("originatingRunId", "in", (eb) =>
          eb
            .selectFrom("runs")
            .select("runs.id")
            .where("runs.assignmentId", "=", input.assignmentId!),
        );
      const pendingRequest = await requestQuery
        .orderBy("createdAt", "asc")
        .limit(1)
        .executeTakeFirst();
      return {
        ...(run ? { run } : {}),
        ...(pendingRequest ? { pendingRequest } : {}),
        messages: kept,
        hasMore: messages.length > kept.length,
        lastSequence: latest ? SequenceSchema.parse(latest.sequence) : undefined,
      };
    },
    "repeatable read",
  );
}
