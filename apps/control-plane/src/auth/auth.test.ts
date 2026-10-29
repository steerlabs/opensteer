import { describe, expect, it } from "vitest";
import { isRecentAccountAuthentication } from "./auth.js";

describe("account authorization posture", () => {
  it("accepts only bounded, present authentication times", () => {
    const now = Date.parse("2026-08-11T19:00:00.000Z");
    expect(isRecentAccountAuthentication(new Date(now - 15 * 60 * 1_000), now)).toBe(true);
    expect(isRecentAccountAuthentication(new Date(now - 15 * 60 * 1_000 - 1), now)).toBe(false);
    expect(isRecentAccountAuthentication(new Date(now + 60 * 1_000), now)).toBe(true);
    expect(isRecentAccountAuthentication(new Date(now + 60 * 1_000 + 1), now)).toBe(false);
    expect(isRecentAccountAuthentication(null, now)).toBe(false);
    expect(isRecentAccountAuthentication(new Date(Number.NaN), now)).toBe(false);
  });
});
