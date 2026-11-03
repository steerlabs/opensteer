import type { HostSnapshot, WorkspaceSummary } from "./client.js";
import type { TaskList, TaskRow } from "./task-list.js";

/**
 * The one thing a closed Project folder says about the work inside it, loudest
 * first: something needs the reader, something is working, something failed
 * unseen, or something new arrived. Null when there is nothing to say.
 */
export type ProjectFolderSignal = "needs-you" | "working" | "failed" | "unread" | null;

export interface ProjectFolder {
  readonly workspace: WorkspaceSummary;
  /** The Project's own chat, once the Host has one for it. */
  readonly chat: TaskRow | null;
  /** Its work under way and ready to read, as the reader's list orders it; never Done. */
  readonly rows: readonly TaskRow[];
  readonly signal: ProjectFolderSignal;
  /** How many of its rows, chat included, are waiting on the reader. */
  readonly needsYou: number;
}

export interface ProjectGrouping {
  /** The reader's own tasks: Main's, and any whose Workspace is not a listed Project. */
  readonly main: Pick<TaskList, "working" | "ready" | "done">;
  /** Every listed Project, in the Host's order, whether or not anything is under way in it. */
  readonly folders: readonly ProjectFolder[];
}

/**
 * The reader's task list split the way the navigator draws it: Main's tasks
 * first, then one folder per Project. Web and mobile both read this, so a
 * Project can never say "needs you" on one screen and nothing on another.
 */
export function groupTasksByProject(
  snapshot: Pick<HostSnapshot, "workspaces">,
  list: Pick<TaskList, "working" | "ready" | "done">,
): ProjectGrouping {
  const projects = snapshot.workspaces.filter((workspace) => workspace.kind === "project");
  const byId = new Map(projects.map((workspace) => [workspace.id, workspace]));
  const chats = new Set(
    projects.flatMap(({ homeThreadId }) => (homeThreadId ? [homeThreadId] : [])),
  );
  const inProject = (row: TaskRow) => byId.has(row.workspaceId);
  const rowsOf = new Map<string, TaskRow[]>();
  const chatOf = new Map<string, TaskRow>();
  // A Project's Done work lives on its own page; the folder holds what is under way.
  for (const row of [...list.working, ...list.ready]) {
    if (!inProject(row)) continue;
    if (chats.has(row.threadId)) {
      chatOf.set(row.workspaceId, row);
      continue;
    }
    const rows = rowsOf.get(row.workspaceId) ?? [];
    rows.push(row);
    rowsOf.set(row.workspaceId, rows);
  }
  return {
    main: {
      working: list.working.filter((row) => !inProject(row)),
      ready: list.ready.filter((row) => !inProject(row)),
      done: list.done.filter((row) => !inProject(row)),
    },

    folders: projects.map((workspace) => {
      const chat = chatOf.get(workspace.id) ?? null;
      const rows = rowsOf.get(workspace.id) ?? [];
      const all = chat ? [chat, ...rows] : rows;
      return {
        workspace,
        chat,
        rows,
        signal: folderSignal(all),
        needsYou: all.filter((row) => row.tone === "needs-you").length,
      };
    }),
  };
}

export function folderSignal(rows: readonly TaskRow[]): ProjectFolderSignal {
  if (rows.some((row) => row.tone === "needs-you")) return "needs-you";
  if (rows.some((row) => row.tone === "working")) return "working";
  if (rows.some((row) => row.tone === "failed" && row.unread)) return "failed";
  if (rows.some((row) => row.unread)) return "unread";
  return null;
}

/** The signal in words, for a folder's accessible name and tooltip. */
export function folderSignalWords(signal: ProjectFolderSignal, needsYou: number): string | null {
  switch (signal) {
    case "needs-you":
      return needsYou === 1 ? "1 task needs you" : `${needsYou} tasks need you`;
    case "working":
      return "Working";
    case "failed":
      return "A task failed";
    case "unread":
      return "New activity";
    case null:
      return null;
  }
}

/**
 * Why a Project cannot take new work right now, in a word or two, or null
 * when it can. The Project's own page says what to do about it.
 */
export function projectStatusLabel(
  workspace: Pick<WorkspaceSummary, "status" | "storageIssue">,
): string | null {
  const code = workspace.storageIssue?.code;
  if (code === "relocation-required") return "Folder needs moving";
  // Connectivity is not a fault with the folder: it comes back with its computer.
  if (code === "local-authority-unavailable") return "Computer offline";
  switch (workspace.status) {
    case "ready":
    case "deleted":
      return null;
    case "provisioning":
      return "Preparing";
    case "deleting":
      return "Scheduled for deletion";
    case "archiving":
    case "archived":
      return "Archived";
    case "unavailable":
      return "Unavailable";
    case "failed":
      return "Needs attention";
  }
}

/**
 * Where a Project's files are expected to go, read from the Host's
 * relocation notice ("Move this Project from A to B, then confirm …"). Null
 * when the notice names no paths, in which case the message is shown as is.
 */
export function relocationPaths(
  message: string,
): { readonly from: string; readonly to: string } | null {
  const match =
    /\bfrom (.+?) to (.+?), then confirm/su.exec(message) ??
    /^Move (?!this\b)(.+?) to (.+?)\.?$/su.exec(message.trim());
  if (!match) return null;
  const from = match[1]!.trim();
  const to = match[2]!.trim();
  return from && to ? { from, to } : null;
}
