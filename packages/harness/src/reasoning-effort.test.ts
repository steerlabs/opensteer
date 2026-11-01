import { describe, expect, it } from "vitest";
import { resolveModelEffort } from "./reasoning-effort.js";

describe("resolveModelEffort", () => {
  it("recognizes effort and the Pi thinking alias", () => {
    expect(resolveModelEffort({ options: { effort: "high" } }, ["low", "high"], "low")).toBe(
      "high",
    );
    expect(resolveModelEffort({ options: { thinking: "medium" } }, ["low", "medium"], "low")).toBe(
      "medium",
    );
  });

  it("chooses only the highest offered known tier", () => {
    expect(
      resolveModelEffort(
        { options: { effort: "highest" } },
        ["vendor-fast", "low", "xhigh"],
        "vendor-fast",
      ),
    ).toBe("xhigh");
  });

  it("uses the engine default for unknown or unavailable values", () => {
    expect(resolveModelEffort({ options: { effort: "high" } }, ["low"], "low")).toBe("low");
    expect(
      resolveModelEffort({ options: { effort: "vendor-deep" } }, ["vendor-deep"], "vendor-deep"),
    ).toBe("vendor-deep");
  });

  it("never returns a default the model did not offer", () => {
    expect(resolveModelEffort({ options: { effort: "vendor-deep" } }, ["low"], "high")).toBe(
      undefined,
    );
  });
});
