import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema, ThreadIdSchema, type ThreadStatus } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { BrowserSessionSummary, HostSnapshot, TaskEntry } from "./client.js";
import {
  conversationSurfaces,
  sameConversationSurfaceSource,
  surfaceDestination,
  liveWork,
  runPages,
} from "./surfaces.js";

const base = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const template = base.threads[0]!;
const threadId = (index: number) =>
  `thr_00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`;

function task(index: number, title: string, status: ThreadStatus): TaskEntry {
  return {
    failure: null,
    lastReply: null,
    thread: { ...template, id: threadId(index), status, title },
  };
}

function browser(
  index: number,
  page: string,
  usedBy: readonly string[],
  state: BrowserSessionSummary["state"] = "ready",
): BrowserSessionSummary {
  return {
    access: "full-control",
    attachedRunIds: [],
    dialog: null,
    error: null,
    id: `bsn_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    origin: "agent",
    placement: { kind: "runner", runnerId: "rnr_11111111-1111-4111-8111-111111111111" },
    profileId: null,
    runtimeId: "runtime",
    state,
    tabs: [
      {
        active: true,
        id: BrowserSurfaceIdSchema.parse(`tab-${index}`),
        title: page,
        url: `https://${page}/`,
      },
    ],
    threadIds: usedBy,
    viewerError: null,
    viewerState: "synchronized",
    workspaceId: template.workspaceId,
  };
}

function snapshot(
  entries: readonly TaskEntry[],
  browserSessions: readonly BrowserSessionSummary[],
): HostSnapshot {
  return {
    ...base,
    activeTasks: [],
    assignments: {},
    browserSessions: [...browserSessions],
    machines: [],
    tasks: { entries, window: base.workspaceWindow },
    waitingRequests: [],
  };
}

describe("liveWork", () => {
  it("keeps a finished task's open browser, as still open, beside the work under way", () => {
    const groups = liveWork(
      snapshot(
        [task(1, "Flight award alerts", "running"), task(2, "Blue loveseat shortlist", "idle")],
        [browser(1, "united.com", [threadId(1)]), browser(2, "amazon.com", [threadId(2)])],
      ),
    );
    expect(groups.map(({ state, threadId, title }) => ({ state, threadId, title }))).toEqual([
      { state: "working", threadId: threadId(1), title: "Flight award alerts" },
      { state: "idle", threadId: threadId(2), title: "Blue loveseat shortlist" },
    ]);
  });

  it("lists every open browser, even one whose conversation this client has not read", () => {
    const groups = liveWork(
      snapshot(
        [],
        [
          browser(1, "hyatt.com", [threadId(7)]),
          browser(2, "example.com", []),
          browser(3, "closed.com", [threadId(8)], "closed"),
        ],
      ),
    );
    expect(
      groups.map(({ state, surfaces, threadId, title }) => ({
        sites: surfaces.map((item) => (item.kind === "browser" ? item.site : null)),
        state,
        threadId,
        title,
      })),
    ).toEqual([
      // Opens the conversation that used it, named by its page until that is read.
      { sites: ["hyatt.com"], state: "idle", threadId: threadId(7), title: "hyatt.com" },
      // No conversation uses it: it can only be closed from here.
      { sites: ["example.com"], state: "idle", threadId: null, title: "example.com" },
    ]);
  });

  it("drops a conversation with nothing open once it is done", () => {
    expect(liveWork(snapshot([task(1, "Finished", "idle")], []))).toEqual([]);
  });
});

