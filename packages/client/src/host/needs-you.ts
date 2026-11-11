import type { NeedsYouPage } from "@opensteer/protocol";
export function needsYouIndex(page: NeedsYouPage | null) {
  const byTask = new Map<string, NeedsYouPage["entries"]>();
  for (const entry of page?.entries ?? []) {
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
