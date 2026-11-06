import { CHAT_THREAD_TITLE, type MessageAuthor, type MessageKind } from "@opensteer/core";
import type { TranscriptGroup } from "./agent-activity-model.js";
import type { MessageEntry } from "./client.js";
import { formatClockTime } from "./thread-list-model.js";

/**
 * What a reader calls a conversation. Their own Chat is Chat on every client —
 * the Host titles it so and never renames it — and Opensteer is the agent who
 * answers there, not the place. Any other conversation goes by its title.
 */
export function conversationName(
  threadId: string,
  title: string,
  homeThreadId: string | null,
): string {
  return threadId === homeThreadId ? CHAT_THREAD_TITLE : title;
}

/**
 * Whom a message is from, as the reader is told. An agent's input carries the
 * name the Host gives its source conversation, which for the reader's own Chat
 * is Chat; the replies Opensteer writes there stay Opensteer's.
 */
export function messageAuthorName(
  author: MessageAuthor,
  kind: MessageKind,
  homeThreadId: string | null,
): string {
  if (author.kind === "platform") return "Opensteer";
  if (author.kind === "agent" && kind === "input" && author.threadId === homeThreadId)
    return CHAT_THREAD_TITLE;
  return author.displayName;
}

/**
 * A bounded excerpt of supporting input, never of the person's words or the
 * assistant's answer. Clients render only this bounded source until expansion,
 * rather than parsing and mounting an entire report just to hide most of it.
 */
export function incomingMessagePreview(message: MessageEntry): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const recovery = message.author.kind === "platform" && message.author.cause === "run-recovery";
  if ((!recovery && message.messageKind !== "input") || message.author.kind === "human") {
    return { text: message.body, truncated: false };
  }
  const limit = 720;
  const lineLimit = 8;
  let text = "";
  let characters = 0;
  let lines = 1;
  for (const character of message.body.trimEnd()) {
    if (characters === limit || (character === "\n" && lines === lineLimit)) {
      return { text: `${text.trimEnd()}…`, truncated: true };
    }
    text += character;
    characters += 1;
    if (character === "\n") lines += 1;
  }
  return { text, truncated: false };
}

/**
 * How many lines of a sent message show before the rest folds behind Show
 * more. What others send a task is context the reader skims, so it folds
 * early; the reader's own words fold only once they run long. Folding hides,
 * it never cuts, and the agent's replies are not sent messages: they never fold.
 */
export function messageFoldLines(message: MessageEntry, viewerUserId: string | null): number {
  return message.author.kind === "human" && message.author.userId === viewerUserId ? 20 : 5;
}

/**
 * What a sender did, where the message doesn't show it. A `report` starts no
 * turn and draws no reply, so it must not read as a message awaiting an answer.
 */
export function incomingMessageAction(message: MessageEntry): string | null {
  if (message.author.kind === "platform" && message.author.cause === "run-recovery")
    return "resumed this task";
  return message.policy === "report" ? "left a note" : null;
}

/** One automation's own page. */
export function automationPath(triggerId: string): string {
  return `/automations/${encodeURIComponent(triggerId)}`;
}

/**
 * Whether a message left moments ago, so it rises into place rather than just
 * standing there. Age is the only sign that survives a remount, and history a
 * Thread opens with is never this young.
 */
export function justSent(createdAt: string, now: number): boolean {
  return Math.abs(now - Date.parse(createdAt)) < 2_000;
}

/**
 * Which of the transcript's three voices a group speaks in: the reader's own
 * messages, an input arriving from elsewhere, or the agent's own work.
 */
export type TranscriptVoice = "agent" | "input" | "mine";

export function transcriptVoice(
  group: TranscriptGroup,
  viewerUserId: string | null,
): TranscriptVoice {
  if (group.kind !== "message") return "agent";
  const message = group.entry;
  if (message.messageKind === "assistant") return "agent";
  return message.author.kind === "human" && message.author.userId === viewerUserId
    ? "mine"
    : "input";
}

/** A row of a conversation among the rows around it, which is what shapes its bubble. */
export interface ConversationPlace {
  /** The next row carries on from this one, so the tail belongs to that row. */
  readonly continued: boolean;
  /** This row carries on from the one above, so it stands close under it. */
  readonly joined: boolean;
  /** When this row was said, where a pause has passed since the row above. */
  readonly time: string | null;
}

const conversationPause = 60 * 60_000;

function groupTime(group: TranscriptGroup): number {
  const at =
    group.kind === "turn"
      ? (group.turn.reply?.createdAt ?? group.turn.run?.createdAt)
      : group.entry.createdAt;
  return at === undefined ? Number.NaN : Date.parse(at);
}

function calendarDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** What Messages centres over a pause: the day, in the fewest words that name it. */
export function conversationTimeLabel(at: number, now: number): string {
  const clock = formatClockTime(new Date(at).toISOString());
  const days = Math.round((calendarDay(now) - calendarDay(at)) / (24 * 60 * 60_000));
  if (days <= 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  const options: Intl.DateTimeFormatOptions =
    days < 7 ? { weekday: "long" } : { day: "numeric", month: "short" };
  return `${new Intl.DateTimeFormat(undefined, options).format(at)} ${clock}`;
}

/** Where each row stands, one to one with `groups`. */
export function conversationPlaces(
  groups: readonly TranscriptGroup[],
  viewerUserId: string | null,
  now: number,
): readonly ConversationPlace[] {
  // Only a message or a reply is a bubble: a task's line under one ends its run,
  // whether it stands as its own row or inside the turn that started the task.
  const voices = groups.map((group) =>
    group.kind === "message" || group.kind === "turn" ? transcriptVoice(group, viewerUserId) : null,
  );
  const times = groups.map(groupTime);
  const paused = (index: number): boolean => {
    const before = times[index - 1];
    return before === undefined || (times[index] ?? Number.NaN) - before >= conversationPause;
  };
  const endsRun = (group: TranscriptGroup | undefined): boolean =>
    group?.kind === "turn" && group.turn.assignments.length > 0;
  const sameRun = (index: number): boolean =>
    voices[index] !== null &&
    voices[index] !== undefined &&
    voices[index - 1] === voices[index] &&
    !endsRun(groups[index - 1]) &&
    !paused(index);
  return groups.map((_, index) => {
    const at = times[index] ?? Number.NaN;
    return {
      continued: sameRun(index + 1),
      joined: sameRun(index),
      time: paused(index) && Number.isFinite(at) ? conversationTimeLabel(at, now) : null,
    };
  });
}
