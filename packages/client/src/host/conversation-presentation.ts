import { CHAT_THREAD_TITLE, type MessageAuthor, type MessageKind } from "@opensteer/core";
import type { MessageEntry } from "./client.js";

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
 * What an update line says woke Opensteer: a `report` left a note for its next
 * turn; a `queue` or `steer` from a trigger or watch is that automation
 * running, and from another agent is that agent asking. The reply below it is
 * Opensteer's own message, so the line names the cause, not a second sender.
 */
export function incomingMessageAction(message: MessageEntry): string {
  if (message.author.kind === "platform" && message.author.cause === "run-recovery")
    return "resumed this task";
  if (message.policy === "report") return "left a note";
  if (message.policy === undefined) return "sent a message";
  switch (message.author.kind) {
    case "trigger":
    case "watch":
      return "ran";
    case "agent":
      return "asked Opensteer";
    case "human":
    case "platform":
      return "sent a message";
  }
}

/**
 * Quoting an update into Chat's composer. It never sends and never changes who
 * the reply addresses; the label says where the quote lands.
 */
export interface AskAbout {
  readonly label: string;
  readonly quote: (message: MessageEntry) => void;
}

/** In Chat the quote joins this composer; anywhere else it opens Chat's. */
export function askAboutLabel(inChat: boolean): string {
  return inChat ? "Ask about this" : "Ask in Chat";
}

/** One automation's own page. */
export function automationPath(triggerId: string): string {
  return `/automations/${encodeURIComponent(triggerId)}`;
}
