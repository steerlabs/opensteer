import { describe, expect, it } from "vitest";
import { createId, type AssignmentSummary } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  taskFamily,
  taskFamilyGlance,
  sameTaskFamily,
  sameTaskFamilyGlance,
} from "./task-family.js";
import { assignmentMark } from "./assignment-presentation.js";

const snapshot = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const seed = Object.values(snapshot.assignments).find((a) => a.status === "open")!;
const parent = seed.parentThreadId;
function assignment(
  day: number,
  status: AssignmentSummary["status"] = "open",
  worker = createId("thread"),
): AssignmentSummary {
  const at = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    ...seed,
    id: createId("delegation"),
    workerThread: { ...seed.workerThread, id: worker },
    createdAt: at,
    updatedAt: at,
    finishedAt: status === "open" ? null : at,
    status,
  };
}
function reader(assignments: AssignmentSummary[]) {
  return {
    ...snapshot,
    assignments: Object.fromEntries(assignments.map((a) => [a.id, a])),
    threadAutomations: {},
  };
}
describe("task family", () => {
  it("deduplicates reused workers, keeping open work ahead of newer history, otherwise newest", () => {
    const open = assignment(1);
    const old = assignment(2, "completed", open.workerThread.id);
    const newer = assignment(3, "completed", old.workerThread.id);
    expect(
      taskFamily(reader([old, open, newer]), parent).running.map((a) => a.assignmentId),
    ).toEqual([open.id]);
    expect(taskFamily(reader([newer, old]), parent).earlier.map((a) => a.assignmentId)).toEqual([
      newer.id,
    ]);
  });
  it("orders running by handoff, earlier by settlement, and active automations by next fire before paused", () => {
    const a = assignment(1),
      b = assignment(2),
      c = assignment(3, "completed"),
      d = assignment(4, "completed");
    const source = {
      ...reader([d, b, c, a]),
      threadAutomations: {
        [parent]: [
          { id: "paused", name: "A", kind: "schedule" as const, paused: true, nextFireAt: null },
          {
            id: "later",
            name: "B",
            kind: "schedule" as const,
            paused: false,
            nextFireAt: b.createdAt,
          },
          {
            id: "first",
            name: "C",
            kind: "schedule" as const,
            paused: false,
            nextFireAt: a.createdAt,
          },
        ],
      },
    };
    const family = taskFamily(source, parent);
    expect(family.running.map((a) => a.assignmentId)).toEqual([a.id, b.id]);
    expect(family.earlier.map((a) => a.assignmentId)).toEqual([d.id, c.id]);
    expect(family.automations.map((a) => a.id)).toEqual(["first", "later", "paused"]);
    expect(sameTaskFamily(family, taskFamily(source, parent))).toBe(true);
  });
  it("rolls a grandchild question up its assignment chain and puts needs-you marks first, capped at three", () => {
    const assignments = [assignment(1), assignment(2), assignment(3), assignment(4)];
    const target = assignments[3]!;
    const question = snapshot.waitingRequests[0]!;
    const source = {
      ...reader(assignments),
      waitingRequests: [
        {
          ...question,
          assignments: [
            {
              id: createId("delegation"),
              parentThreadId: target.workerThread.id,
              workerThread: { id: createId("thread"), title: "Grandchild" },
            },
            { id: target.id, parentThreadId: parent, workerThread: target.workerThread },
          ],
        },
      ],
    };
    expect(
      taskFamily(source, parent).running.find((a) => a.assignmentId === target.id)?.needsYou,
    ).toBe(true);
    const glance = taskFamilyGlance(source, parent)!;
    expect(glance).toMatchObject({ running: 4, needsYou: true });
    expect(glance.marks).toHaveLength(3);
    expect(glance.marks[0]).toEqual(assignmentMark(target, source));
    expect(sameTaskFamilyGlance(glance, taskFamilyGlance(source, parent))).toBe(true);
  });
  it("ignores self-parent assignments and gives no glance for an empty family", () => {
    expect(taskFamilyGlance(reader([assignment(1, "open", parent)]), parent)).toBeNull();
    expect(taskFamilyGlance(reader([]), parent)).toBeNull();
  });
});
