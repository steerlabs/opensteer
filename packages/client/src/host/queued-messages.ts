import type { ThreadInputQueue } from "@opensteer/core";
import { messageBody } from "./transcript.js";

/** One message the composer's queue tray shows. */
export interface QueuedMessage {
  readonly item: ThreadInputQueue["items"][number];
  /** The next Run takes this message, rather than other work waiting ahead of it. */
  readonly next: boolean;
  readonly text: string;
}

/**
 * What the composer's queue tray shows: the messages people wrote, in the
 * order Runs will take them. Opensteer follow-ups, delegation results and
 * automation runs wait in the same queue, but they are nobody's words to
 * rearrange or take back, and each already has its own place in the
 * conversation. Only a message the next Run really takes is `next`, so a
 * follow-up waiting ahead of every message leaves none of them marked.
 */
export function queuedMessages(queue: ThreadInputQueue): QueuedMessage[] {
  const first = queue.items[0];
  return queue.items
    .filter((item) => item.message.author.kind === "human")
    .map((item) => ({
      item,
      next: !queue.paused && item === first,
      text: messageBody(item.message.content) || "Attachment",
    }));
}
