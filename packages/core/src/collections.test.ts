import { describe, expect, it } from "vitest";
import { sameStringSet } from "./collections.js";

describe("sameStringSet", () => {
  it("ignores order", () => {
    expect(sameStringSet(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameStringSet([], [])).toBe(true);
    expect(sameStringSet(["a"], ["a", "b"])).toBe(false);
  });

  it("counts repeats, so a duplicate can never stand in for a missing member", () => {
    // Length plus subset would call these equal, which is how a duplicated
    // OAuth scope could mask one that was never requested.
    expect(sameStringSet(["a", "a"], ["a", "b"])).toBe(false);
    expect(sameStringSet(["a", "b"], ["a", "a"])).toBe(false);
    expect(sameStringSet(["a", "a"], ["a", "a"])).toBe(true);
  });
});
