import { BrowserSignInRequestResponseSchema } from "@opensteer/protocol/browser-sources";
import { browserSiteLabel } from "./browser-sign-in.js";
import { cardUseTitle } from "./cards.js";
import { passwordSignInOutcome, passwordSignInReceipt } from "./passwords.js";
import {
  answeredQuestion,
  contentSaysSomething,
  threadInputIsPublished,
  type ThreadInput,
  requestOutcomeText,
  requestTitleText,
  type MessageEdit,
  type MessageKind,
  type MessageView,
  type Request,
  type ThreadInputPolicy,
  type ThreadInputState,
} from "@opensteer/core";
import type {
  AssignmentReturnEntry,
  DelegationEntry,
  DeliveryEntry,
  MessageEntry,
  PlaceEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  ToolEntry,
  TranscriptEntry,
} from "./client.js";

/**
 * A message still waiting for a Run: in line, or a teammate's ask awaiting
 * its owner's approval. Either may be edited, and neither has reached the agent.
 */
export function isWaitingInputState(
  state: ThreadInputState,
): state is Extract<ThreadInputState, "pending"> {
  return state === "pending";
}

/**
 * A waiting message rewritten in place keeps its place and lifecycle in the
 * conversation; only its words, files and edit mark change. Without `edit` the
 * Host rewrote it (a gathered assignment return), so its edit mark stays. An
 * entry not loaded stays unloaded: an edit never draws a message.
 */
export function withEditedMessage(
  entries: readonly TranscriptEntry[],
  message: MessageView,
  edit: MessageEdit | undefined,
): TranscriptEntry[] {
  const held = entries.find((entry) => entry.id === message.id);
  if (held?.kind !== "message" || (edit && (held.edit?.revision ?? 0) > edit.revision))
    return [...entries];
  const mark = edit ?? held.edit;
  const edited = toMessageEntry({ ...message, ...(mark ? { edit: mark } : {}) }, held.policy);
  if (!edited) return [...entries];
  const { places: _places, edit: _edit, ...kept } = held;
  const next: MessageEntry = {
    ...kept,
    attachments: edited.attachments ?? [],
    body: edited.body,
    ...(mark ? { edit: mark } : {}),
    pages: edited.pages ?? [],
    ...(edited.places ? { places: edited.places } : {}),
  };
  return entries.map((entry) => (entry === held ? next : entry));
}

/**
 * What the conversation says under a message once its input has settled: why
 * it did not, or may not, have reached a Run, or null once it did. Only an
 * input that left the queue other than by withdrawal has an outcome to show.
 */
export { threadInputDelivery } from "@opensteer/core";

export function finishRunEntries(
  entries: readonly TranscriptEntry[],
  runId: string | null,
  completedAt?: string,
): TranscriptEntry[] {
  if (!runId) return [...entries];
  return entries.map((entry) => {
    if (entry.kind === "withdrawn" || entry.runId !== runId) return entry;
    if (entry.kind === "message" && entry.streaming) return { ...entry, streaming: false };
    if (entry.kind === "reasoning" && entry.state === "streaming")
      return { ...entry, completedAt: completedAt ?? entry.completedAt, state: "done" as const };
    if (entry.kind === "tool" && entry.state === "running") {
      return { ...entry, completedAt: completedAt ?? entry.completedAt, state: "stopped" as const };
    }
    if (entry.kind === "node" && entry.status === "running") {
      return {
        ...entry,
        completedAt: completedAt ?? entry.completedAt,
        status: "interrupted" as const,
        progress: null,
      };
    }
    return entry;
  });
}

