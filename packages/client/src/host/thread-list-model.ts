import type { ThreadSummary, WorkspaceSummary } from "./client.js";
import { matchSearch, searchQuery, searchText, type SearchField } from "./search.js";
import type { TaskAttention } from "./task-list.js";

/**
 * How a list of Threads reads: which ones a query matches, and the times and
 * marks beside a row.
 *
 * It lives here rather than in either application because a phone and a
 * browser must fold the same Threads the same way — a row that says "2h" in
 * one and "2 hours ago" in the other is two products, not one.
 */

export function filterThreads(
  threads: readonly ThreadSummary[],
  workspaces: readonly WorkspaceSummary[],
  query: string,
  attention: readonly Pick<TaskAttention, "threadId" | "title">[],
): ThreadSummary[] {
  const listed = threads.filter((thread) => thread.listed);
  const words = searchQuery(query);
  if (words.length === 0) return listed;
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const asks = new Map(attention.map((ask) => [ask.threadId, ask.title]));
  return listed.filter(
    (thread) =>
      matchSearch(
        threadSearchFields(
          thread,
          workspaceNames.get(thread.workspaceId) ?? null,
          asks.get(thread.id) ?? null,
        ),
        words,
      ) !== null,
  );
}

/**
 * What a task is found by: its title most, then the question it is asking,
 * then where and how it runs.
 */
export function threadSearchFields(
  thread: Pick<ThreadSummary, "title" | "harnessLabel" | "runnerLabel">,
  workspaceName: string | null,
  ask: string | null = null,
): SearchField[] {
  return [
    { text: searchText(thread.title), weight: 1, inside: true, name: "title" },
    { text: searchText(ask ?? ""), weight: 0.7, name: "ask" },
    { text: searchText(workspaceName ?? ""), weight: 0.5, name: "workspace" },
    { text: searchText(thread.harnessLabel), weight: 0.4, name: "harness" },
    { text: searchText(thread.runnerLabel), weight: 0.4, name: "runner" },
  ];
}

export function formatRelativeTime(isoTimestamp: string, now = new Date()): string {
  const timestamp = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, now.getTime() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}

/** No Intl, no locale: HH:MM in the viewer's local timezone. Tests must assert
    the source timestamp, never this rendered text. */
export function formatClockTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** A Workspace's initials, which is what its identity mark carries. */
export function workspaceMonogram(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      // Code points, not UTF-16 units: an emoji or astral letter must not be
      // split into half a surrogate pair, which renders as a broken glyph.
      .map((part) => Array.from(part)[0]?.toLocaleUpperCase() ?? "")
      .join("")
  );
}
