import { describe, expect, it } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { firstTriggerFireAt, nextTriggerFireAfter, validateTriggerSchedule } from "./schedule.js";

describe("trigger schedules", () => {
  it("evaluates cron expressions in their IANA timezone", () => {
    const schedule = {
      expression: "0 9 * * *",
      kind: "cron" as const,
      timezone: "America/Los_Angeles",
    };
    expect(firstTriggerFireAt(schedule, new Date("2026-07-01T15:00:00.000Z")).toISOString()).toBe(
      "2026-07-01T16:00:00.000Z",
    );
    expect(
      nextTriggerFireAfter(schedule, new Date("2026-07-01T16:00:00.000Z"))?.toISOString(),
    ).toBe("2026-07-02T16:00:00.000Z");
  });

  it("rejects invalid timezones and cron syntax", () => {
    for (const [schedule, message] of [
      [{ expression: "nope", kind: "cron", timezone: "UTC" }, "Invalid cron expression: nope"],
      [
        { expression: "0 9 * * *", kind: "cron", timezone: "Mars/Base" },
        "Invalid IANA timezone: Mars/Base",
      ],
    ] as const) {
      try {
        validateTriggerSchedule(schedule);
        throw new Error("Expected schedule validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(OpensteerError);
        expect(error).toMatchObject({ code: "bad_request", message, retryable: false });
      }
    }
  });

  it("rejects invalid one-shot instants as a caller error", () => {
    expect(() => validateTriggerSchedule({ at: "not-a-date", kind: "at" })).toThrowError(
      expect.objectContaining({
        code: "bad_request",
        message: "One-shot schedule time must be a valid ISO-8601 instant",
      }),
    );
  });
});
