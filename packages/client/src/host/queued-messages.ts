import type { ThreadInputQueue } from "@opensteer/core";
import type { MessageEntry } from "./client.js";
import { messageBody, toMessageEntry } from "./transcript.js";

/** One message waiting at the foot of a task's conversation. */
export interface QueuedMessage {
  /** The message as the conversation draws it once sent, so waiting only changes its edge. */
  readonly entry: MessageEntry;
  readonly item: ThreadInputQueue["items"][number];
  /** The next Run takes this message, rather than other work waiting ahead of it. */
  readonly next: boolean;
  readonly text: string;
}

/**
 * The messages people wrote that wait behind a task's current turn, in the
 * order Runs will take them. Opensteer follow-ups, delegation results and
 * automation runs wait in the same queue, but they are nobody's words to
 * take back, and each already has its own place in the conversation. Only a
 * message the next Run really takes is `next`, so a follow-up waiting ahead
 * of every message leaves none of them marked.
 */
export function queuedMessages(queue: ThreadInputQueue): QueuedMessage[] {
  const first = queue.items[0];
  return queue.items.flatMap((item) => {
    if (item.message.author.kind !== "human") return [];
    const entry = toMessageEntry(item.message, item.input.policy, item.input);
    if (entry === null) return [];
    return [
      {
        entry,
        item,
        next: !queue.paused && item === first,
        text: messageBody(item.message.content) || "Attachment",
      },
    ];
  });
}
