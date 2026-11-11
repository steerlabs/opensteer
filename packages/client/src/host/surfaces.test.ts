import { browserStoreFixture, replaceBrowserTabs } from "../test-support/browser-snapshot.js";
import type {
  BrowserGroupRow,
  BrowserTabRow,
  BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";
import { describe, expect, it } from "vitest";
import {
  BrowserSessionIdSchema,
  createId,
  BrowserSurfaceIdSchema,
  ThreadIdSchema,
  type ThreadStatus,
} from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { BrowserSessionSummary, HostSnapshot, PlaceEntry, TaskEntry } from "./client.js";
import {
  conversationSurfaces,
  sameConversationSurfaceSource,
  surfaceDestination,
  liveWork,
  runPages,
  placePage,
  messagePages,
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

function bind(
  session: BrowserSessionSummary,
  rows: readonly BrowserTabRow[],
  complete = true,
  viewer: (id: string) => BrowserViewerSurface | undefined = () => undefined,
): BrowserSessionSummary {
  return {
    ...session,
    browserTabs: browserStoreFixture(
      [
        {
          id: session.id,
          sessionId: session.id,
          createdAt: session.createdAt ?? "",
          state: session.state,
        } as BrowserGroupRow,
      ],
      [
        {
          groupId: session.id,
          rows: rows.map((row) => ({
            ...row,
            sessionId: BrowserSessionIdSchema.parse(session.id),
          })),
          complete,
        },
      ],
      (_session, id) => viewer(id),
    ),
  };
}
function rows(session: BrowserSessionSummary) {
  return session.browserTabs!.sessionTabs(session.id);
}
function replace(session: BrowserSessionSummary, next: readonly BrowserTabRow[]) {
  replaceBrowserTabs(session.browserTabs!, session.id, next);
}
function browser(
  index: number,
  page: string,
  usedBy: readonly string[],
  state: BrowserSessionSummary["state"] = "ready",
): BrowserSessionSummary {
  const session: BrowserSessionSummary = {
    access: "read-write",
    attachedRunIds: [],
    dialog: null,
    error: null,
    id: `bsn_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    origin: "agent",
    placement: { kind: "runner", runnerId: "rnr_11111111-1111-4111-8111-111111111111" },
    profileId: null,
    runtimeId: "runtime",
    state,
    tabs: [],
    threadIds: usedBy,
    viewerError: null,
    viewerState: "synchronized",
    workspaceId: template.workspaceId,
  };
  return bind(session, [
    {
      id: BrowserSurfaceIdSchema.parse(`tab-${index}`),
      sessionId: BrowserSessionIdSchema.parse(session.id),
      title: page,
      site: `https://${page}`,
      order: 0,
      openerId: null,
      createdAt: "",
      state: "live",
      iconRef: null,
      documentId: "document",
      availability: "ready",
      loading: false,
      navigationFailed: false,
      canGoBack: false,
      canGoForward: false,
      occupants: [],
    },
  ]);
}

function snapshot(
  entries: readonly TaskEntry[],
  browserSessions: readonly BrowserSessionSummary[],
): HostSnapshot {
  return {
    ...base,
    activeTasks: [],
    assignments: {},
    browserSessions: browserSessions.map((session) =>
      session.browserTabs?.groupForSession(session.id)
        ? session
        : bind(
            session,
            session.browserTabs
              ?.groups()
              .ids.flatMap((id) =>
                session.browserTabs!.sessionTabs(session.browserTabs!.group(id)!.sessionId),
              ) ?? [],
            true,
            (id) =>
              session.browserTabs?.surface(
                session.browserTabs.group(session.browserTabs.groups().ids[0]!)!.sessionId,
                id,
              ),
          ),
    ),
    machines: [],
    tasks: { entries, window: base.workspaceWindow },
    waitingRequests: [],
  };
}

