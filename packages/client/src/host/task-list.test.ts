import { describe, expect, it } from "vitest";
import {
  ThreadReadStateSchema,
  WaitingRequestSchema,
  type ThreadStatus,
  type WaitingRequest,
} from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { BrowserSessionSummary, HostSnapshot, TaskEntry } from "./client.js";
import {
  sameTaskRow,
  taskCanBeDone,
  taskList,
  taskRowLabel,
  taskTime,
  workspaceTaskList,
} from "./task-list.js";
import { liveWork } from "./surfaces.js";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const threadId = (index: number) =>
  `thr_00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`;

const base = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const template = base.threads[0]!;
const pending = Object.values(base.requests)
  .flat()
  .find((request) => request.status === "pending")!;

function entry(
  index: number,
  title: string,
  status: ThreadStatus,
  created: number,
  updated: number,
  lines: { readonly failure?: string; readonly lastReply?: string } = {},
): TaskEntry {
  return {
    failure: lines.failure ?? null,
    lastReply: lines.lastReply ?? null,
    thread: {
      ...template,
      role: "work",
      createdAt: hoursAgo(created),
      id: threadId(index),
      status,
      title,
      updatedAt: hoursAgo(updated),
    },
  };
}

function asking(index: number, title: string): WaitingRequest {
  return WaitingRequestSchema.parse({
    assignments: [],
    request: {
      ...pending,
      originatingThreadId: threadId(index),
      presentation: { ...pending.presentation, title },
    },
  });
}

function snapshot(
  entries: readonly TaskEntry[],
  options: {
    readonly browserSessions?: readonly BrowserSessionSummary[];
    readonly chat?: number;
    readonly unread?: readonly number[];
    readonly waiting?: readonly WaitingRequest[];
  } = {},
): HostSnapshot {
  const unread = new Set((options.unread ?? []).map(threadId));
  return {
    ...base,
    activeTasks: [],
    assignments: {},
    browserSessions: [...(options.browserSessions ?? [])],
    homeThreadId: options.chat === undefined ? null : threadId(options.chat),
    machines: [],
    tasks: { entries, window: base.workspaceWindow },
    threads: [],
    threadReadStates: Object.fromEntries(
      entries.map(({ thread }) => [
        thread.id,
        ThreadReadStateSchema.parse({
          asOfSequence: "20",
          readSequence: "10",
          threadId: thread.id,
          unreadSequence: unread.has(thread.id) ? "12" : "8",
        }),
      ]),
    ),
    waitingRequests: options.waiting ?? [],
    workspaceTasks: {},
  };
}

const titles = (rows: readonly { readonly title: string }[]) => rows.map((row) => row.title);

