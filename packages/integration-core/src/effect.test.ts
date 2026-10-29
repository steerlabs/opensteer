import { describe, expect, it } from "vitest";
import { integrationToolEffect } from "./effect.js";

describe("integrationToolEffect", () => {
  it("derives read only from an explicit true hint", () => {
    expect(integrationToolEffect({ readOnlyHint: true })).toBe("read");
    expect(integrationToolEffect({ readOnlyHint: false })).toBe("write");
    expect(integrationToolEffect({})).toBe("write");
  });
});
