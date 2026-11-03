import { describe, expect, it } from "vitest";
import { groupTasksByProject, type TaskRow, type WorkspaceSummary } from "@opensteer/client/host";
import { folderRowLimit, sidebarFolders } from "./project-folders.js";

const research: WorkspaceSummary = {
  homeThreadId: "thr_chat",
  description: "",
  fileCount: 0,
  harnessLabel: "",
  id: "wsp_research",
  kind: "project",
  machineName: null,
  name: "Research",
  icon: null,
  runnerLabel: "",
  storageIssue: null,
  color: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  status: "ready",
};

function row(threadId: string, tone: TaskRow["tone"]): TaskRow {
  return {
    threadId,
    workspaceId: research.id,
    title: threadId,
    icon: null,
    color: null,
    tone,
    line: "",
    place: null,
    unread: false,
    stopped: tone !== "working" && tone !== "needs-you",
    done: false,
    canBeDone: true,
    askedAt: "2026-10-01T00:00:00.000Z",
  };
}

const tasks = Array.from({ length: folderRowLimit + 2 }, (_, index) =>
  row(`thr_${index}`, index === folderRowLimit + 1 ? "needs-you" : "finished"),
);
const folders = groupTasksByProject(
  { workspaces: [research] },
  { working: [], ready: [row("thr_chat", "finished"), ...tasks], done: [] },
).folders;

describe("sidebar Project folders", () => {
  it("shows the chat and the first tasks of an open folder, and counts the rest", () => {
    const [folder] = sidebarFolders(folders, new Set(), null);
    expect(folder?.chat?.threadId).toBe("thr_chat");
    expect(folder?.shown).toHaveLength(folderRowLimit);
    expect(folder?.more).toBe(2);
  });

  it("folded, hides its rows but keeps what needs the reader and the open conversation", () => {
    const [folder] = sidebarFolders(folders, new Set([research.id]), `thr_${folderRowLimit + 1}`);
    expect(folder).toMatchObject({ chat: null, shown: [], more: 0, open: false });
    // A question past the limit still reaches the folded folder's signal.
    expect(folder?.folder.signal).toBe("needs-you");
    expect(folder?.holdsOpenRow).toBe(true);
  });

  it("has nothing to fold for a Project with no chat or work under way", () => {
    const idle = groupTasksByProject(
      { workspaces: [{ ...research, homeThreadId: null }] },
      { working: [], ready: [], done: [] },
    ).folders;
    expect(sidebarFolders(idle, new Set(), null)[0]?.foldable).toBe(false);
  });
});
