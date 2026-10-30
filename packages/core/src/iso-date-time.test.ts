import { describe, expect, it } from "vitest";
import { IsoDateTimeSchema } from "./models.js";

describe("ISO date-time compatibility", () => {
  it.each([
    ["2026-10-29T12:34Z", true],
    ["2026-10-29T12:34+02:00", true],
    ["2026-10-29T12:34:56Z", true],
    ["2026-10-29T12:34:56.123-05:00", true],
    ["2026-10-29T12:34.123Z", false],
    ["2024-02-29T12:34Z", true],
    ["2026-02-29T12:34Z", false],
    ["2026-10-29T25:00Z", false],
    ["2026-10-29T12:34:56+24:00", false],
    ["2026-10-29T12:34", false],
  ])("accepts %s: %s", (value, accepted) => {
    expect(IsoDateTimeSchema.safeParse(value).success).toBe(accepted);
  });
});