it("names an unviewed message page from its current keyed row, retaining the recorded page after the browser ends", () => {
  const session = browser(1, "current.example", []);
  const pages = [
    {
      type: "browser-page" as const,
      sessionId: BrowserSessionIdSchema.parse(session.id),
      tabId: BrowserSurfaceIdSchema.parse("tab-1"),
      documentId: "document",
      title: "Recorded title",
      url: "https://recorded.example",
    },
  ];
  expect(messagePages(pages, [session])[0]).toMatchObject({
    title: "current.example",
    site: "current.example",
    favicon: null,
    ended: false,
  });
  expect(messagePages(pages, [{ ...session, state: "closed" }])[0]).toMatchObject({
    title: "Recorded title",
    site: "recorded.example",
    ended: true,
  });
});

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
  const twoTabs = (state: BrowserSessionSummary["state"]): BrowserSessionSummary => {
    const session = {
      ...browser(1, "amazon.com", [threadId(1)], state),
      acting: true,
      attachedRunIds: [run],
    };
    return bind(
      session,
      ["tab-a", "tab-b"].map((id, order) => ({
        ...rows(session)[0]!,
        id: BrowserSurfaceIdSchema.parse(id),
        order,
        title: order === 0 ? "Amazon" : "Wayfair",
        site: order === 0 ? "https://amazon.com" : "https://wayfair.com",
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
      true,
      (id) => ({
        id: BrowserSurfaceIdSchema.parse(id),
        state: "live",
        title: id === "tab-a" ? "Amazon" : "Wayfair",
        url: id === "tab-a" ? "https://amazon.com/" : "https://wayfair.com/",
        favicon: id === "tab-a" ? icon : null,
        documentId: "document",
        geometryRevision: 1,
        loading: false,
        navigationFailed: false,
        sizedByAgent: false,
      }),
    );
  };

  const uses = [
    {
      sessionId: browser(1, "", []).id,
      firstUsedAt: "2026-10-15T10:00:00.000Z",
      lastUsedAt: "2026-10-15T10:01:00.000Z",
      runId: run,
      tabId: "tab-a",
      threadId: threadId(1),
    },
    {
      sessionId: browser(1, "", []).id,
      firstUsedAt: "2026-10-15T10:02:00.000Z",
      lastUsedAt: "2026-10-15T10:03:00.000Z",
      runId: run,
      tabId: "tab-b",
      threadId: threadId(1),
    },
  ];
  const stop = (overrides: Partial<PlaceEntry> = {}): PlaceEntry => ({
    kind: "place",
    id: "stop",
    createdAt: "2026-10-15T10:00:00Z",
    runId: run,
    place: {
      kind: "browser",
      sessionId: BrowserSessionIdSchema.parse(twoTabs("ready").id),
      surfaceId: BrowserSurfaceIdSchema.parse("tab-b"),
    },
    title: "Recorded title",
    site: "https://recorded.example/path",
    ...overrides,
  });

  it("resolves an exact stop with recorded identity and activity for only its run and thread", () => {
    const session = twoTabs("ready");
    expect(placePage(stop(), [session], threadId(1))).toMatchObject({
      title: "Recorded title",
      site: "recorded.example",
      acting: true,
      ended: false,
      destination: { kind: "browser", sessionId: session.id, tabId: "tab-b" },
    });
    expect(placePage(stop({ runId: "other-run" }), [session], threadId(1))?.acting).toBe(false);
    expect(placePage(stop(), [session], threadId(2))?.acting).toBe(false);
    const a = stop({
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(session.id),
        surfaceId: BrowserSurfaceIdSchema.parse("tab-a"),
      },
    });
    expect(placePage(a, [session], threadId(1))).toMatchObject({ favicon: icon, acting: false });
  });

  it.each(["closed", "failed", "missing", "tab-closed"] as const)(
    "ends a stop when %s",
    (state) => {
      const session = twoTabs(state === "closed" || state === "failed" ? state : "ready");
      if (state === "tab-closed") replace(session, []);
      expect(placePage(stop(), state === "missing" ? [] : [session], threadId(1))).toMatchObject({
        ended: true,
        acting: false,
        favicon: null,
        title: "Recorded title",
      });
    },
  );

  it("falls back from a blank title to its recorded site then Page, and ignores unknown kinds", () => {
    expect(placePage(stop({ title: "  " }), [], null)?.title).toBe("recorded.example");
    expect(placePage(stop({ title: "", site: null }), [], null)?.title).toBe("Page");
    expect(
      placePage(stop({ place: { kind: "future" } as unknown as PlaceEntry["place"] }), [], null),
    ).toBeNull();
  });

  it("lists every page in tab order with exact activity, identity and destination", () => {
    const first = twoTabs("ready");
    const second = {
      ...first,
      id: "bsn_00000000-0000-4000-8000-000000000002",
      createdAt: "2026-10-16",
      profileId: "profile-work",
    };
    const source = snapshot([], [second, { ...first, createdAt: "2026-10-15" }]);
    const pages = conversationSurfaces(source, threadId(1));
    expect(pages.map((page) => page.key)).toEqual([
      `browser:${first.id}:tab-a`,
      `browser:${first.id}:tab-b`,
      "browser:bsn_00000000-0000-4000-8000-000000000002:tab-a",
      "browser:bsn_00000000-0000-4000-8000-000000000002:tab-b",
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
    const a = rows(original)[0]!;
    const b = rows(original)[1]!;
    const popup = { ...b, id: BrowserSurfaceIdSchema.parse("popup"), order: 2, openerId: a.id };
    replace(original, [b, popup, a]);
    const source = snapshot([], [original]);
    expect(
      conversationSurfaces(source, threadId(1))
        .map(surfaceDestination)
        .map((page) => page.kind === "browser" && page.tabId),
    ).toEqual(["tab-a", "popup", "tab-b"]);
    replace(original, []);
    expect(conversationSurfaces(source, threadId(1))).toEqual([]);
  });

  it("keeps a Run's recorded page when its session has no live row", () => {
    const sessionId = twoTabs("ready").id;
    expect(
      runPages(
        [
          {
            sessionId,
            threadId: threadId(1),
            runId: run,
            tabId: "tab-ended",
            firstUsedAt: "2026-10-15T10:00:00.000Z",
            lastUsedAt: "2026-10-15T10:01:00.000Z",
            pageTitle: "Recorded page",
            pageSite: "https://recorded.example",
          },
        ],
        [],
        [run],
      ),
    ).toEqual([
      {
        key: `${sessionId}:tab-ended`,
        destination: { kind: "browser", sessionId, tabId: "tab-ended" },
        title: "Recorded page",
        site: "recorded.example",
        ended: true,
        acting: false,
        favicon: null,
      },
    ]);
  });

  it("keeps a missing tab open until the session's list is whole", () => {
    const session = twoTabs("ready");
    const prefix = bind(session, [], false);
    expect(runPages(uses, [prefix], [run]).every((page) => !page.ended)).toBe(true);
    expect(runPages(uses, [bind(session, [])], [run]).every((page) => page.ended)).toBe(true);
  });

  it("marks only the tab the agent is in, not every page of its browser", () => {
    expect(
      runPages(uses, [twoTabs("ready")], [run]).map(({ acting, title }) => ({ acting, title })),
    ).toEqual([
      { acting: false, title: "Amazon" },
      { acting: true, title: "Wayfair" },
    ]);
  });

  it("carries each open tab's site icon, and none once its browser is gone", () => {
    expect(runPages(uses, [twoTabs("ready")], [run]).map((page) => page.favicon)).toEqual([
      icon,
      null,
    ]);
    const closed = runPages(uses, [twoTabs("closed")], [run]);
    expect(closed.map((page) => page.favicon)).toEqual([null, null]);
    expect(closed.every((page) => !page.acting)).toBe(true);
  });
});

it("keeps reply chips from place entries alone, unioned with browser usage and native tool traces", async () => {
  const { replyPlaces } = await import("./surfaces.js");
  const runId = "run-example";
  const places: PlaceEntry[] = [
    {
      kind: "place",
      id: "page",
      runId,
      createdAt: "2026-11-02T13:00:00.000Z",
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(browser(1, "example.com", []).id),
        surfaceId: BrowserSurfaceIdSchema.parse("tab-1"),
      },
      title: "Browser",
      site: "https://example.com",
    },
    {
      kind: "place",
      id: "app",
      runId,
      createdAt: "2026-11-02T13:00:01.000Z",
      place: {
        kind: "app",
        machineId: createId("runner"),
        appKey: "com.apple.notes",
      },
      title: "Notes",
      site: null,
    },
    {
      kind: "place",
      id: "phone",
      runId,
      createdAt: "2026-11-02T13:00:02.000Z",
      place: {
        kind: "phone",
        machineId: createId("runner"),
        display: "main",
      },
      title: "Phone",
      site: null,
    },
  ];
  const turn = { runId, work: places, subagentWork: {} };
  const chips = replyPlaces(turn, [], [], []);
  expect(chips.map((chip) => chip.kind)).toEqual(["page", "app", "phone"]);
  expect(
    chips.every((chip) =>
      chip.kind === "page"
        ? chip.page.ended
        : chip.kind === "app"
          ? chip.app.ended
          : chip.phone.ended,
    ),
  ).toBe(true);
  const session = browser(1, "example.com", []);
  const browserUses = [
    {
      sessionId: session.id,
      threadId: "thread-example",
      runId,
      tabId: "tab-1",
      firstUsedAt: places[0]!.createdAt,
      lastUsedAt: places[0]!.createdAt,
      pageTitle: "Browser",
      pageSite: "https://example.com",
    },
  ];
  expect(replyPlaces(turn, browserUses, [session], [])).toHaveLength(3);
});
