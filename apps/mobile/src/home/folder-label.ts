import type { TaskFolder } from "@opensteer/core";

/** "Agent home" for the agent's own folder, else the folder's last path part. */
export function folderLabel(folder: TaskFolder | null, home: TaskFolder | null): string {
  if (folder === null) return "Agent home";
  if (home !== null && folder.computerId === home.computerId && folder.path === home.path)
    return "Agent home";
  return folder.path.split("/").filter(Boolean).at(-1) ?? folder.path;
}
