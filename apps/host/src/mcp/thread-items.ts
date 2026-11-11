import {
  isPlaceContentPart,
  placeContentLabel,
  requestTitleText,
  type AssignmentSummary,
  type Message,
  type Request,
} from "@opensteer/core";
import type { ThreadItem } from "@opensteer/agent-tools/outputs";
import type { AgentThreadActivityItem } from "@opensteer/database";

/** With a message's other parts, this keeps one item inside the agent output limit. */
const itemTextMaxBytes = 192 * 1024;

export function itemText(text: string | null, maxChars: number, offset = 0) {
  if (text === null) return { text: null, textTruncated: false, nextTextOffset: null };
  const points = Array.from(text);
  let window = points.slice(offset, offset + maxChars);
  for (
    let bytes = Buffer.byteLength(JSON.stringify(window.join("")), "utf8");
    bytes > itemTextMaxBytes;
    bytes = Buffer.byteLength(JSON.stringify(window.join("")), "utf8")
  )
    window = window.slice(0, Math.floor((window.length * itemTextMaxBytes) / bytes));
  const value = window.join("");
  const next = offset + window.length;
  const textTruncated = next < points.length;
  return { text: value, textTruncated, nextTextOffset: textTruncated ? next : null };
}
export function messageItem(message: Message, maxChars: number, offset = 0): ThreadItem {
  const text = message.content
    .map((part) =>
      part.type === "text"
        ? part.text
        : isPlaceContentPart(part)
          ? placeContentLabel(part)
          : `[file: ${part.name} (${part.mediaType})]`,
    )
    .join("\n");
  const places = message.content.filter(isPlaceContentPart);
  return {
    itemId: message.id,
    type: "message",
    status: "published",
    runId: message.runId,
    author: message.author,
    title: null,
    ...itemText(text, maxChars, offset),
    ...(places.length ? { places } : {}),
    createdAt: message.createdAt,
  };
}
type ActivityEvent = Exclude<AgentThreadActivityItem, { type: "message" }>;
type ToolStarted = Extract<ActivityEvent, { type: "tool.started" }>;

/** Their text can hold a sign-in, a card, a webhook secret or typed values. Engines spell names their own way. */
export function withheldTool(name: string): boolean {
  return /(?:^|[_\s.:/-])(?:sign_in|use_card|trigger_write|computer)(?:$|[\s.(])/u.test(name);
}

/** What a reader may see of one event; the caller has already dropped what it may not see at all. */
export function activityItem(
  event: ActivityEvent,
  facts: {
    readonly start?: ToolStarted | undefined;
    readonly request?: Request | null | undefined;
    readonly nodeTitle?: string | undefined;
    /** The Run acted for this reader, so its tool text is theirs. */
    readonly ownRun: boolean;
    readonly named: boolean;
    readonly maxChars: number;
    readonly offset?: number | undefined;
  },
): ThreadItem {
  let title: string | null = null;
  let text: string | null = null;
  let status: string = event.type.split(".")[1]!;
  switch (event.type) {
    case "tool.started":
    case "tool.completed": {
      title = facts.start?.data.tool.name ?? null;
      const readable = facts.ownRun && !!facts.start && !withheldTool(facts.start.data.tool.name);
      if (event.type === "tool.completed") {
        status = event.data.isError ? "failed" : "completed";
        if (readable) text = event.data.output.text;
      } else if (readable && facts.named) text = JSON.stringify(event.data.arguments) ?? null;
      break;
    }
    case "place.entered":
      title = event.data.title;
      text = event.data.site;
      break;
    case "app.published":
      title = event.data.title;
      break;
    case "node.started":
      title = event.data.title;
      break;
    case "node.completed":
      title = facts.nodeTitle ?? null;
      status = event.data.status;
      break;
    default:
      if (facts.request) {
        title = requestTitleText(facts.request.presentation);
        text = facts.request.kind;
      }
  }
  const maxChars =
    event.type === "tool.completed" && !facts.named
      ? Math.min(500, facts.maxChars)
      : facts.maxChars;
  return {
    itemId: event.sequence,
    type: event.type,
    status,
    runId: event.runId,
    title,
    ...itemText(text, maxChars, facts.offset),
    createdAt: event.createdAt,
  };
}

export function taskItem(summary: AssignmentSummary, result: string | null) {
  return {
    assignmentId: summary.id,
    threadId: summary.workerThread.id,
    runId: summary.currentRunId,
    runStatus: summary.currentRunStatus,
    status: summary.status,
    title: summary.workerThread.title,
    objective: summary.objectivePreview,
    result,
    pendingRequests: summary.workerThread.pendingRequests,
    parentThreadId: summary.parentThreadId,
    folder: summary.workerThread.folder,
    environmentId: summary.workerThread.environmentId,
    createdAt: summary.createdAt,
    finishedAt: summary.finishedAt,
  };
}
/** Always keeps the newest item, so paging advances; `itemText` bounds what that item can hold. */
export function boundedThreadItems<T>(items: readonly T[], maxBytes = 256 * 1024): T[] {
  let bytes = 2;
  const kept: T[] = [];
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (kept.length ? 1 : 0);
    if (kept.length && bytes + size > maxBytes) break;
    kept.push(item);
    bytes += size;
  }
  return kept;
}
