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
    const lostMemory = automation({
      latestOccurrence: {
        completedAt: null,
        contactLostAt: at(-1, 14, 15),
        createdAt: at(-1, 14, 0),
        status: "running",
      } as NonNullable<TriggerSummary["latestOccurrence"]>,
      name: "memory",
      systemRole: "memory-light",
    });
    expect(placeAutomation(lostMemory, now)).toEqual({
      group: "attention",
      problem: expect.stringMatching(/^Running as far as Opensteer knows — contact lost yesterday,/u),
    });
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

  it("reports a running firing whose computer lost contact on list and detail", () => {
    const contactLostAt = at(-1, 14, 15);
    const lostRunning = {
      completedAt: null,
      contactLostAt,
      createdAt: at(-1, 14, 0),
      status: "running",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const once = automation({
      latestOccurrence: lostRunning,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(-1, 14, 0), kind: "at" } },
    });
    expect(placeAutomation(once, now).group).toBe("attention");
    expect(placeAutomation(once, now).problem).toContain("Running as far as Opensteer knows");
    const repeating = automation({ latestOccurrence: lostRunning });
    expect(placeAutomation(repeating, now).group).toBe("attention");
    expect(placeAutomation(repeating, now).problem).toContain("Running as far as Opensteer knows");
    const webhook = automation({ latestOccurrence: lostRunning, source: { kind: "webhook" } });
    expect(placeAutomation(webhook, now).group).toBe("attention");
    expect(placeAutomation(webhook, now).problem).toContain("Running as far as Opensteer knows");
    expect(latestRun(lostRunning, now)).toEqual({
      text: expect.stringMatching(/^Running — contact lost yesterday,/u),
      tone: "warn",
    });
    expect(runOutcome(lostRunning as never, null, null, now)).toMatch(
      /^Running as far as Opensteer knows — contact lost yesterday,/u,
    );
  });

  it("reads Stopped for a sent firing ended by a pause and Canceled for one that never started (AA3)", () => {
    const unsent = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      sent: false,
      status: "canceled",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const sent = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      sent: true,
      status: "canceled",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    expect(runOutcome(unsent as never, null, null, now)).toBe("Canceled");
    expect(runOutcome(sent as never, null, null, now)).toBe("Stopped");
    expect(latestRun(unsent, now)).toEqual({ text: "Last run canceled", tone: "muted" });
    expect(latestRun(sent, now)).toEqual({ text: "Last run stopped", tone: "muted" });
    const onceUnsent = automation({
      latestOccurrence: unsent,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(0, 16, 15), kind: "at" } },
    });
    const onceSent = automation({
      latestOccurrence: sent,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(0, 16, 15), kind: "at" } },
    });
    expect(placeAutomation(onceUnsent, now).problem).toBe("It was canceled before it ran.");
    expect(placeAutomation(onceSent, now).problem).toBe("It was stopped while running.");
  });

  it("reports a removed computer distinctly from lost contact when an occurrence is unknown (AA14.8)", () => {
    const removedUnknown = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      error: "Outcome unknown: the computer was removed while this firing was running.",
      status: "unknown",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const onceRemoved = automation({
      latestOccurrence: removedUnknown,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(0, 16, 15), kind: "at" } },
    });
    expect(placeAutomation(onceRemoved, now)).toEqual({
      group: "attention",
      problem: "Its computer was removed while it was running.",
    });
  });

  it("shows stored exit codes for failed, unknown, and stopped outcomes (AB2)", () => {
    const unknownExit3 = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      exitCode: 3,
      status: "unknown",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const failedExit2 = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      exitCode: 2,
      status: "failed",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;
    const stoppedExit0 = {
      completedAt: at(0, 16, 20),
      createdAt: at(0, 16, 15),
      exitCode: 0,
      sent: true,
      status: "canceled",
    } as NonNullable<TriggerSummary["latestOccurrence"]>;

    expect(runOutcome(unknownExit3 as never, null, null, now)).toBe("Outcome unknown (exit 3)");
    expect(latestRun(unknownExit3, now)).toEqual({
      text: "Last run outcome unknown (exit 3)",
      tone: "warn",
    });
    expect(runOutcome(failedExit2 as never, null, null, now)).toBe("Failed (exit 2)");
    expect(latestRun(failedExit2, now)).toEqual({
      text: "Last run failed (exit 2)",
      tone: "bad",
    });
    expect(runOutcome(stoppedExit0 as never, null, null, now)).toBe("Stopped (exit 0)");
    expect(latestRun(stoppedExit0, now)).toEqual({
      text: "Last run stopped (exit 0)",
      tone: "muted",
    });

    const onceExit3 = automation({
      latestOccurrence: unknownExit3,
      nextFireAt: null,
      source: { kind: "schedule", schedule: { at: at(0, 16, 15), kind: "at" } },
    });
    expect(placeAutomation(onceExit3, now)).toEqual({
      group: "attention",
      problem: "It ended without saying whether its effect happened (exit 3).",
    });
  });

  it("places a halted watch in attention with pause-and-resume instructions (AB3)", () => {
    const haltedWatch = automation({
      source: { kind: "watch" },
      watch: {
        lastError: "Watch stopped restarting because prior process containment could not be verified.",
        observed: "halted",
      },
    });
    expect(placeAutomation(haltedWatch, now)).toEqual({
      group: "attention",
      problem:
        "Stopped and will not restart until you pause and resume it — check its computer for leftover processes.",
    });
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
