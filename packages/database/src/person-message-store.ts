import { personalTransactionDatabase } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { syncTranscriptMessage } from "./message-visibility.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  createId,
  MessageAuthorSchema,
  OpensteerError,
  PersonMessageSchema,
  type Message,
  type MessageId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { admitRunToolCallInTransaction, type RunToolAdmissionInput } from "./run-tool-admission.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue, systemPrincipalId } from "./store-primitives.js";
import { messageFromRow } from "./thread-row-mappers.js";
export interface PersonMessageInput {
  readonly admission: RunToolAdmissionInput;
  readonly message: string;
}
export interface PersonMessageResult {
  readonly message: Message;

  readonly wasDuplicate: boolean;
}
export interface PersonMessageReady {
  readonly type: "replyPublished";
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly addressedToUserId: UserId;
}

type PersonMessageWake = (message: PersonMessageReady) => void | Promise<void>;
const messageWakes = new WeakMap<Kysely<DatabaseSchema>, PersonMessageWake>();

export function installPersonMessageWake(
  database: Kysely<DatabaseSchema>,
  wake: PersonMessageWake,
) {
  messageWakes.set(database, wake);
  return () => {
    if (messageWakes.get(database) === wake) messageWakes.delete(database);
  };
}

export async function publishPersonMessage(
  database: Kysely<DatabaseSchema>,
  input: PersonMessageInput,
): Promise<PersonMessageResult> {
  const text = PersonMessageSchema.parse(input.message);
  const admission = input.admission;
  if (admission.action !== "person.message")
    throw new OpensteerError({
      code: "bad_request",
      message: "Invalid notification admission",
    });
  return commitPersonalMutation(database, async (personalTransaction, mutation) => {
    await (async (transaction) => {
      await admitRunToolCallInTransaction(transaction, admission);
    })(personalTransaction);
    return (async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .select(["requestedBy", "actorPrincipalId"])
        .where("id", "=", admission.runId)
        .executeTakeFirstOrThrow();
      await requirePersonalOwner(transaction, run.requestedBy);
      const receipt = await transaction
        .selectFrom("agentControlRequests")
        .select("resultMessageId")
        .where("runId", "=", admission.runId)
        .where("requestId", "=", admission.requestId)
        .executeTakeFirstOrThrow();
      if (receipt.resultMessageId) {
        const row = await transaction
          .selectFrom("messages")
          .selectAll()
          .where("id", "=", receipt.resultMessageId)
          .executeTakeFirstOrThrow();
        return { message: messageFromRow(row), wasDuplicate: true };
      }
      const thread = await transaction
        .selectFrom("threads")
        .select(["threads.nextMessageSequence"])
        .where("threads.id", "=", admission.sourceThreadId)
        .forNoKeyUpdate("threads")
        .executeTakeFirstOrThrow();
      const principal = await transaction
        .selectFrom("principals")
        .select("displayName")
        .where("id", "=", systemPrincipalId)
        .where("kind", "=", "system")
        .executeTakeFirstOrThrow();
      const row = await transaction
        .insertInto("messages")
        .values({
          id: createId("message"),
          threadId: admission.sourceThreadId,
          runId: admission.runId,
          kind: "assistant",
          actorPrincipalId: run.actorPrincipalId,
          addressedToUserId: run.requestedBy,
          author: jsonValue(
            MessageAuthorSchema.parse({
              kind: "agent",
              displayName: principal.displayName,
              runId: admission.runId,
              threadId: admission.sourceThreadId,
            }),
          ),
          content: jsonValue([
            {
              type: "text",
              text,
            },
          ]),
          sequence: thread.nextMessageSequence,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("threads")
        .set({
          nextMessageSequence: sql`next_message_sequence + 1`,
          updatedAt: new Date(),
        })
        .where("id", "=", admission.sourceThreadId)
        .executeTakeFirstOrThrow();
      const message = messageFromRow(row);
      await syncTranscriptMessage(transaction, message.id);
      await transaction
        .updateTable("agentControlRequests")
        .set({
          resultMessageId: message.id,
        })
        .where("runId", "=", admission.runId)
        .where("requestId", "=", admission.requestId)
        .executeTakeFirstOrThrow();
      const source = personalTransactionDatabase(transaction);
      const wake = source && messageWakes.get(source);
      if (wake)
        mutation.reaction(() =>
          wake({
            messageId: message.id,
            threadId: message.threadId,
            runId: admission.runId,
            type: "replyPublished",
            addressedToUserId: run.requestedBy,
          }),
        );
      return { message, wasDuplicate: false };
    })(personalTransaction);
  });
}