/** A Run's subagents still running when its attempt ended were stopped with it. */
export function isTerminalRunEntryStatus(status: RunEntry["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/**
 * What the conversation shows: every entry except the markers a withdrawn or
 * unloaded message left behind, and a message the Thread's queue still holds.
 * The queue read is the one authority on what is waiting, so in a work Thread
 * a message sent behind a running turn is drawn unsent from the queue, at the
 * conversation's foot, and joins the conversation only once a Run takes it.
 *
 * A conversation draws no queue. A person's own message that waits there for a
 * moment — its reply has not started, or waits on an approval — is what they
 * just said, so it is drawn as a sent bubble after everything else, in queue
 * order, until a Run takes it. Someone else's waiting input stays hidden, as
 * in a work Thread. A message a Run has already taken stays where the Run took
 * it, whatever a queue read that has not caught up says. Nothing to hide or
 * move hands back the same array, so readers keyed on identity stay put.
 */
export function visibleTranscript(
  entries: readonly TranscriptEntry[],
  queue: { readonly items: readonly { readonly message: { readonly id: string } }[] } | null,
  { conversation = false }: { readonly conversation?: boolean } = {},
): readonly TranscriptEntry[] {
  const order = new Map<string, number>(
    queue?.items.map((item, index) => [item.message.id, index]) ?? [],
  );
  const shown: TranscriptEntry[] = [];
  const waiting: MessageEntry[] = [];
  for (const entry of entries) {
    if (
      entry.kind === "selection" ||
      entry.kind === "withdrawn" ||
      entry.kind === "delivery" ||
      entry.kind === "request-wait"
    )
      continue;
    if (entry.kind !== "message" || !order.has(entry.id)) {
      shown.push(entry);
      continue;
    }
    if (!conversation || entry.author.kind !== "human") continue;
    if (entry.runId === null) waiting.push(entry);
    else shown.push(entry);
  }
  waiting.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const visible = [...shown, ...waiting];
  return visible.length === entries.length &&
    visible.every((entry, index) => entry === entries[index])
    ? entries
    : visible;
}

export function messageBody(content: ReadonlyArray<Record<string, unknown>>): string {
  return content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
}

type TranscriptMessageKind = Extract<MessageKind, "assistant" | "input">;

/**
 * The entry a Message makes in the conversation, or null for one it does not
 * show. An assignment's return is the Host's structured source, never its
 * text: that is written for the model and names internal ids.
 */
export function toTranscriptEntry(
  message: MessageView,
  policy: ThreadInputPolicy | undefined = message.policy,
  input?: Pick<ThreadInput, "policy" | "state"> | null,
): AssignmentReturnEntry | MessageEntry | null {
  const assignmentId = assignmentReturnId(message);
  if (assignmentId === null) return toMessageEntry(message, policy, input);
  return {
    assignmentId,
    createdAt: message.createdAt,
    id: message.id,
    kind: "assignment-return",
    runId: message.runId,
    sequence: message.sequence,
  };
}

/** The assignment a platform return message reports, or null for any other message. */
export function assignmentReturnId(message: Pick<MessageView, "author">): string | null {
  const { author } = message;
  return author.kind === "platform" &&
    author.cause === "assignment-result" &&
    author.referenceId !== undefined
    ? author.referenceId
    : null;
}

/** Model-control messages remain durable and agent-readable but are not conversation UI. */
export function toMessageEntry(
  message: MessageView,
  policy: ThreadInputPolicy | undefined = message.policy,
  input?: Pick<ThreadInput, "policy" | "state"> | null,
): MessageEntry | null {
  if (message.author.kind === "platform" && message.author.cause === "claude-compaction")
    return null;
  const recovery =
    message.kind === "continuation" &&
    message.author.kind === "platform" &&
    message.author.cause === "run-recovery";
  const kind = isTranscriptMessageKind(message.kind)
    ? message.kind
    : recovery
      ? "continuation"
      : null;
  if (kind === null) return null;
  if (!contentSaysSomething(message.content)) return null;
  const body = messageBody(message.content);
  const attachments = message.content.filter((part) => part.type === "artifact");
  const pages = message.content.filter((part) => part.type === "browser-page");
  const places = message.content.filter(
    (part) => part.type === "computer-app" || part.type === "phone",
  );
  return {
    ...(input?.state === "pending" && input.policy === "queue" && message.runId === null
      ? { queuePending: true as const }
      : {}),
    ...(message.clientSendKey ? { clientSendKey: message.clientSendKey } : {}),
    author: message.author,
    ...(message.addressedToUserId ? { addressedToUserId: message.addressedToUserId } : {}),
    sequence: message.sequence,
    published: input ? threadInputIsPublished(input) : (message.published ?? true),
    ...(message.quote ? { quote: message.quote } : {}),
    ...(message.edit ? { edit: message.edit } : {}),
    attachments,
    pages,
    ...(places.length ? { places } : {}),
    body,
    createdAt: message.createdAt,
    id: message.id,
    kind: "message",
    messageKind: kind,
    ...(message.kind === "input" && policy ? { policy } : {}),
    runId: message.runId,
  };
}

export function hydrateTranscriptMessage(
  card: MessageEntry,
  body: MessageView,
): MessageEntry | null {
  const full = toMessageEntry(body);
  if (!full) return null;
  return {
    ...full,
    runId: card.runId ?? full.runId,
    published: card.published ?? full.published ?? true,
    ...(card.clientSendKey ? { clientSendKey: card.clientSendKey } : {}),
    ...(card.itemId ? { itemId: card.itemId } : {}),
    ...(card.itemRevision ? { itemRevision: card.itemRevision } : {}),
    ...(card.delivery ? { delivery: card.delivery } : {}),
    ...(card.edit ? { edit: card.edit } : {}),
  };
}

export function isTranscriptMessageKind(kind: MessageKind): kind is TranscriptMessageKind {
  return kind === "assistant" || kind === "input";
}

export function upsertEntry(
  entries: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): TranscriptEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...entries, entry];
  return entries.map((item, itemIndex) => (itemIndex === index ? entry : item));
}

