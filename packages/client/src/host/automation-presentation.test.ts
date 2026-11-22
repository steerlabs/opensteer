import type { TriggerSummary } from "@opensteer/triggers/models";
import { describe, expect, it } from "vitest";
import {
  formatNextRun,
  latestRun,
  placeAutomation,
  runOutcome,
  sectionAutomations,
} from "./automation-presentation.js";

const now = new Date(2026, 10, 6, 16, 31).getTime();
const at = (days: number, hours: number, minutes = 0) =>
  new Date(2026, 10, 6 + days, hours, minutes).toISOString();

function automation(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    latestOccurrence: null,
    name: "Check the table",
    nextFireAt: at(0, 16, 35),
    pauseReason: null,
    source: {
      kind: "schedule",
      schedule: { expression: "*/5 * * * *", kind: "cron", timezone: "UTC" },
    },
    status: "active",
    updatedAt: at(-1, 9),
    ...overrides,
  } as unknown as TriggerSummary;
}

describe("placing automations", () => {
  it("keeps Opensteer's memory passes apart unless they need their owner", () => {
    const light = automation({ name: "memory", systemRole: "memory-light" });
    expect(placeAutomation(light, now)).toEqual({ group: "system", problem: null });
    expect(placeAutomation({ ...light, status: "paused" }, now).group).toBe("system");
    expect(placeAutomation({ ...light, waitingReason: "No model" }, now)).toEqual({
      group: "attention",
      problem: "No model",
    });
    expect(
      placeAutomation({ ...light, pauseReason: "It kept failing", status: "paused" }, now),
    ).toEqual({ group: "attention", problem: "It kept failing" });
    expect(sectionAutomations([light, automation()], now).map(({ id }) => id)).toEqual([
      "repeating",
      "system",
    ]);
  });

  it("places and describes unknown firing outcomes without claiming failure", () => {
    const unknownOccurrence = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      status: "unknown",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const once = automation({
      latestOccurrence: unknownOccurrence,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(0, 16, 15), kind: "at" } },
    });
    expect(placeAutomation(once, now)).toEqual({
      group: "attention",
      problem: "Opensteer lost contact while it was running.",
    });
    expect(latestRun(unknownOccurrence, now)).toEqual({
      text: "Last run outcome unknown",
      tone: "warn",
    });
    expect(runOutcome(unknownOccurrence as never, null, null, now)).toBe("Outcome unknown");
  });
});

describe("the next run", () => {
  it("counts down today, then names the day", () => {
    expect(formatNextRun(at(0, 16, 35), now).day).toBe("in 4 min");
    expect(formatNextRun(at(0, 18), now).day).toBe("in 1 h 29 min");
    expect(formatNextRun(at(1, 3), now).day).toBe("Tomorrow");
    expect(formatNextRun(at(3, 9), now).day).toMatch(/^[A-Z][a-z]{2}$/);
    expect(formatNextRun(at(20, 9), now).day).toMatch(/Nov 26|26 Nov/);
  });
});
