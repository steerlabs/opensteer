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

export function settleTeamAsk(
  page: NeedsYouPage | null,
  teamId: string,
  requestId: string,
): NeedsYouPage | null {
  if (!page) return page;
  const entries = page.entries.filter(
    (entry) =>
      entry.kind !== "team-ask" || entry.teamId !== teamId || entry.requestId !== requestId,
  );
  const removed = page.entries.length - entries.length;
  if (!removed) return page;
  return {
    ...page,
    entries,
    count: Math.max(0, page.count - removed),
    window: { ...page.window, totalItems: Math.max(0, page.window.totalItems - removed) },
  };
}

function needsYouOrder(entry: NeedsYouEntry): string {
  return entry.kind === "request"
    ? `${entry.request.createdAt}:${entry.request.id}`
    : `${entry.createdAt}:team:${entry.teamId}:${entry.requestId}`;
}

export async function refreshNeedsYou(
  loaded: NeedsYouPage | null,
  read: (before?: string) => Promise<NeedsYouPage>,
): Promise<NeedsYouPage> {
  const through = loaded?.entries.at(-1);
  let page = await read();
  const entries = new Map(page.entries.map((entry) => [needsYouEntryKey(entry), entry]));
  let byteCount = page.window.byteCount;
  while (
    through &&
    page.window.hasMore &&
    page.window.nextBefore &&
    page.entries.length &&
    needsYouOrder(page.entries.at(-1)!) > needsYouOrder(through)
  ) {
    page = await read(page.window.nextBefore);
    byteCount += page.window.byteCount;
    for (const entry of page.entries) entries.set(needsYouEntryKey(entry), entry);
  }
  return {
    ...page,
    entries: [...entries.values()],
    window: { ...page.window, byteCount, itemCount: entries.size },
  };
}
