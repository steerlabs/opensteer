import { createHash } from "node:crypto";
import { personalTransactionDatabase } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { syncTranscriptMessage } from "./message-visibility.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  createId,
  MessageAuthorSchema,
  MessageIdSchema,
  OpensteerError,
  PersonMessageSchema,
  type Message,
  type MessageAuthor,
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

export interface ProgramPersonMessageInput {
  readonly ownerId: UserId;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly message: string;
  readonly author: Extract<MessageAuthor, { kind: "trigger" | "watch" }>;
}

/** Deterministic MessageId from (threadId, requestId) so retries are idempotent without new tables. */
function programMessageId(threadId: ThreadId, requestId: string): MessageId {
  const digest = createHash("sha256")
    .update(`program-person-message|${threadId}|${requestId}`)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return MessageIdSchema.parse(
    `msg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/** Publishes a direct message from an automation script (`send_to_person`) to its anchor thread. */
export async function publishProgramPersonMessage(
  database: Kysely<DatabaseSchema>,
  input: ProgramPersonMessageInput,
): Promise<PersonMessageResult> {
  const text = PersonMessageSchema.parse(input.message);
  const author = MessageAuthorSchema.parse(input.author);
  const id = programMessageId(input.threadId, input.requestId);
  return commitPersonalMutation(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.ownerId);
    const thread = await transaction
      .selectFrom("threads")
      .select(["threads.nextMessageSequence"])
      .where("threads.id", "=", input.threadId)
      .where("threads.createdBy", "=", input.ownerId)
      .where("threads.removedAt", "is", null)
      .forNoKeyUpdate("threads")
      .executeTakeFirst();
    if (!thread) throw new OpensteerError({ code: "forbidden", message: "Task is unavailable" });
    const existing = await transaction
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (existing) return { message: messageFromRow(existing), wasDuplicate: true };
    const row = await transaction
      .insertInto("messages")
      .values({
        id,
        threadId: input.threadId,
        runId: null,
        kind: "input",
        actorPrincipalId: systemPrincipalId,
        addressedToUserId: input.ownerId,
        author: jsonValue(author),
        content: jsonValue([{ type: "text", text }]),
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
      .where("id", "=", input.threadId)
      .executeTakeFirstOrThrow();
    const message = messageFromRow(row);
    await syncTranscriptMessage(transaction, message.id);
    return { message, wasDuplicate: false };
  });
}
