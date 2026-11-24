import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SCRIPT_UPDATE_COMPUTER_REASON,
  automationScriptCompatibilityReason,
} from "./automation-script-compatibility.js";

describe("automationScriptCompatibilityReason", () => {
  it("accepts environments whose Runner advertises automation-script-v1", async () => {
    const runnerId = createId("runner");
    const store = {
      getEnvironment: async () => ({ runnerId }),
      runnerCapabilities: async () => ["automation-script-v1"],
    } as never;
    expect(await automationScriptCompatibilityReason(store, createId("environment"))).toBeNull();
  });

  it("refuses environments whose Runner lacks automation-script-v1", async () => {
    const runnerId = createId("runner");
    const store = {
      getEnvironment: async () => ({ runnerId }),
      runnerCapabilities: async () => ["trigger-program-v5"],
    } as never;
    expect(await automationScriptCompatibilityReason(store, createId("environment"))).toBe(
      AUTOMATION_SCRIPT_UPDATE_COMPUTER_REASON,
    );
  });

  it("refuses environments without a Runner", async () => {
    const store = {
      getEnvironment: async () => null,
      runnerCapabilities: async () => null,
    } as never;
    expect(await automationScriptCompatibilityReason(store, createId("environment"))).toBe(
      AUTOMATION_SCRIPT_UPDATE_COMPUTER_REASON,
    );
  });
});
