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
  return `request:${entry.request.id}`;
}

function needsYouOrder(entry: NeedsYouEntry): string {
  return `${entry.request.createdAt}:${entry.request.id}`;
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
