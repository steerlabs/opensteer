import type { MessageEntry, TranscriptEntry } from "@opensteer/client/host";
import type { UserId } from "@opensteer/core";
import type { PendingCommand } from "../client/thread-drafts.js";

/**
 * A message this phone owes the Host, drawn where the Host's copy will stand
 * the moment it is written down, so sending never waits on the network to be
 * seen. The Host's copy takes its place without moving or rising again.
 */

type OwedCommand = Pick<PendingCommand, "attachments" | "browserPage" | "idempotencyKey" | "text">;

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

/** Generous against a phone's clock, small against the gap between two sends. */
const clockSkewMs = 2 * 60_000;

type OwedClaim = Pick<PendingCommand, "createdAt" | "idempotencyKey" | "text">;

interface Reconciliation {
  /** The reader's earlier messages with the same words: never the Host's copy of this one. */
  readonly before: ReadonlySet<string>;
  /** Drawn in the transcript rather than held by the bar, decided once. */
  readonly inline: boolean;
  /** The Host's copy has been seen; it stays seen, whatever is said after it. */
  matched: boolean;
}

// By idempotency key, for the life of the process: a pane opened again, or
// the task Home handed the message to, carries on from what was first seen.
const reconciliations = new Map<string, Reconciliation>();

/**
 * Where an owed message stands against the transcript: drawn in it, or not
 * (held by the bar, or already the Host's). The Host's message does not carry
 * the key it was sent under, and the event stream can outrun the answer that
 * would name it, so its copy is recognised by its words: the reader's newest
 * message, not an earlier one saying the same, and not older than the claim.
 */
export function reconcileOwed(
  entries: readonly TranscriptEntry[],
  command: OwedClaim,
  viewerUserId: string,
  inlineNow: boolean,
): { readonly drawn: boolean; readonly inline: boolean } {
  let state = reconciliations.get(command.idempotencyKey);
  if (state === undefined) {
    const claimedAt = Date.parse(command.createdAt);
    state = {
      // Only what predates the claim: the Host's copy can already be loaded
      // when the phone comes back to a message whose answer was lost.
      before: new Set(
        ownMessages(entries, viewerUserId)
          .filter((entry) => entry.body === command.text && Date.parse(entry.createdAt) < claimedAt)
          .map((entry) => entry.id),
      ),
      inline: inlineNow,
      matched: false,
    };
    reconciliations.set(command.idempotencyKey, state);
  }
  if (!state.matched) state.matched = hostCopyShown(entries, command, viewerUserId, state.before);
  return { drawn: state.inline && !state.matched, inline: state.inline };
}

function hostCopyShown(
  entries: readonly TranscriptEntry[],
  command: OwedClaim,
  viewerUserId: string,
  before: ReadonlySet<string>,
): boolean {
  const newest = ownMessages(entries, viewerUserId).at(-1);
  return (
    newest !== undefined &&
    newest.body === command.text &&
    !before.has(newest.id) &&
    Date.parse(newest.createdAt) >= Date.parse(command.createdAt) - clockSkewMs
  );
}

function ownMessages(entries: readonly TranscriptEntry[], viewerUserId: string): MessageEntry[] {
  return entries.filter(
    (entry): entry is MessageEntry =>
      entry.kind === "message" &&
      entry.author.kind === "human" &&
      entry.author.userId === viewerUserId,
  );
}
