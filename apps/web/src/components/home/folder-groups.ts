import type { TaskFolder } from "@opensteer/core";
import { taskFolderKey, type TaskRow } from "@opensteer/client/host";
import type { FolderSignal, FolderView } from "./home-models.js";

/** Home's Done opens the sidebar's Done list, which owns it. */
export const showDoneEvent = "opensteer:show-done";

/** Open tasks a folder shows before "N more". */
export const folderRowLimit = 5;

export interface FolderRows<Row extends Pick<TaskRow, "folder" | "askedAt">> {
  readonly folder: FolderView;
  readonly value: TaskFolder;
  readonly rows: readonly Row[];
}

/** `~/…` for a path under the home folder the agent's own folder sits in. */
export function shortPath(path: string, agentHome: TaskFolder | null): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const home = agentHome ? agentHome.path.slice(0, agentHome.path.lastIndexOf(separator)) : "";
  return home && (path === home || path.startsWith(home + separator))
    ? `~${path.slice(home.length)}`
    : path;
}

export function folderView(
  folder: TaskFolder,
  agentHome: TaskFolder | null,
  computerName: (computerId: string) => string,
): FolderView {
  const home = agentHome !== null && taskFolderKey(folder) === taskFolderKey(agentHome);
  const parts = folder.path.split(/[\\/]/u).filter(Boolean);
  return {
    id: taskFolderKey(folder),
    label: home ? "Agent home" : (parts.at(-1) ?? folder.path),
    path: shortPath(folder.path, agentHome),
    computerName: computerName(folder.computerId),
    agentHome: home,
  };
}

/**
 * Tasks by folder: Agent home first, then by most recent ask. Agent home is
 * always there, even empty, so a first task has somewhere to land.
 */
export function groupByFolder<Row extends Pick<TaskRow, "folder" | "askedAt">>(
  rows: readonly Row[],
  agentHome: TaskFolder | null,
  computerName: (computerId: string) => string,
): FolderRows<Row>[] {
  const groups = new Map<string, { value: TaskFolder; rows: Row[]; latest: string }>();
  if (agentHome) groups.set(taskFolderKey(agentHome), { value: agentHome, rows: [], latest: "" });
  for (const row of rows) {
    const key = taskFolderKey(row.folder);
    const group = groups.get(key) ?? { value: row.folder, rows: [], latest: "" };
    group.rows.push(row);
    if (row.askedAt > group.latest) group.latest = row.askedAt;
    groups.set(key, group);
  }
  const homeKey = agentHome ? taskFolderKey(agentHome) : null;
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) =>
      leftKey === homeKey ? -1 : rightKey === homeKey ? 1 : right.latest.localeCompare(left.latest),
    )
    .map(([, group]) => ({
      folder: folderView(group.value, agentHome, computerName),
      value: group.value,
      rows: group.rows,
    }));
}

/** The loudest thing a folded folder holds: an ask, then work, then a failure, then unread. */
export function folderSignal(
  rows: readonly Pick<TaskRow, "tone" | "unread">[],
): { readonly signal: FolderSignal; readonly needsYou: number } {
  const needsYou = rows.filter((row) => row.tone === "needs-you").length;
  const signal: FolderSignal =
    needsYou > 0
      ? "needs-you"
      : rows.some((row) => row.tone === "working")
        ? "working"
        : rows.some((row) => row.tone === "failed")
          ? "failed"
          : rows.some((row) => row.unread)
            ? "unread"
            : null;
  return { signal, needsYou };
}