describe("taskList", () => {
  it("redraws for a mark-only edit without moving the task or changing its state", () => {
    const original = entry(1, "Tokyo flights in May", "running", 2, 1);
    const row = taskList(snapshot([original])).working[0]!;
    expect(row).toMatchObject({ icon: original.thread.icon, color: original.thread.color });
    const changed = taskList(
      snapshot([{ ...original, thread: { ...original.thread, icon: "plane", color: "purple" } }]),
    ).working[0]!;
    expect(sameTaskRow(row, { ...row, icon: row.icon === "plane" ? "hotel" : "plane" })).toBe(
      false,
    );
    expect(sameTaskRow(row, { ...row, color: row.color === "blue" ? "green" : "blue" })).toBe(
      false,
    );
    expect(changed).toMatchObject({
      title: row.title,
      tone: row.tone,
      updatedAt: row.updatedAt,
      icon: "plane",
      color: "purple",
    });
  });

  it("puts a task waiting on its reader first among the work under way, however old", () => {
    const list = taskList(
      snapshot(
        [
          entry(1, "Asks the reader", "waiting", 10, 1),
          entry(2, "Older running", "running", 2, 0),
          entry(3, "Waiting on someone", "waiting", 1, 1),
          entry(4, "Newest running", "running", 0.5, 0),
        ],
        { waiting: [asking(1, "Pick a night")] },
      ),
    );
    expect(titles(list.working)).toEqual([
      "Asks the reader",
      "Newest running",
      "Waiting on someone",
      "Older running",
    ]);
    expect(list.working.map((row) => row.tone)).toEqual([
      "needs-you",
      "working",
      "waiting",
      "working",
    ]);
    expect(list.working[0]!.line).toBe("Pick a night");
    expect(list.ready).toEqual([]);
  });

  it("lists finished and failed tasks by when they last changed, so their times read in order", () => {
    const list = taskList(
      snapshot([
        entry(1, "Made first, changed last", "idle", 30, 2),
        entry(2, "Failed", "failed", 5, 10, { failure: "Couldn’t sign in" }),
        entry(3, "Made last, changed first", "idle", 1, 20),
      ]),
    );
    expect(titles(list.ready)).toEqual([
      "Made first, changed last",
      "Failed",
      "Made last, changed first",
    ]);
    expect(list.ready.map((row) => taskTime(row, now))).toEqual(["2h", "10h", "20h"]);
    expect(list.working).toEqual([]);
  });

  it("never marks old work Done automatically, and keeps unread shared Done in Ready until read", () => {
    const old = entry(1, "Still open", "idle", 60, 47);
    const completed = entry(2, "Shared Done", "idle", 60, 48);
    const done = { ...completed, thread: { ...completed.thread, doneAt: hoursAgo(1) } };
    const unread = taskList(snapshot([old, done], { unread: [2] }));
    expect(titles(unread.ready)).toEqual(["Still open", "Shared Done"]);
    expect(unread.done).toEqual([]);
    expect(unread.ready[1]).toMatchObject({ done: true, canBeDone: true });
    const read = taskList(snapshot([old, done]));
    expect(titles(read.ready)).toEqual(["Still open"]);
    expect(titles(read.done)).toEqual(["Shared Done"]);
  });

  it("keeps Chat apart from every group, and counts as running only what works now", () => {
    const list = taskList(
      snapshot(
        [
          entry(1, "Chat", "running", 400, 0),
          entry(2, "Running", "running", 1, 0),
          entry(3, "Waiting", "waiting", 2, 0),
        ],
        { chat: 1 },
      ),
    );
    expect(list.chat?.title).toBe("Chat");
    expect(list.chat?.canBeDone).toBe(false);
    expect(list.working[0]?.canBeDone).toBe(true);
    expect(list.chat?.line).toBe("Replying");
    expect(titles(list.working)).toEqual(["Running", "Waiting"]);
    expect(list.running).toBe(1);
  });

  it("names the site a working task is on, and no place for a task that is not working", () => {
    const session = {
      acting: true,
      createdAt: hoursAgo(1),
      id: "brs_1",
      profileId: null,
      state: "ready",
      tabs: [
        { id: "other", active: true, title: "Other page", url: "https://example.com" },
        {
          id: "awards",
          active: false,
          title: "Award search",
          url: "https://www.united.com/en/us/awards",
        },
      ],
      tabCatalog: {
        generation: 1,
        revision: 1,
        tabs: [
          {
            id: "other",
            title: "Other page",
            site: "https://example.com",
            order: 0,
            occupants: [],
          },
          {
            id: "awards",
            title: "Award search",
            site: "https://www.united.com/en/us/awards",
            order: 1,
            occupants: [{ acting: true, lastActiveAt: hoursAgo(0) }],
          },
        ],
      },
      threadIds: [threadId(1), threadId(2)],
    } as unknown as BrowserSessionSummary;
    const list = taskList(
      snapshot(
        [entry(1, "Flight award alerts", "running", 1, 0), entry(2, "Finished", "idle", 2, 1)],
        { browserSessions: [session] },
      ),
    );
    expect(list.working[0]!.place).toBe("united.com");
    expect(list.working[0]!.line).toBe("On www.united.com");
    expect(list.ready[0]!.place).toBeNull();
  });

  it("deduplicates history and active entries using the freshest thread", () => {
    const thread = { ...template, status: "running" as const, updatedAt: hoursAgo(3) };
    const stale = { thread, failure: null, lastReply: null };
    const fresh = { ...stale, thread: { ...thread, title: "Fresher", updatedAt: hoursAgo(2) } };
    const source = {
      ...snapshot([stale]),
      activeTasks: [fresh],
      workspaceTasks: { [thread.workspaceId]: { entries: [stale], window: base.workspaceWindow } },
    };
    expect(titles(taskList(source).working)).toEqual(["Fresher"]);
    expect(workspaceTaskList(source, thread.workspaceId).running).toBe(1);
    expect(workspaceTaskList(source, "another-workspace").working).toEqual([]);
    expect(liveWork(source).map((group) => group.title)).toEqual(["Fresher"]);
    const completed = {
      ...fresh,
      thread: { ...fresh.thread, status: "idle" as const, updatedAt: hoursAgo(1) },
    };
    expect(taskList({ ...source, tasks: { ...source.tasks!, entries: [completed] } }).running).toBe(
      0,
    );
  });
});

