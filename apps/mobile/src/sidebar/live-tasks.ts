import type { TaskList, TaskRow } from "@opensteer/client/host";

/** All tasks' filters, in the order its chips show them. */
export type AllTasksFilter = "all" | "needs-you" | "running" | "unread" | "read" | "done";

export const allTasksFilters: readonly { readonly id: AllTasksFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "unread", label: "Unread" },
  { id: "read", label: "Read" },
  { id: "done", label: "Done" },
];

/**
 * The drawer's live tasks, in the order a reader has to care: what needs them,
 * new results, then what is running. A finished task leaves once its result
 * is read (it stays in All tasks until Done); the one on screen stays put so
 * reading it never moves the row out from under the reader.
 */
export function liveTasks(
  list: TaskList,
  openThreadId: string | null,
): {
  readonly rows: readonly TaskRow[];
  readonly needsYou: number;
  /** Every task All tasks holds outside Done. */
  readonly total: number;
} {
  const needs = list.working.filter((row) => row.tone === "needs-you");
  const running = list.working.filter((row) => row.tone !== "needs-you");
  const results = list.ready.filter((row) => row.unread || row.threadId === openThreadId);
  return {
    rows: [...needs, ...results, ...running],
    needsYou: needs.length,
    total: list.working.length + list.ready.length,
  };
}

/** One filter of All tasks. */
export function allTasks(list: TaskList, filter: AllTasksFilter): readonly TaskRow[] {
  switch (filter) {
    case "all":
      return [...list.working, ...list.ready, ...list.done];
    case "needs-you":
      return list.working.filter((row) => row.tone === "needs-you");
    case "running":
      return list.working.filter((row) => row.tone !== "needs-you");
    case "unread":
      return [...list.working, ...list.ready].filter((row) => row.unread);
    case "read":
      return list.ready.filter((row) => !row.unread);
    case "done":
      return list.done;
  }
}
