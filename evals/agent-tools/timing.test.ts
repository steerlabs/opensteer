import { expect, it } from "vitest";
import { TurnClock, timingLines } from "./timing.js";

const started = (callId: string) => ({ type: "tool.started", data: { callId } });
const completed = (callId: string) => ({ type: "tool.completed", data: { callId } });

it("splits a turn into waits and tool time, counting parallel tools as one round", () => {
  const clock = new TurnClock(0);
  clock.note(started("a"), 3_000);
  clock.note(started("b"), 3_010);
  clock.note(completed("a"), 3_050);
  clock.note({ type: "assistant.delta" }, 3_060);
  clock.note(completed("b"), 3_100);
  clock.note(started("c"), 6_100);
  clock.note(completed("c"), 6_120);

  expect(clock.finish(8_120)).toEqual({
    rounds: [
      { waitMs: 3_000, toolMs: 100, tools: 2 },
      { waitMs: 3_000, toolMs: 20, tools: 1 },
    ],
    finalWaitMs: 2_000,
    totalMs: 8_120,
  });
});

it("counts a call announced before it is written once, and writing it as a wait", () => {
  const clock = new TurnClock(0);
  clock.note(started("a"), 1_000);
  clock.note(started("a"), 1_500);
  clock.note(completed("a"), 1_520);

  expect(clock.finish(1_520).rounds).toEqual([{ waitMs: 1_500, toolMs: 20, tools: 1 }]);
});

it("ends a tool still running when the turn does", () => {
  const clock = new TurnClock(0);
  clock.note(started("a"), 1_000);

  expect(clock.finish(1_500)).toEqual({
    rounds: [{ waitMs: 1_000, toolMs: 500, tools: 1 }],
    finalWaitMs: 0,
    totalMs: 1_500,
  });
});

it("reports medians per case and says provider time is unknown", () => {
  const turn = (waitMs: number) => ({
    rounds: [{ waitMs, toolMs: 10, tools: 1 }],
    finalWaitMs: 200,
    totalMs: waitMs + 210,
  });
  const lines = timingLines([
    { caseId: "brex", timing: [turn(1_000)] },
    { caseId: "brex", timing: [turn(3_000)] },
    { caseId: "untimed" },
  ]).join("\n");

  expect(lines).toContain("| brex | 1 | 2000ms | 10ms | 200ms | 2210ms |");
  expect(lines).toContain("cannot separate provider time");
  expect(lines).not.toContain("untimed");
});
