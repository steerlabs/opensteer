import { describe, expect, it } from "vitest";
import { memoryPassWakeText } from "./memory-wake.js";

describe("memoryPassWakeText", () => {
  const since = new Date("2026-11-20T12:00:00.000Z");

  it("formats message-only changes cleanly", () => {
    const text = memoryPassWakeText({
      since,
      completedRunId: "run_1",
      changes: [
        {
          id: "thr_1",
          title: "Billing",
          count: 2,
          first: new Date("2026-11-20T12:05:00.000Z"),
          sources: [],
        },
      ],
      more: false,
    });
    expect(text).toContain(
      '- "Billing": taskId thr_1, 2 new messages, the first at 2026-11-20T12:05:00.000Z.',
    );
  });

  it("reports dismissed questions and person-marked Done even with zero new messages", () => {
    const text = memoryPassWakeText({
      since,
      completedRunId: "run_1",
      changes: [
        {
          id: "thr_2",
          title: "Card payment",
          count: 0,
          first: null,
          sources: [],
          questionsDismissed: 1,
          doneAt: new Date("2026-11-20T12:15:00.000Z"),
          doneBy: "person",
        },
      ],
      more: false,
    });
    expect(text).toContain(
      '- "Card payment": taskId thr_2, 1 question dismissed by person; marked Done by person at 2026-11-20T12:15:00.000Z.',
    );
    expect(text).not.toContain("0 new messages");
  });

  it("reports answered questions alongside new messages and agent-marked Done", () => {
    const text = memoryPassWakeText({
      since,
      completedRunId: null,
      changes: [
        {
          id: "thr_3",
          title: "Reply to Acme",
          count: 1,
          first: new Date("2026-11-20T12:10:00.000Z"),
          sources: [],
          questionsAnswered: 2,
          doneAt: new Date("2026-11-20T12:12:00.000Z"),
          doneBy: "agent",
        },
      ],
      more: true,
    });
    expect(text).toContain(
      "1 new messages, the first at 2026-11-20T12:10:00.000Z; 2 questions answered; marked Done by agent at 2026-11-20T12:12:00.000Z.",
    );
    expect(text).toContain("opensteer_task_list changedSince 2026-11-20T12:00:00.000Z");
  });
});
