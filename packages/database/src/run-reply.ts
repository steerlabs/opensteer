import {
  ContentPartSchema,
  contentSaysSomething,
  type ContentPart,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * A Run's reply: the last message its agent wrote that says something — text
 * or a file. Every engine ends a successful turn with its answer, so for a
 * completed Run this is what the person who asked is shown, what a channel
 * sends and what an Assignment returns. Whatever the agent wrote before it was
 * said on the way there.
 */
export async function runReply(
  transaction: Transaction<DatabaseSchema>,
  run: { readonly id: RunId; readonly threadId: ThreadId },
): Promise<{ readonly content: readonly ContentPart[]; readonly id: MessageId } | null> {
  // Read back from the newest one at a time: an engine that ended on an empty
  // result is the only reason the newest is not the answer.
  let before: string | null = null;
  for (;;) {
    const message = await transaction
      .selectFrom("messages")
      .select(["content", "id", "sequence"])
      .where("threadId", "=", run.threadId)
      .where("runId", "=", run.id)
      .where("kind", "=", "assistant")
      .$if(before !== null, (query) => query.where("sequence", "<", before ?? "0"))
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!message) return null;
    const content = ContentPartSchema.array().parse(message.content);
    if (contentSaysSomething(content)) return { content, id: message.id };
    before = message.sequence;
  }
}
