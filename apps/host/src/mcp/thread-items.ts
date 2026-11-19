import {
  isPlaceContentPart,
  placeContentLabel,
  formatReferenceLink,
  type AssignmentSummary,
  type Message,
  type TeamSource,
} from "@opensteer/core";
import { toolMessageAuthor, type ThreadItem } from "@opensteer/agent-tools/outputs";
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
export function messageItem(
  message: Message,
  maxChars: number,
  offset = 0,
  teamSource?: TeamSource,
): ThreadItem {
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
    link: formatReferenceLink(message.id, "Message"),
    type: "message",
    status: "published",
    runId: message.runId,
    author: toolMessageAuthor(message.author),
    title: null,
    ...itemText(text, maxChars, offset),
    ...(places.length ? { places } : {}),
    ...(teamSource ? { teamSource } : {}),
    createdAt: message.createdAt,
  };
}
/**
 * Their text can hold a sign-in, a card, a webhook secret or typed values. Engines spell names their
 * own way, and stored history keeps the names tools had when it was recorded.
 */
export function withheldTool(name: string): boolean {
  return /(?:^|[_\s.:/-])(?:saved_login_request|chrome_cookies_request|card_request|opensteer_automation_create|opensteer_automation_update|computer_use|use_saved_login|copy_chrome_cookies|use_card|trigger_write|computer)(?:$|[\s.(])/u.test(
    name,
  );
}

export function activityItem(
  item: Exclude<AgentThreadActivityItem, { type: "message" }>,
  facts: { named: boolean; maxChars: number; offset?: number | undefined },
): ThreadItem {
  const tool = item.type === "tool.started" || item.type === "tool.completed";
  const title =
    item.type === "place.entered" ? item.place.title : "title" in item ? item.title : null;
  const status =
    "status" in item
      ? item.status
      : item.type === "node.message"
        ? "published"
        : item.type.split(".")[1]!;
  const text =
    item.type === "place.entered"
      ? item.place.site
      : "requestKind" in item
        ? item.requestKind
        : "text" in item && (!tool || (title && !withheldTool(title)))
          ? item.text
          : null;
  return {
    itemId: item.id,
    ...("requestId" in item ? { link: formatReferenceLink(item.requestId, item.title) } : {}),
    type: item.type,
    status,
    runId: item.runId,
    title,
    ...itemText(
      text,
      tool && !facts.named ? Math.min(500, facts.maxChars) : facts.maxChars,
      facts.offset,
    ),
    createdAt: item.createdAt,
  };
}

export function taskItem(summary: AssignmentSummary, result: string | null) {
  return {
    assignmentId: summary.id,
    link: formatReferenceLink(summary.workerThread.id, summary.workerThread.title),
    threadId: summary.workerThread.id,
    runId: summary.currentRunId,
    runStatus: summary.currentRunStatus,
    status: summary.status,
    title: summary.workerThread.title,
    objective: summary.objectivePreview,
    result,
    pendingRequests: summary.workerThread.pendingRequests,
    parentThreadId: summary.parentThreadId,
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
