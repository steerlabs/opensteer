import { describe, expect, it } from "vitest";
import { allTasksRows, liveTasks, type TaskList, type TaskRow } from "./task-list.js";

const threadId = (index: number) =>
  `thr_00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`;

function row(id: number, tone: TaskRow["tone"], unread = false): TaskRow {
  return {
    threadId: threadId(id),
    folder: { computerId: "run_00000000-0000-4000-8000-000000000001", path: "/home/opensteer" },
    teamOrigin: null,
    title: `Task ${id}`,
    icon: null,
    color: null,
    tone,
    line: "",
    place: null,
    unread,
    stopped: tone === "finished" || tone === "failed",
    done: false,
    doneAt: null,
    quietlyDone: false,
    canBeDone: true,
    askedAt: new Date(Date.UTC(2026, 9, 15, 12 - id)).toISOString(),
  } as TaskRow;
}

const list: TaskList = {
  working: [row(1, "needs-you"), row(2, "working"), row(3, "waiting")],
  ready: [row(4, "finished", true), row(5, "finished"), row(6, "failed", true)],
  done: [row(7, "finished")],
  running: 2,
  hasMore: false,
};
const ids = (rows: readonly TaskRow[]) =>
  rows.map((entry) => Number(entry.threadId.slice(-3)) - 900);

describe("liveTasks", () => {
  it("lists what needs the reader, then unread results, then running work, and drops read results", () => {
    expect(ids(liveTasks(list))).toEqual([1, 4, 6, 2, 3]);
  });

  it("keeps the finished read result in All tasks after it leaves the sidebar", () => {
    expect(ids(liveTasks(list))).not.toContain(5);
    expect(ids(allTasksRows(list, "all"))).toContain(5);
  });
});

describe("allTasksRows", () => {
  it("keeps every open task until it is Done, and filters by what each needs", () => {
    expect(ids(allTasksRows(list, "all"))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(allTasksRows(list, "needs-you"))).toEqual([1]);
    expect(ids(allTasksRows(list, "running"))).toEqual([2, 3]);
    expect(ids(allTasksRows(list, "unread"))).toEqual([4, 6]);
    expect(ids(allTasksRows(list, "read"))).toEqual([5]);
    expect(ids(allTasksRows(list, "done"))).toEqual([7]);
  });
});
