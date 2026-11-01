import { mergeTaskEntries } from "./task-entries.js";
import { describe, expect, it } from "vitest";
import {
  createId,
  ThreadIdSchema,
  ThreadReadStateSchema,
  WaitingRequestSchema,
  type ThreadStatus,
  type WaitingRequest,
} from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { BrowserSessionSummary, HostSnapshot, TaskEntry } from "./client.js";
import {
  listedRowThreadId,
  sameTaskRow,
  taskCanBeDone,
  taskList,
  taskRowLabel,
  taskTime,
  threadRequester,
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
      askedAt: hoursAgo(created),
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
  it.each([false, true])(
    "rolls an unlisted worker's question to its nearest listed ancestor (Chat: %s)",
    (chat) => {
      const ancestor = entry(1, chat ? "Chat" : "My task", "idle", 2, 1);
      const worker = entry(2, "Hidden worker", "waiting", 1, 0);
      const waiting = asking(2, "Choose an option");
      const source = snapshot(
        [
          ancestor,
          {
            ...worker,
            thread: { ...worker.thread, listed: false, parentThreadId: ancestor.thread.id },
          },
        ],
        {
          ...(chat ? { chat: 1 } : {}),
          waiting: [
            {
              ...waiting,
              assignments: [
                {
                  id: createId("delegation"),
                  parentThreadId: ThreadIdSchema.parse(ancestor.thread.id),
                  workerThread: {
                    id: ThreadIdSchema.parse(worker.thread.id),
                    title: worker.thread.title,
                  },
                },
              ],
            },
          ],
        },
      );
      const list = taskList(source);
      const row = chat ? list.chat : [...list.working, ...list.ready][0];
      expect(row).toMatchObject({
        threadId: ancestor.thread.id,
        tone: "needs-you",
        line: "Choose an option",
      });
      expect(
        [...list.working, ...list.ready].some(({ threadId }) => threadId === worker.thread.id),
      ).toBe(false);
    },
  );

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
      askedAt: row.askedAt,
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

  it("lists finished and failed tasks by when a person last asked, so their times read in order", () => {
    const list = taskList(
      snapshot([
        entry(1, "Made first, changed last", "idle", 30, 2),
        entry(2, "Failed", "failed", 5, 10, { failure: "Couldn’t sign in" }),
        entry(3, "Made last, changed first", "idle", 1, 20),
      ]),
    );
    expect(titles(list.ready)).toEqual([
      "Made last, changed first",
      "Failed",
      "Made first, changed last",
    ]);
    expect(list.ready.map((row) => taskTime(row, now))).toEqual(["1h", "5h", "1d"]);
    expect(list.working).toEqual([]);
  });

  it("never marks old work Done automatically, and keeps unread shared Done in Ready until read", () => {
    const old = entry(1, "Still open", "idle", 60, 47);
    const completed = entry(2, "Shared Done", "idle", 61, 48);
    const done = { ...completed, thread: { ...completed.thread, doneAt: hoursAgo(1) } };
    const unread = taskList(snapshot([old, done], { unread: [2] }));
    expect(titles(unread.ready)).toEqual(["Still open", "Shared Done"]);
    expect(unread.done).toEqual([]);
    expect(unread.ready[1]).toMatchObject({ done: true, canBeDone: true });
    const read = taskList(snapshot([old, done]));
    expect(titles(read.ready)).toEqual(["Still open"]);
    expect(titles(read.done)).toEqual(["Shared Done"]);
    // Opened from Ready while unread, reading it does not move it while it is open.
    const opened = taskList(snapshot([old, done]), {
      openThreadId: done.thread.id,
      previous: unread,
    });
    expect(titles(opened.ready)).toEqual(["Still open", "Shared Done"]);
    expect(opened.done).toEqual([]);
    // Opened from the Done shelf, it is already where it belongs and stays there.
    const fromShelf = taskList(snapshot([old, done]), {
      openThreadId: done.thread.id,
      previous: read,
    });
    expect(titles(fromShelf.done)).toEqual(["Shared Done"]);
    // Marked Done by the reader while open, it goes to Done as they asked.
    const markedOpen = taskList(snapshot([old, completed]));
    const marked = taskList(snapshot([old, done]), {
      openThreadId: done.thread.id,
      previous: markedOpen,
    });
    expect(titles(marked.done)).toEqual(["Shared Done"]);
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
    expect(list.ready.map((row) => taskTime(row, now))).toEqual(["1h", "1h"]);
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

// Failure modes: an open helper, which has no row, leaves the sidebar with
// nothing marked as where the reader is; a chain through a Thread this client
// does not hold, or round a loop, marks some unrelated row or never ends.
describe("listedRowThreadId", () => {
  const chat = threadId(70);
  const task = threadId(71);
  const helper = threadId(72);
  const inner = threadId(73);
  const thread = (
    id: string,
    parentThreadId: string | null,
    listed: boolean,
  ): HostSnapshot["threads"][number] => ({ ...template, id, listed, parentThreadId });
  const held = (threads: readonly HostSnapshot["threads"][number][]): HostSnapshot => ({
    ...base,
    activeTasks: [],
    homeThreadId: chat,
    tasks: { ...base.tasks!, entries: [] },
    threads: [...threads],
    workspaceTasks: {},
  });

  it("stands a helper's nearest listed ancestor, or Chat, in for it", () => {
    const snapshot = held([
      thread(task, chat, true),
      thread(helper, task, false),
      thread(inner, helper, false),
    ]);
    expect(listedRowThreadId(snapshot, task)).toBe(task);
    expect(listedRowThreadId(snapshot, helper)).toBe(task);
    expect(listedRowThreadId(snapshot, inner)).toBe(task);
    expect(listedRowThreadId(held([thread(helper, chat, false)]), helper)).toBe(chat);
    expect(listedRowThreadId(snapshot, chat)).toBe(chat);
  });

  it("leaves the Thread itself where the chain cannot be followed", () => {
    expect(listedRowThreadId(held([thread(helper, task, false)]), helper)).toBe(helper);
    expect(listedRowThreadId(held([thread(helper, null, false)]), helper)).toBe(helper);
    expect(
      listedRowThreadId(held([thread(helper, inner, false), thread(inner, helper, false)]), helper),
    ).toBe(helper);
    expect(listedRowThreadId(held([]), helper)).toBe(helper);
  });
});

// Failure modes: a helper's way back names whoever handed it its latest task
// instead of the task it lives under (so the header and the sidebar disagree),
// calls the reader's own Chat by its Thread title, or links a conversation this
// reader cannot open.
describe("threadRequester", () => {
  const chat = threadId(80);
  const task = threadId(81);
  const helper = threadId(82);
  const elsewhere = threadId(83);
  const snapshot = (
    threads: readonly HostSnapshot["threads"][number][],
    assignments: HostSnapshot["assignments"] = {},
  ): HostSnapshot => ({
    ...base,
    activeTasks: [],
    assignments,
    homeThreadId: chat,
    tasks: { ...base.tasks!, entries: [] },
    threads: [...threads],
    workspaceTasks: {},
  });
  const thread = (id: string, title: string, parentThreadId: string | null) => ({
    ...template,
    id,
    parentThreadId,
    title,
  });
  const assignment = Object.values(base.assignments)[0]!;

  it("leads back to where it lives, by the name the reader knows, as the sidebar does", () => {
    const tasks = [
      { ...thread(task, "Plan Tokyo trip", chat), listed: true },
      { ...thread(helper, "Check fares", task), listed: false },
    ];
    expect(threadRequester(snapshot(tasks), task)).toEqual({ threadId: chat, title: "Chat" });
    // An automation anchored on Chat hands the helper its current task; it still lives under the trip.
    const retasked = snapshot(tasks, {
      [assignment.id]: {
        ...assignment,
        parentThreadId: ThreadIdSchema.parse(chat),
        workerThread: { ...assignment.workerThread, id: ThreadIdSchema.parse(helper) },
      },
    });
    expect(threadRequester(retasked, helper)).toEqual({ threadId: task, title: "Plan Tokyo trip" });
    expect(listedRowThreadId(retasked, helper)).toBe(task);
  });

  it("names its task's requester only when the Thread itself is not held", () => {
    expect(
      threadRequester(
        snapshot([thread(task, "Plan Tokyo trip", chat)], {
          [assignment.id]: {
            ...assignment,
            parentThreadId: ThreadIdSchema.parse(task),
            workerThread: { ...assignment.workerThread, id: ThreadIdSchema.parse(helper) },
          },
        }),
        helper,
      ),
    ).toEqual({ threadId: task, title: "Plan Tokyo trip" });
  });

  it("offers no way back to a conversation this reader cannot open, or to none", () => {
    expect(threadRequester(snapshot([thread(task, "Plan", elsewhere)]), task)).toBeNull();
    expect(threadRequester(snapshot([thread(task, "Plan", null)]), task)).toBeNull();
    expect(threadRequester(snapshot([]), task)).toBeNull();
  });
});

it("moves only for a person's ask, ties by descending id, and merges freshest copies", () => {
  const a = entry(1, "A", "idle", 3, 2);
  const b = entry(2, "B", "idle", 3, 1);
  const titlesOf = (entries: readonly TaskEntry[]) => titles(taskList(snapshot(entries)).ready);
  expect(titlesOf([a, b])).toEqual(["B", "A"]);
  const changed = {
    ...a,
    thread: { ...a.thread, title: "Edited", icon: "plane" as const, updatedAt: hoursAgo(0) },
  };
  expect(titlesOf([changed, b])).toEqual(["B", "Edited"]);
  const asked = { ...changed, thread: { ...changed.thread, askedAt: hoursAgo(0) } };
  expect(titlesOf([asked, b])).toEqual(["Edited", "B"]);
  expect(mergeTaskEntries([a, b], [changed]).map(({ thread }) => thread.title)).toEqual([
    "B",
    "Edited",
  ]);
});
