import {
  isPlaceContentPart,
  placeContentLabel,
  type AssignmentSummary,
  type Message,
} from "@opensteer/core";
import type { ThreadItem } from "@opensteer/agent-tools/outputs";

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
          : `[${part.type}]`,
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
    workspaceId: summary.workerThread.workspaceId,
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
