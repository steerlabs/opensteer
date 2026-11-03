import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "./client.js";
import { pluginSummaries, pluginVersionLabel, specialistPendingSummary } from "./plugins.js";
import { groupTasksByProject, relocationPaths } from "./project-folders.js";
import type { TaskRow } from "./task-list.js";

const main = workspace("wsp_main", "main");
const research = { ...workspace("wsp_research", "project"), homeThreadId: "thr_research_chat" };
const quiet = workspace("wsp_quiet", "project");

describe("groupTasksByProject", () => {
  it("keeps Main's tasks apart and bubbles a Project's loudest state to its folder", () => {
    const grouping = groupTasksByProject(
      { workspaces: [main, research, quiet] },
      {
        working: [row("thr_mine", main.id, "working"), row("thr_ask", research.id, "needs-you")],
        ready: [
          row("thr_research_chat", research.id, "finished", { unread: true }),
          row("thr_seen", research.id, "finished"),
        ],
        done: [row("thr_old", research.id, "finished", { done: true })],
      },
    );
    expect(grouping.main.working.map(({ threadId }) => threadId)).toEqual(["thr_mine"]);
    expect(grouping.main.done).toEqual([]);
    const [first, second] = grouping.folders;
    // Its chat is its own row, never one of its tasks; Done stays on its page.
    expect(first?.chat?.threadId).toBe("thr_research_chat");
    expect(first?.rows.map(({ threadId }) => threadId)).toEqual(["thr_ask", "thr_seen"]);
    expect(first?.signal).toBe("needs-you");
    expect(first?.needsYou).toBe(1);
    // A Project with nothing under way is still listed, and says nothing.
    expect(second).toMatchObject({ chat: null, rows: [], signal: null });
  });

  it("says working, then a failure, then news, when nothing needs the reader", () => {
    const signal = (rows: TaskRow[]) =>
      groupTasksByProject({ workspaces: [quiet] }, { working: [], ready: rows, done: [] })
        .folders[0]?.signal;
    expect(
      signal([row("a", quiet.id, "failed", { unread: true }), row("b", quiet.id, "working")]),
    ).toBe("working");
    expect(
      signal([
        row("a", quiet.id, "finished", { unread: true }),
        row("b", quiet.id, "failed", { unread: true }),
      ]),
    ).toBe("failed");
    expect(signal([row("a", quiet.id, "finished", { unread: true })])).toBe("unread");
  });
});

describe("relocationPaths", () => {
  it("reads both folders from the Host's notice, and nothing from one without them", () => {
    expect(
      relocationPaths(
        "Move this Project from /Users/me/Old to /Users/me/Main/Projects/research, then confirm “I moved it”.",
      ),
    ).toEqual({ from: "/Users/me/Old", to: "/Users/me/Main/Projects/research" });
    expect(
      relocationPaths(
        "Restore files from PortableFS service retired, volume vol-original to your Main directory/Projects/research, then confirm its location.",
      ),
    ).toEqual({
      from: "PortableFS service retired, volume vol-original",
      to: "your Main directory/Projects/research",
    });
    expect(relocationPaths("Move /old/project to /main/Projects/research")).toEqual({
      from: "/old/project",
      to: "/main/Projects/research",
    });
    expect(relocationPaths("Move this Workspace to a local directory before using it.")).toBe(null);
  });
});

describe("pluginSummaries", () => {
  it("reads the Host's rows, and skips one it cannot read", () => {
    const [plugin, ...rest] = pluginSummaries([
      {
        id: "plg_1",
        name: "tinycrm",
        scope: "deployment",
        workspaceId: null,
        source: { directory: "/opt/plugins/tinycrm" },
        currentVersionId: "v2",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        versions: [
          { id: "v1", digest: "aaaa", manifest: { name: "tinycrm", version: "1.0.0" } },
          {
            id: "v2",
            digest: "bbbbbbbbbbbb",
            manifest: { name: "tinycrm", description: "CRM notes", skills: [{}, {}] },
            specialistManifest: { version: 1 },
          },
        ],
        activations: [{ workspaceId: "wsp_main" }],
        servers: [{}],
      },
      { id: 3 },
    ]);
    expect(rest).toEqual([]);
    expect(plugin).toMatchObject({
      directory: "/opt/plugins/tinycrm",
      description: "CRM notes",
      specialist: true,
      skills: 2,
      servers: 1,
      activeIn: ["wsp_main"],
    });
    expect(pluginVersionLabel(plugin!)).toBe("Build bbbbbbbb");
    expect(pluginVersionLabel({ digest: "x", version: "v2.1.0" })).toBe("Version 2.1.0");
  });

  it("says what a pending specialist still needs", () => {
    const access = (state: "bound" | "choose" | "needs-access") => ({
      type: "phone" as const,
      level: "read" as const,
      reason: "Texts",
      binding: null,
      candidates: [],
      state,
    });
    expect(
      specialistPendingSummary({
        status: "pending",
        access: [access("choose"), access("needs-access"), access("needs-access")],
      }),
    ).toBe("1 choice to make, 2 need access");
    expect(specialistPendingSummary({ status: "ready", access: [access("bound")] })).toBe(null);
  });
});

function workspace(id: string, kind: "main" | "project"): WorkspaceSummary {
  return {
    homeThreadId: null,
    description: "",
    fileCount: 0,
    harnessLabel: "",
    id,
    kind,
    machineName: null,
    name: id,
    icon: null,
    runnerLabel: "",
    storageIssue: null,
    color: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "ready",
  };
}

function row(
  threadId: string,
  workspaceId: string,
  tone: TaskRow["tone"],
  extra: Partial<TaskRow> = {},
): TaskRow {
  return {
    threadId,
    workspaceId,
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
    ...extra,
  };
}