describe("taskTime", () => {
  it("dates only work that has stopped", () => {
    const list = taskList(
      snapshot(
        [
          entry(1, "Asks", "waiting", 1, 3),
          entry(2, "Running", "running", 1, 3),
          entry(3, "Waiting", "waiting", 1, 3),
          entry(4, "Failed", "failed", 1, 3),
          entry(5, "Finished", "idle", 1, 3),
        ],
        { waiting: [asking(1, "Approve")] },
      ),
    );
    expect(list.working.map((row) => taskTime(row, now))).toEqual([null, null, null]);
    expect(list.ready.map((row) => taskTime(row, now))).toEqual(["3h", "3h"]);
  });
});

describe("taskRowLabel", () => {
  it("says the state the icon shows, then what is happening in words", () => {
    const list = taskList(
      snapshot(
        [
          entry(1, "Chat", "idle", 400, 0, { lastReply: "The best one is the down blend." }),
          entry(2, "Reply to Ana", "waiting", 3, 0),
          entry(3, "Check prices", "running", 2, 0),
          entry(4, "Name this sign-in", "failed", 30, 26, { failure: "Couldn’t open the page" }),
          entry(5, "Amazon orders", "idle", 5, 4, { lastReply: "Both arrive Thursday." }),
          entry(6, "Landlord", "waiting", 1, 0),
        ],
        { chat: 1, unread: [4], waiting: [asking(2, "Approve sending the reply")] },
      ),
    );
    expect(taskRowLabel(list.chat!, { chat: true })).toBe("Chat: The best one is the down blend.");
    expect(list.working.map((row) => taskRowLabel(row))).toEqual([
      "Reply to Ana, needs you: Approve sending the reply",
      "Landlord: Waiting",
      "Check prices, working",
    ]);
    expect(list.ready.map((row) => taskRowLabel(row))).toEqual([
      "Amazon orders, finished: Both arrive Thursday.",
      "Name this sign-in, unread, couldn’t finish: Couldn’t open the page",
    ]);
  });
});

describe("sameTaskRow", () => {
  it("tells rows apart by anything a row shows", () => {
    const [row] = taskList(snapshot([entry(1, "Running", "running", 1, 0)])).working;
    expect(sameTaskRow(row!, { ...row! })).toBe(true);
    expect(sameTaskRow(row!, { ...row!, place: "united.com" })).toBe(false);
    expect(sameTaskRow(row!, { ...row!, unread: true })).toBe(false);
    expect(sameTaskRow(row!, { ...row!, tone: "finished" })).toBe(false);
  });
});

// Failure modes: an old Host must expose no shared Done action or Done shelf,
// even if a cached task carries a newer Host's doneAt.
describe("shared Done capability", () => {
  it("hides shared Done controls and ignores cached Done without the capability", () => {
    const row = entry(90, "Cached Done", "idle", 2, 1);
    const snapshot = Object.assign({}, base, {
      sharedTaskDoneAvailable: false,
      tasks: {
        ...base.tasks!,
        entries: [{ ...row, thread: { ...row.thread, doneAt: hoursAgo(1) } }],
      },
      activeTasks: [],
      threads: [],
    });
    expect(taskCanBeDone(snapshot, row.thread)).toBe(false);
    const list = taskList(snapshot);
    expect(list.done).toHaveLength(0);
    expect(list.ready.find(({ threadId }) => threadId === row.thread.id)?.canBeDone).toBe(false);
  });
});
