import type { TaskEntry } from "./client.js";

/** Newest person request first, with a stable tie break shared by pages and rows. */
export function compareTaskOrder(
  left: { readonly askedAt: string; readonly id: string },
  right: { readonly askedAt: string; readonly id: string },
): number {
  return right.askedAt.localeCompare(left.askedAt) || right.id.localeCompare(left.id);
}

/** History and active pages can overlap; the freshest entry owns each task's row. */
export function mergeTaskEntries(...pages: readonly (readonly TaskEntry[])[]): TaskEntry[] {
  const byId = new Map<string, TaskEntry>();
  for (const page of pages) {
    for (const entry of page) {
      const current = byId.get(entry.thread.id);
      if (!current || current.thread.updatedAt <= entry.thread.updatedAt)
        byId.set(entry.thread.id, entry);
    }
  }
  return [...byId.values()].sort((left, right) => compareTaskOrder(left.thread, right.thread));
}
