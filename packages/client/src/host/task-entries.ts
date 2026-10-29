import type { TaskEntry } from "./client.js";

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
  return [...byId.values()].sort(
    (left, right) =>
      right.thread.updatedAt.localeCompare(left.thread.updatedAt) ||
      right.thread.id.localeCompare(left.thread.id),
  );
}
