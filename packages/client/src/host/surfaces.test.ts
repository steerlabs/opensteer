import { describe, expect, it } from "vitest";
import {
  BrowserSessionIdSchema,
  createId,
  SequenceSchema,
  TabAgentEventViewSchema,
  TabIdSchema,
  ThreadIdSchema,
  type Tab,
  type ThreadStatus,
} from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import type { HostSnapshot, PlaceEntry, TaskEntry } from "./client.js";
import {
  conversationSurfaces,
  liveWork,
  messagePages,
  placePage,
  replyPlaces,
  runPages,
  sameConversationSurfaceSource,
} from "./surfaces.js";
import { ThreadStateProjection } from "./thread-state.js";

const base = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const template = base.threads[0]!;
const threadId = (index: number) =>
  ThreadIdSchema.parse(`thr_00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`);
const tabId = (name: string) => TabIdSchema.parse(name);

function task(index: number, title: string, status: ThreadStatus): TaskEntry {
  return {
    failure: null,
    lastReply: null,
    thread: { ...template, id: threadId(index), status, title },
  };
}

/** A page tab at `site`, used by the given conversations. */
function page(name: string, site: string, usedBy: readonly string[] = []): Tab {
  return tabFixture({
    tabId: tabId(name),
    title: site,
    url: `https://${site}/`,
    usedBy: usedBy.map((taskId) => ({ taskId: ThreadIdSchema.parse(taskId) })),
  });
}

function snapshot(entries: readonly TaskEntry[], tabs: readonly Tab[]): HostSnapshot {
  return {
    ...base,
    activeTasks: [],
    assignments: {},
    tabs: tabStoreFixture(tabs),
    tasks: { entries, window: base.tasks!.window },
    waitingRequests: [],
  };
}

it("names a message page from its listed tab, and as it was sent once that tab closes", () => {
  const pages = [
    {
      type: "browser-page" as const,
      sessionId: BrowserSessionIdSchema.parse(
        `bsn_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`,
      ),
      tabId: tabId("tab-1"),
      documentId: "document",
      title: "Recorded title",
      url: "https://recorded.example/path",
    },
  ];
  expect(messagePages(pages, snapshot([], [page("tab-1", "current.example")]))[0]).toMatchObject({
    destination: { kind: "tab", tabId: "tab-1" },
    title: "current.example",
    site: "current.example",
    ended: false,
  });
  expect(messagePages(pages, snapshot([], []))[0]).toMatchObject({
    title: "Recorded title",
    site: "recorded.example",
    ended: true,
  });
});

describe("liveWork", () => {
  it("preserves idle surface ordering after a maintenance state event", () => {
    const projection = new ThreadStateProjection();
    const older = {
      ...task(1, "Older", "idle"),
      thread: { ...task(1, "Older", "idle").thread, updatedAt: "2026-01-01T00:00:00.000Z" },
    };
    const newer = {
      ...task(2, "Newer", "idle"),
      thread: { ...task(2, "Newer", "idle").thread, updatedAt: "2026-01-02T00:00:00.000Z" },
    };
    projection.record(
      TabAgentEventViewSchema.parse({
        eventId: createId("event"),
        type: "thread.state-changed",
        threadId: older.thread.id,
        environmentId: createId("environment"),
        runId: null,
        sequence: "2",
        createdAt: "2026-01-03T00:00:00.000Z",
        data: {
          status: "idle",
          inputQueuePaused: false,
          pendingRequests: 0,
          updatedAt: older.thread.updatedAt,
          returnHint: null,
        },
      }),
    );
    const projected = projection.reconcile(older.thread, SequenceSchema.parse("1"));
    expect(projected.updatedAt).toBe(older.thread.updatedAt);
    expect(
      liveWork(
        snapshot(
          [{ ...older, thread: projected }, newer],
          [page("a", "old.com", [threadId(1)]), page("b", "new.com", [threadId(2)])],
        ),
      ).map((group) => group.title),
    ).toEqual(["Newer", "Older"]);
  });

  it("keeps a finished task's open tab beside the work under way", () => {
    const groups = liveWork(
      snapshot(
        [task(1, "Flight award alerts", "running"), task(2, "Blue loveseat shortlist", "idle")],
        [page("a", "united.com", [threadId(1)]), page("b", "amazon.com", [threadId(2)])],
      ),
    );
    expect(groups.map(({ state, threadId, title }) => ({ state, threadId, title }))).toEqual([
      { state: "working", threadId: threadId(1), title: "Flight award alerts" },
      { state: "idle", threadId: threadId(2), title: "Blue loveseat shortlist" },
    ]);
  });

  it("lists a tab in use by a conversation this client has not read, and no unused tab", () => {
    const groups = liveWork(
      snapshot([], [page("a", "hyatt.com", [threadId(7)]), page("b", "example.com")]),
    );
    expect(
      groups.map(({ state, surfaces, threadId, title }) => ({
        sites: surfaces.map((item) => item.site),
        state,
        threadId,
        title,
      })),
    ).toEqual([{ sites: ["hyatt.com"], state: "idle", threadId: threadId(7), title: "hyatt.com" }]);
  });

  it("drops a conversation with nothing open once it is done", () => {
    expect(liveWork(snapshot([task(1, "Finished", "idle")], []))).toEqual([]);
  });
});

