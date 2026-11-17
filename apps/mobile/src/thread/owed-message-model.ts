import type { MessageEntry } from "@opensteer/client/host";
import type { UserId } from "@opensteer/core";
import type { TaskStartRecord } from "../client/thread-drafts.js";

/**
 * A message this phone owes the Host, drawn where the Host's copy will stand
 * the moment it is written down, so sending never waits on the network to be
 * seen. The Host's copy takes its place without moving or rising again.
 */

type OwedCommand = Pick<TaskStartRecord, "attachments" | "browserPage" | "idempotencyKey" | "text">;

const owedPrefix = "owed:";

export function owedMessageEntry(command: OwedCommand, userId: UserId): MessageEntry {
  return {
    attachments: command.attachments ?? [],
    author: {
      displayName: "You",
      kind: "human",
      principalId: userId,
      userId,
    },
    body: command.text,
    createdAt: new Date(owedSince(command.idempotencyKey)).toISOString(),
    id: `${owedPrefix}${command.idempotencyKey}`,
    kind: "message",
    messageKind: "input",
    pages: command.browserPage === undefined ? [] : [command.browserPage],
    runId: null,
  };
}

export function isOwedMessage(messageId: string): boolean {
  return messageId.startsWith(owedPrefix);
}

// Per process, by idempotency key, which survives the hand-over from Home to
// the task it starts: a phone's clock against the Host's says nothing here.
const firstShown = new Map<string, number>();
const risen = new Set<string>();

/** When this message was first drawn as owed, so every view of it agrees on how long it has waited. */
export function owedSince(idempotencyKey: string): number {
  let since = firstShown.get(idempotencyKey);
  if (since === undefined) {
    since = Date.now();
    firstShown.set(idempotencyKey, since);
  }
  return since;
}

/** True the first time an owed message is drawn, and never for the Host's copy of it. */
export function risesOnce(messageId: string): boolean {
  if (!isOwedMessage(messageId) || risen.has(messageId)) return false;
  risen.add(messageId);
  return true;
}
