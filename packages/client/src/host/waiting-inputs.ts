import type {
  MessageEdit,
  MessageRevisionView,
  TeamAudience,
  ThreadInputQueue,
} from "@opensteer/core";
import type { NeedsYouPage } from "@opensteer/protocol";
import type { MessageEntry } from "./client.js";
import { messageAuthorName } from "./conversation-presentation.js";
import { messageBody, toMessageEntry } from "./transcript.js";

type QueueItem = ThreadInputQueue["items"][number];

/**
 * Who is editing a waiting message, as this device sees it. Another device's
 * edit holds the message, and everything behind it, until it saves, cancels,
 * lapses or is released here.
 */
export type WaitingInputLease =
  | { readonly kind: "none" }
  | { readonly kind: "mine"; readonly leaseId: string }
  | {
      readonly kind: "other";
      readonly leaseId: string;
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
   * The version shown, 0 until edited. An editor starts from it and an
   * approval names it, so the Host acts on exactly what the person saw.
   */
  readonly revision: number;
  /** Set once edited: the "Edited" mark, which opens `listMessageRevisions`. */
  readonly edit: MessageEdit | null;
  /** The Host takes an edit from this person (`editWaitingMessage`). */
  readonly canEdit: boolean;
  readonly lease: WaitingInputLease;
  /** The item as the Host read it. */
  readonly item: QueueItem;
}

/** A message in line for the agent: the person's own, or a teammate's ask already approved. */
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

/**
 * A teammate's ask, mentioning the person's agent in a team channel, that
 * waits for the person's answer. It cannot reach the agent until approved,
 * and approval puts it at the back of the line. Declining ends it, and its
 * task too when the ask was all the task ever held.
 */
export interface WaitingAsk extends WaitingInputCommon {
  readonly kind: "ask";
  readonly teamId: string;
  readonly requestId: string;
  /** Who asked, as the task names them ("Maya", or "Maya's agent"). */
  readonly asker: string;
  /**
   * Approved, here or on another device, and waiting for the team to confirm
   * before it joins the line. Answer, Decline and edits are closed meanwhile.
   */
  readonly approving: boolean;
  readonly consent: WaitingAskConsent;
  /** When the ask lapses unanswered, once Needs you has said; null until then. */
  readonly consentExpiresAt: string | null;
}

export type WaitingInput = WaitingMessage | WaitingAsk;

/** Where the agent's answer to an ask will be posted, and who will read it. */
export interface WaitingAskConsent {
  readonly teamName: string;
  readonly channelName: string;
  readonly channelKind: TeamAudience["channelKind"];
  readonly memberCount: number;
  /** Other teams the channel is shared with, whose members read the answer too. */
  readonly sharedWith: readonly string[];
  /** The quiet line under the ask: "Replies in #general · 12 people · Shared with Globex". */
  readonly line: string;
}

/**
 * Everything waiting to reach the person's agent at the foot of a task, in
 * the order it will go: their messages in line, then teammates' asks awaiting
 * their answer. Opensteer follow-ups, delegation results and automation runs
 * wait in the same queue, but they are nobody's words to edit or take back,
 * and each has its own place in the conversation. `ownsLease` is
 * `HostClient.ownsEditLease`; `needsYou` adds each ask's consent deadline.
 */
export function waitingInputs(
  queue: ThreadInputQueue,
  viewer: {
    readonly ownsLease: (leaseId: string) => boolean;
    readonly needsYou?: NeedsYouPage | null;
  },
): WaitingInput[] {
  const first = queue.items[0];
  return queue.items.flatMap((item): WaitingInput[] => {
    const { input, message } = item;
    const entry = toMessageEntry(message, input.policy, input);
    if (entry === null) return [];
    const common: WaitingInputCommon = {
      canEdit: item.canEdit,
      edit: message.edit ?? null,
      entry,
      item,
      lease:
        item.lease === null
          ? { kind: "none" }
          : viewer.ownsLease(item.lease.leaseId)
            ? { kind: "mine", leaseId: item.lease.leaseId }
            : { kind: "other", ...item.lease },
      messageId: message.id,
      revision: message.edit?.revision ?? 0,
      text: messageBody(message.content) || "Attachment",
      threadId: queue.threadId,
    };
    if (input.state === "awaiting-approval") {
      if (input.teamRequestId === null || input.teamSource === null) return [];
      const { teamId } = input.teamSource;
      const requestId = input.teamRequestId;
      const listed = viewer.needsYou?.entries.find(
        (row) => row.kind === "team-ask" && row.teamId === teamId && row.requestId === requestId,
      );
      return [
        {
          ...common,
          kind: "ask",
          // The Host closes edits to an ask once its approval is under way.
          approving: !item.canEdit,
          asker: messageAuthorName(message.author),
          consent: waitingAskConsent(input.teamSource.audience),
          consentExpiresAt: listed?.kind === "team-ask" ? listed.consentExpiresAt : null,
          requestId,
          teamId,
        },
      ];
    }
    if (input.state !== "pending") return [];
    if (message.author.kind !== "human" && message.author.kind !== "team-member") return [];
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

export function waitingAskConsent(audience: TeamAudience): WaitingAskConsent {
  const sharedWith = audience.externalTeams?.map((team) => team.name) ?? [];
  const where =
    audience.channelKind === "dm"
      ? "a direct message"
      : audience.channelKind === "group_dm"
        ? "a group message"
        : `#${audience.channelName}`;
  const people = `${audience.memberCount} ${audience.memberCount === 1 ? "person" : "people"}`;
  return {
    channelKind: audience.channelKind,
    channelName: audience.channelName,
    line: [
      `Replies in ${where}`,
      ...(audience.channelKind === "dm" ? [] : [people]),
      ...(sharedWith.length ? [`Shared with ${sharedWith.join(", ")}`] : []),
    ].join(" · "),
    memberCount: audience.memberCount,
    sharedWith,
    teamName: audience.teamName,
  };
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
 * opens. For a teammate's ask, the original is theirs and every edit the
 * person's own.
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
