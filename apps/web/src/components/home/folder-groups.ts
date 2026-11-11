import type { TaskFolder } from "@opensteer/core";
import { taskFolderKey } from "@opensteer/client/host";
import type { FolderView } from "./home-models.js";

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