describe("runPages", () => {
  const run = "run_00000000-0000-4000-8000-000000000001";
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const twoTabs = (state: BrowserSessionSummary["state"]): BrowserSessionSummary => ({
    ...browser(1, "amazon.com", [threadId(1)], state),
    acting: true,
    attachedRunIds: [run],
    tabCatalog: {
      generation: 1,
      revision: 1,
      tabs: ["tab-a", "tab-b"].map((id, order) => ({
        id: BrowserSurfaceIdSchema.parse(id),
        title: order === 0 ? "Amazon" : "Wayfair",
        site: order === 0 ? "https://amazon.com" : "https://wayfair.com",
        iconRef: null,
        order,
        openerId: null,
        availability: "ready" as const,
        documentId: null,
        occupants:
          order === 0
            ? []
            : [
                {
                  threadId: ThreadIdSchema.parse(threadId(1)),
                  home: false,
                  holding: true,
                  acting: true,
                  lastActiveAt: "2026-10-15T10:03:00.000Z",
                },
              ],
      })),
    },
    tabs: [
      {
        active: false,
        favicon: icon,
        id: BrowserSurfaceIdSchema.parse("tab-a"),
        title: "Amazon",
        url: "https://amazon.com/",
      },
      {
        active: true,
        id: BrowserSurfaceIdSchema.parse("tab-b"),
        title: "Wayfair",
        url: "https://wayfair.com/",
      },
    ],
    uses: [
      {
        firstUsedAt: "2026-10-15T10:00:00.000Z",
        lastUsedAt: "2026-10-15T10:01:00.000Z",
        runId: run,
        tabId: "tab-a",
        threadId: threadId(1),
      },
      {
        firstUsedAt: "2026-10-15T10:02:00.000Z",
        lastUsedAt: "2026-10-15T10:03:00.000Z",
        runId: run,
        tabId: "tab-b",
        threadId: threadId(1),
      },
    ],
  });

  it("lists every page in tab order with exact activity, identity and destination", () => {
    const first = twoTabs("ready");
    const second = {
      ...first,
      id: "second-session",
      createdAt: "2026-10-16",
      profileId: "profile-work",
    };
    const source = snapshot([], [second, { ...first, createdAt: "2026-10-15" }]);
    const pages = conversationSurfaces(source, threadId(1));
    expect(pages.map((page) => page.key)).toEqual([
      `browser:${first.id}:tab-a`,
      `browser:${first.id}:tab-b`,
      "browser:second-session:tab-a",
      "browser:second-session:tab-b",
    ]);
    expect(pages.map((page) => page.acting)).toEqual([false, true, false, true]);
    expect(pages.map(surfaceDestination)).toEqual([
      { kind: "browser", sessionId: first.id, tabId: "tab-a" },
      { kind: "browser", sessionId: first.id, tabId: "tab-b" },
      { kind: "browser", sessionId: second.id, tabId: "tab-a" },
      { kind: "browser", sessionId: second.id, tabId: "tab-b" },
    ]);
    expect(pages[0]).toMatchObject({
      identity: { kind: "guest", name: "Guest" },
      title: "Amazon",
      site: "amazon.com",
      favicon: icon,
    });
    expect(pages[2]).toMatchObject({ identity: { kind: "profile", profileId: "profile-work" } });
    expect(sameConversationSurfaceSource(source, { ...source, browserProfiles: [] })).toBe(false);
  });

  it("keeps popup pages beside their opener and trusts catalog removal over stale viewer tabs", () => {
    const original = twoTabs("ready");
    const a = original.tabCatalog!.tabs[0]!;
    const b = original.tabCatalog!.tabs[1]!;
    const popup = { ...b, id: BrowserSurfaceIdSchema.parse("popup"), order: 2, openerId: a.id };
    const source = snapshot(
      [],
      [{ ...original, tabCatalog: { ...original.tabCatalog!, tabs: [b, popup, a] } }],
    );
    expect(
      conversationSurfaces(source, threadId(1))
        .map(surfaceDestination)
        .map((page) => page.kind === "browser" && page.tabId),
    ).toEqual(["tab-a", "popup", "tab-b"]);
    source.browserSessions = [{ ...original, tabCatalog: { ...original.tabCatalog!, tabs: [] } }];
    expect(conversationSurfaces(source, threadId(1))).toEqual([]);
  });

  it("marks only the tab the agent is in, not every page of its browser", () => {
    expect(
      runPages([twoTabs("ready")], [run]).map(({ acting, title }) => ({ acting, title })),
    ).toEqual([
      { acting: false, title: "Amazon" },
      { acting: true, title: "Wayfair" },
    ]);
  });

  it("carries each open tab's site icon, and none once its browser is gone", () => {
    expect(runPages([twoTabs("ready")], [run]).map((page) => page.favicon)).toEqual([icon, null]);
    const closed = runPages([twoTabs("closed")], [run]);
    expect(closed.map((page) => page.favicon)).toEqual([null, null]);
    expect(closed.every((page) => !page.acting)).toBe(true);
  });
});
