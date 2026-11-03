import type { ProjectFolder, TaskRow } from "@opensteer/client/host";

/** How many of a folder's tasks show before the rest are left to the Project's page. */
export const folderRowLimit = 5;

/** One Project's folder as the sidebar draws it now. */
export interface SidebarFolder {
  readonly folder: ProjectFolder;
  readonly open: boolean;
  /** Its chat, while the folder is open. */
  readonly chat: TaskRow | null;
  /** Its tasks shown, while the folder is open. */
  readonly shown: readonly TaskRow[];
  /** Tasks past the limit, reached on the Project's page. */
  readonly more: number;
  /** Whether it has anything to fold away at all. */
  readonly foldable: boolean;
  /** Folded, the conversation on screen is one of its rows. */
  readonly holdsOpenRow: boolean;
}

/**
 * The folders the shared grouping produced, each open unless the reader
 * folded it. A folded folder still carries its signal, so closing it never
 * hides a question; the shell keeps `closed` across the drawer and the docked
 * column.
 */
export function sidebarFolders(
  folders: readonly ProjectFolder[],
  closed: ReadonlySet<string>,
  openRowThreadId: string | null,
): SidebarFolder[] {
  return folders.map((folder) => {
    const open = !closed.has(folder.workspace.id);
    const shown = open ? folder.rows.slice(0, folderRowLimit) : [];
    return {
      folder,
      open,
      chat: open ? folder.chat : null,
      shown,
      more: open ? folder.rows.length - shown.length : 0,
      foldable: folder.chat !== null || folder.rows.length > 0,
      holdsOpenRow:
        !open &&
        openRowThreadId !== null &&
        (folder.chat?.threadId === openRowThreadId ||
          folder.rows.some((row) => row.threadId === openRowThreadId)),
    };
  });
}
