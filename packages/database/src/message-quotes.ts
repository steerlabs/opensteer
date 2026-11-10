import { isPlaceContentPart } from "@opensteer/core";
import { publishedMessagePredicate } from "./message-visibility.js";
import {
  placeContentLabel,
  MessageQuoteSchema,
  OpensteerError,
  type MessageId,
  type MessageQuote,
  type UserId,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { messageFromRow } from "./thread-row-mappers.js";

export async function resolveMessageQuote(
  transaction: Transaction<DatabaseSchema>,
  messageId: MessageId,
  userId: UserId,
): Promise<MessageQuote> {
  const row = await transaction
    .selectFrom("messages")
    .innerJoin("threads", "threads.id", "messages.threadId")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .selectAll("messages")
    .where("messages.id", "=", messageId)
    .where("workspaceMemberships.userId", "=", userId)
    .where("workspaceMemberships.state", "=", "active")
    .where(publishedMessagePredicate("threadInputs"))
    .executeTakeFirst();
  if (!row)
    throw new OpensteerError({ code: "not_found", message: "The quoted message is unavailable" });
  const source = messageFromRow(row);
  return MessageQuoteSchema.parse({
    messageId: source.id,
    threadId: source.threadId,
    author: source.author,
    // Reference summaries carry labels, never addresses or control identifiers.
    excerpt: source.content
      .flatMap((part) =>
        part.type === "text"
          ? [part.text]
          : isPlaceContentPart(part)
            ? [placeContentLabel(part)]
            : [],
      )
      .join("\n")
      .slice(0, 4000),
  });
}
