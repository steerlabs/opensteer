import { describe, expect, it } from "vitest";
import { triggerSourceFromInput } from "./tool-input.js";

describe("trigger tool input", () => {
  it("maps a cron schedule with its timezone and constant payload", () => {
    expect(
      triggerSourceFromInput({
        cron: "0 9 * * *",
        kind: "schedule",
        payload: { report: "daily" },
        timezone: "America/Los_Angeles",
      }),
    ).toStrictEqual({
      kind: "schedule",
      schedule: {
        expression: "0 9 * * *",
        kind: "cron",
        payload: { report: "daily" },
        timezone: "America/Los_Angeles",
      },
    });
  });

  it("requires exactly one of at or cron for a schedule", () => {
    expect(() => triggerSourceFromInput({ kind: "schedule" })).toThrow(
      /requires exactly one of at or cron/u,
    );
    expect(() =>
      triggerSourceFromInput({
        at: "2026-10-01T12:00:00.000Z",
        cron: "0 9 * * *",
        kind: "schedule",
        timezone: "UTC",
      }),
    ).toThrow(/requires exactly one of at or cron/u);
  });

  it("requires a timezone for cron and rejects one for a one-shot instant", () => {
    expect(() => triggerSourceFromInput({ cron: "0 9 * * *", kind: "schedule" })).toThrow(
      /requires timezone as an IANA name/u,
    );
    expect(() =>
      triggerSourceFromInput({
        at: "2026-10-01T12:00:00.000Z",
        kind: "schedule",
        timezone: "UTC",
      }),
    ).toThrow(/timezone applies only to a cron schedule/u);
  });

  it("names every schedule field a webhook source rejects", () => {
    expect(() =>
      triggerSourceFromInput({
        at: "2026-10-01T12:00:00.000Z",
        kind: "webhook",
        payload: 1,
        timezone: "UTC",
      }),
    ).toThrow(/does not accept at, payload, timezone/u);
  });
});
