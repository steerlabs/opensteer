import { describe, expect, it } from "vitest";
import { MessageIdSchema, createId, type AssignmentSummary } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { DelegationEntry } from "./client.js";
import {
  assignmentPresentation,
  delegationPresentation,
  taskGroupSummary,
  taskRowNote,
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

// Failure modes: a group hides that one of its tasks needs the reader or
// failed behind the ones that finished, counts a word its rows never say, or
// pulses for work that is not moving.
describe("taskGroupSummary", () => {
  it("counts each word, what asks for the reader first", () => {
    const summary = taskGroupSummary([
      presented("Finished", "completed"),
      presented("Working", "working", true),
      presented("Finished", "completed"),
    ]);
    expect(summary.label).toBe("3 tasks");
    expect(summary.parts).toEqual([
      { moving: false, text: "2 finished", tone: "completed" },
      { moving: true, text: "1 working", tone: "working" },
    ]);
  });

  it("puts a question and a failure before the rest, in words that agree", () => {
    const summary = taskGroupSummary([
      presented("Working", "working"),
      presented("Couldn’t finish", "failed"),
      presented("Needs you", "waiting"),
      presented("Needs you", "waiting"),
    ]);
    expect(summary.parts.map(({ text }) => text)).toEqual([
      "2 need you",
      "1 couldn’t finish",
      "1 working",
    ]);
    expect(summary.parts.find(({ tone }) => tone === "working")?.moving).toBe(false);
  });
});