/** The receipt a resolved Request leaves in its Thread, wherever it was resolved. */
export function requestReceipt(
  request: Exclude<Request, { status: "pending" }>,
): RequestReceiptEntry {
  const question = answeredQuestion(request);
  return {
    createdAt: request.resolvedAt,
    ...(request.status === "declined" ? { declined: true } : {}),
    id: `request:${request.id}`,
    kind: "request",
    outcome: requestOutcome(request),
    ...(question ? { question } : {}),
    requestId: request.id,
    requestKind: request.kind,
    runId: request.originatingRunId,
    ...(request.kind === "browser.password-sign-in"
      ? { succeeded: passwordSignInOutcome(request)?.signedIn ?? false }
      : {}),
    title:
      request.payload.kind === "browser.password-sign-in" && request.payload.credential === "card"
        ? cardUseTitle(request.payload.site)
        : requestTitleText(request.presentation),
    // Only native harness waits are recorded; durable tool-call holds are not measured here.
    ...(request.mode === "live" ? { waitedSince: request.createdAt } : {}),
  };
}

function requestOutcome(request: Request): string {
  if (request.kind === "browser.sign-in") return browserSignInReceipt(request);
  if (request.kind === "browser.password-sign-in") return passwordSignInReceipt(request);
  return requestOutcomeText(request);
}

/** A sign-in receipt says what happened to the browser, in the card's own words. */
export function browserSignInReceipt(request: Request): string {
  if (request.status === "declined") return "Not allowed";
  const response = BrowserSignInRequestResponseSchema.safeParse(
    request.response?.kind === "external" ? request.response.value : null,
  );
  if (!response.success || response.data.outcome === "session-closed") return "Allowed";
  if (response.data.outcome === "not-signed-in") return "Chrome not signed in";
  const site = request.payload.kind === "browser.sign-in" ? request.payload.site : null;
  return site ? `Copied Chrome sign-in for ${browserSiteLabel(site)}` : "Copied Chrome sign-in";
}

export type {
  AssignmentReturnEntry,
  DelegationEntry,
  DeliveryEntry,
  MessageEntry,
  PlaceEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  ToolEntry,
};
