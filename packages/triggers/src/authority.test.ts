import { describe, expect, it } from "vitest";
import { triggerAccess } from "./authority.js";
describe("personal Trigger authority", () => {
  it("lets a full-access owner define automation and preserves other callers' access ceiling", () => {
    expect(triggerAccess({ accessMode: "full-access" }, { accessMode: "full-access" })).toBe(
      "define",
    );
    expect(triggerAccess({ accessMode: "approval-required" }, { accessMode: "full-access" })).toBe(
      "see",
    );
    expect(triggerAccess({ accessMode: "auto" }, { accessMode: "approval-required" })).toBe(
      "control",
    );
  });
});