describe("a conversation's tabs", () => {
  it("lists every kind of tab its work uses in the person's order, a worker's included", () => {
    const worker = threadId(2);
    const source = {
      ...snapshot(
        [],
        [
          tabFixture({ tabId: tabId("phone"), kind: "phone", usedBy: [{ taskId: worker }] }),
          page("unused", "example.com"),
          page("page", "amazon.com", [threadId(1)]),
          tabFixture({ tabId: tabId("window"), kind: "window", usedBy: [{ taskId: threadId(1) }] }),
        ],
      ),
      assignments: {
        assignment: {
          status: "open",
          parentThreadId: threadId(1),
          workerThread: { id: worker },
        },
      } as unknown as HostSnapshot["assignments"],
    };
    expect(conversationSurfaces(source, threadId(1)).map((item) => item.key)).toEqual([
      "phone",
      "page",
      "window",
    ]);
    expect(conversationSurfaces(source, worker).map((item) => item.key)).toEqual(["phone"]);
    expect(sameConversationSurfaceSource(source, { ...source, browserProfiles: [] })).toBe(false);
    expect(sameConversationSurfaceSource(source, { ...source })).toBe(true);
  });
});

describe("a Run's pages", () => {
  const run = "run_00000000-0000-4000-8000-000000000001";
  const use = (tab: string, firstUsedAt: string, pageTitle: string | null = null) => ({
    sessionId: "bsn_session",
    threadId: threadId(1),
    runId: run,
    tabId: tab,
    firstUsedAt,
    lastUsedAt: firstUsedAt,
    pageTitle,
    pageSite: "https://recorded.example",
  });
  const stop = (overrides: Partial<PlaceEntry> = {}): PlaceEntry => ({
    kind: "place",
    id: "stop",
    createdAt: "2026-10-15T10:00:00Z",
    runId: run,
    tabId: tabId("tab-b"),
    title: "Recorded title",
    site: "https://recorded.example/path",
    ...overrides,
  });

  it("names a stop by its listed tab, and as recorded once that tab closes", () => {
    const listed = snapshot([], [page("tab-b", "wayfair.com")]);
    expect(placePage(stop(), listed)).toMatchObject({
      title: "wayfair.com",
      site: "wayfair.com",
      ended: false,
      destination: { kind: "tab", tabId: "tab-b" },
    });
    const closed = snapshot([], []);
    expect(placePage(stop(), closed)).toMatchObject({
      title: "Recorded title",
      site: "recorded.example",
      ended: true,
    });
    expect(placePage(stop({ title: "  " }), closed).title).toBe("recorded.example");
    expect(placePage(stop({ title: "", site: null }), closed).title).toBe("Tab");
  });

  it("lists each tab its Runs used once, by first use, keeping a closed one as recorded", () => {
    const pages = runPages(
      [
        use("tab-b", "2026-10-15T10:02:00.000Z"),
        use("tab-a", "2026-10-15T10:00:00.000Z"),
        use("tab-b", "2026-10-15T10:01:00.000Z"),
        use("tab-gone", "2026-10-15T10:03:00.000Z", "Recorded page"),
        { ...use("tab-other", "2026-10-15T10:04:00.000Z"), runId: "run-other" },
      ],
      snapshot([], [page("tab-a", "amazon.com"), page("tab-b", "wayfair.com")]),
      [run],
    );
    expect(pages.map(({ key, title, ended }) => [key, title, ended])).toEqual([
      ["tab-a", "amazon.com", false],
      ["tab-b", "wayfair.com", false],
      ["tab-gone", "Recorded page", true],
    ]);
  });
});

it("keeps one reply chip per tab, of its kind, from place entries and page usage together", () => {
  const runId = "run-example";
  const machineId = createId("runner");
  const source = snapshot(
    [],
    [
      page("page", "example.com"),
      tabFixture({
        tabId: tabId("window"),
        kind: "window",
        computer: { computerId: machineId, name: "Mac" },
      }),
      tabFixture({
        tabId: tabId("phone"),
        kind: "phone",
        computer: { computerId: machineId, name: "Pixel" },
      }),
    ],
  );
  const entry = (id: string, at: string): PlaceEntry => ({
    kind: "place",
    id,
    runId,
    createdAt: at,
    tabId: tabId(id),
    title: id,
    site: null,
  });
  const turn = {
    runId,
    work: [
      entry("page", "2026-11-02T13:00:00.000Z"),
      entry("window", "2026-11-02T13:00:01.000Z"),
      entry("phone", "2026-11-02T13:00:02.000Z"),
      entry("closed", "2026-11-02T13:00:03.000Z"),
    ],
  };
  const pageUse = {
    sessionId: "bsn_session",
    threadId: "thread-example",
    runId,
    tabId: "page",
    firstUsedAt: "2026-11-02T12:59:00.000Z",
    lastUsedAt: "2026-11-02T13:00:00.000Z",
  };
  const chips = replyPlaces(turn, [pageUse], source);
  expect(chips.map((chip) => chip.kind)).toEqual(["page", "app", "phone", "page"]);
  expect(
    chips.map((chip) =>
      chip.kind === "page"
        ? chip.page.ended
        : chip.kind === "app"
          ? chip.app.ended
          : chip.phone.ended,
    ),
  ).toEqual([false, false, false, true]);
});
