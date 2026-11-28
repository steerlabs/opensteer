import type { MessageEdit, MessageRevisionView } from "@opensteer/core";
import type { PersonalInputQueue } from "@opensteer/protocol";
import type { MessageEntry } from "./client.js";
import { messageAuthorName } from "./conversation-presentation.js";
import { messageBody } from "./transcript.js";

/**
 * Who is editing a waiting message, as this device sees it. Another device's
 * edit holds the message, and everything behind it, until it saves, cancels,
 * lapses or is released here.
 */
export type WaitingInputLease =
  | { readonly kind: "none" }
  | { readonly kind: "mine" }
  | {
      readonly kind: "other";
      /** The device it is open on, as the Host names it ("Tim's iPhone"). */
      readonly deviceLabel: string;
      readonly expiresAt: string;
    };

interface WaitingInputCommon {
  readonly threadId: string;
  /** The key every action takes. */
  readonly messageId: string;
  /** The message as the conversation draws it once sent, so waiting only changes its edge. */
  readonly entry: MessageEntry;
  /** Its words, or "Attachment" when it has none: for labels and previews. */
  readonly text: string;
  /**
   * The version shown, 0 until edited. An editor starts from it, so the Host
   * acts on exactly what the person saw.
   */
  readonly revision: number;
  /** Set once edited: the "Edited" mark, which opens `listMessageRevisions`. */
  readonly edit: MessageEdit | null;
  /** The Host takes an edit from this person (`editWaitingMessage`). */
  readonly canEdit: boolean;
  readonly lease: WaitingInputLease;
}

/** A message in line for the agent: the person's own. */
export interface WaitingMessage extends WaitingInputCommon {
  readonly kind: "message";
  /**
   * The next Run takes this message, rather than other work waiting ahead of
   * it or a paused queue: "Up next" rather than "Queued".
   */
  readonly next: boolean;
  readonly canCancel: boolean;
  readonly canMove: boolean;
  readonly canSteer: boolean;
}

export type WaitingInput = WaitingMessage;

/**
 * Everything waiting to reach the person's agent at the foot of a task, in
 * the order it will go: their messages in line. Opensteer follow-ups,
 * delegation results and automation runs wait in the same queue, but they are
 * nobody's words to edit or take back, and each has its own place in the
 * conversation.
 */
export function waitingInputs(queue: PersonalInputQueue): WaitingInput[] {
  const first = queue.items[0];
  return queue.items.flatMap((item): WaitingInput[] => {
    const { input, message } = item;
    const entry: MessageEntry = {
      author: message.author,
      body: message.preview,
      ...(message.clientSendKey ? { clientSendKey: message.clientSendKey } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      createdAt: message.createdAt,
      id: message.id,
      kind: "message",
      messageKind: "input",
      policy: "queue",
      previewTruncated: message.truncated,
      published: false,
      runId: null,
    };
    const common: WaitingInputCommon = {
      canEdit: item.canEdit,
      edit: message.edit ?? null,
      entry,
      lease:
        item.lease === null
          ? { kind: "none" }
          : item.lease.ownedBySession
            ? { kind: "mine" }
            : {
                kind: "other",
                deviceLabel: item.lease.deviceLabel,
                expiresAt: item.lease.expiresAt,
              },
      messageId: message.id,
      revision: message.revision,
      text: message.preview || "Attachment",
      threadId: queue.threadId,
    };
    if (input.state !== "pending") return [];
    if (message.author.kind !== "human") return [];
    return [
      {
        ...common,
        canCancel: item.canCancel,
        canMove: item.canMove,
        canSteer: item.canSteer,
        kind: "message",
        next: !queue.paused && item === first,
      },
    ];
  });
}

/** One version in a message's edit history, as its history sheet lists it. */
export interface MessageRevisionRow {
  readonly revision: number;
  /** Revision 0: the words as their author first sent them. */
  readonly original: boolean;
  /** The version waiting now, or the one a Run took. */
  readonly current: boolean;
  /** Who wrote this version: "You" for the viewer, else their name. */
  readonly by: string;
  /** The device an edit was saved on; null for the original. */
  readonly device: string | null;
  /** When this version was written, for the app's own clock formatting. */
  readonly at: string;
  /** Its words, or "Attachment" when it has none. */
  readonly text: string;
  readonly content: MessageRevisionView["content"];
}

/**
 * A message's versions, newest first, as one page or several pages of
 * `listMessageRevisions` joined in order, for the sheet the "Edited" mark
 * opens.
 */
export function messageRevisionRows(
  revisions: readonly MessageRevisionView[],
  viewerUserId: string | null,
): MessageRevisionRow[] {
  const newest = revisions.reduce((top, row) => Math.max(top, row.revision), 0);
  return revisions.map((row) => ({
    at: row.createdAt,
    by: authorIsViewer(row.author, viewerUserId) ? "You" : messageAuthorName(row.author),
    content: row.content,
    current: row.revision === newest,
    device: row.revision === 0 ? null : row.deviceLabel,
    original: row.revision === 0,
    revision: row.revision,
    text: messageBody(row.content) || "Attachment",
  }));
}

function authorIsViewer(
  author: MessageRevisionView["author"],
  viewerUserId: string | null,
): boolean {
  return viewerUserId !== null && author.kind === "human" && author.userId === viewerUserId;
}
