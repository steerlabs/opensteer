import { CronExpressionParser } from "cron-parser";
import { OpensteerError, TimeZoneSchema } from "@opensteer/core";
import type { TriggerSchedule } from "./models.js";

export function validateTriggerSchedule(schedule: TriggerSchedule): void {
  if (schedule.kind === "at") {
    if (!Number.isFinite(Date.parse(schedule.at))) {
      throw invalidSchedule("One-shot schedule time must be a valid ISO-8601 instant");
    }
    return;
  }
  const timeZone = TimeZoneSchema.safeParse(schedule.timezone);
  if (!timeZone.success) {
    throw invalidSchedule(`Invalid IANA timezone: ${schedule.timezone}`, timeZone.error);
  }
  try {
    CronExpressionParser.parse(schedule.expression, {
      currentDate: new Date(),
      tz: schedule.timezone,
    });
  } catch (error) {
    throw invalidSchedule(`Invalid cron expression: ${schedule.expression}`, error);
  }
}

export function firstTriggerFireAt(schedule: TriggerSchedule, now = new Date()): Date {
  validateTriggerSchedule(schedule);
  if (schedule.kind === "at") return new Date(schedule.at);
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: now,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
}

export function nextTriggerFireAfter(schedule: TriggerSchedule, after: Date): Date | null {
  validateTriggerSchedule(schedule);
  if (schedule.kind === "at") return null;
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
}

function invalidSchedule(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({
    cause,
    code: "bad_request",
    message,
  });
}
