import type { NeedsYouEntry, NeedsYouPage } from "@opensteer/protocol";
export function needsYouIndex(page: NeedsYouPage | null) {
  const byTask = new Map<string, Extract<NeedsYouPage["entries"][number], { kind: "request" }>[]>();
  for (const entry of page?.entries ?? []) {
    if (entry.kind !== "request") continue;
    const entries = byTask.get(entry.navigationThreadId) ?? [];
    byTask.set(entry.navigationThreadId, [...entries, entry]);
  }
  return {
    count: page?.count ?? 0,
    entries: page?.entries ?? [],
    byTask,
    hasMore: page?.window.hasMore ?? false,
  };
}

export function needsYouEntryKey(entry: NeedsYouEntry): string {
  return entry.kind === "request"
    ? `request:${entry.request.id}`
    : `team-ask:${entry.teamId}:${entry.requestId}`;
}
