import { describe, expect, it } from "vitest";
import { MessageIdSchema, createId, type AssignmentSummary } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { DelegationEntry } from "./client.js";
import {
  assignmentPresentation,
  delegationPresentation,
  taskRowNote,
  tasksUnderWay,
  type AssignmentPresentation,
} from "./assignment-presentation.js";

const snapshot = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const open = Object.values(snapshot.assignments).find(({ status }) => status === "open")!;

function settled(status: AssignmentSummary["status"]): AssignmentSummary {
  return { ...open, finishedAt: open.createdAt, status };
}

function delegation(outcome: DelegationEntry["outcome"]): DelegationEntry {
  return {
    childRunId: "run_child",
    childThread: { id: "thr_child", title: "Check fares", workspaceId: "wsp_main" },
    createdAt: open.createdAt,
    delegationId: "del_1",
    delivery: { resultMessageId: MessageIdSchema.parse(createId("message")), status: "delivered" },
    failure: null,
    id: "delegation:del_1",
    kind: "delegation",
    outcome,
    resultPreview: null,
    runId: null,
    taskPreview: "Check fares",
  };
}

const presented = (
  word: string,
  tone: AssignmentPresentation["tone"],
  moving = false,
): AssignmentPresentation => ({
  announcement: word,
  detail: null,
  model: null,
  moving,
  open: tone !== "completed" && tone !== "failed" && tone !== "stopped",
  stopBlocked: null,
  tone,
  word,
});

// Failure modes: a task's row, its own title and an old delegation say
// different words for the same ending, or a finished task reads as a Run.
describe("a settled task's word", () => {
  it.each([
    ["completed", "Finished", "completed"],
    ["failed", "Couldn’t finish", "failed"],
    ["cancelled", "Stopped", "stopped"],
  ] as const)("reads a %s task as %s", (status, word, tone) => {
    const presentation = assignmentPresentation(settled(status), snapshot);
    expect(presentation).toMatchObject({ open: false, tone, word });
    expect(presentation.announcement).toMatch(new RegExp(`: ${word}$`, "u"));
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "cancelled"],
  ] as const)("reads a %s delegation as a %s task does", (outcome, status) => {
    const assignment = assignmentPresentation(settled(status), snapshot);
    const old = delegationPresentation(delegation(outcome), snapshot);
    expect([old.word, old.tone]).toEqual([assignment.word, assignment.tone]);
    expect(old).toMatchObject({ announcement: `Check fares: ${assignment.word}`, open: false });
  });

  it("says when an old delegation's result never came back", () => {
    const undelivered = {
      ...delegation("completed"),
      delivery: { reason: "Thread deleted", status: "undeliverable" as const },
    };
    expect(delegationPresentation(undelivered, snapshot).detail).toEqual({
      kind: "undeliverable",
      text: "Its result could not be returned here.",
    });
  });
});

// Failure modes: a row repeats the step a task's own Thread is showing, or
// drops the question or the reason it cannot go on.
describe("taskRowNote", () => {
  it("keeps what the word cannot say and leaves the step to the task", () => {
    const working = presented("Working", "working", true);
    expect(taskRowNote({ ...working, detail: { kind: "step", text: "Searching" } })).toBeNull();
    expect(
      taskRowNote({ ...working, detail: { kind: "decision", text: "Book the 7:00 PM table?" } }),
    ).toEqual({ kind: "decision", text: "Book the 7:00 PM table?" });
    expect(
      taskRowNote({ ...working, detail: { kind: "offline", text: "Studio Mac is offline." } }),
    ).toEqual({ kind: "offline", text: "Studio Mac is offline." });
  });
});

// Failure modes: a conversation's menu lists another conversation's tasks or
// finished ones, or its lines swap places as their states change.
describe("tasksUnderWay", () => {
  it("lists only this conversation's open tasks, in the order it handed them out", () => {
    const parentThreadId = open.parentThreadId;
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 15, minute)).toISOString();
    const task = (id: string, createdAt: string, change: Partial<AssignmentSummary> = {}) => ({
      ...open,
      createdAt,
      id: id as AssignmentSummary["id"],
      ...change,
    });
    const assignments = {
      later: task("later", at(5)),
      earlier: task("earlier", at(1)),
      finished: task("finished", at(2), { finishedAt: at(3), status: "completed" }),
      elsewhere: task("elsewhere", at(0), {
        parentThreadId: "thr_elsewhere" as AssignmentSummary["parentThreadId"],
      }),
    };
    expect(tasksUnderWay(parentThreadId, assignments).map(({ id }) => id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
