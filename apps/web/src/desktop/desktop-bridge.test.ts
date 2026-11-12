import { describe, expect, it } from "vitest";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { localJoinOffer } from "./desktop-bridge.js";

function onPlatform(
  platform: DesktopLocalExecutionStatus["platform"],
): DesktopLocalExecutionStatus {
  return {
    available: true,
    computerName: "Alex's MacBook Pro",
    deploymentId: createId("deployment"),
    mayRunAgents: true,
    platform,
    runAgents: false,
    runner: {
      detail: "Off",
      enrolled: false,
      environmentId: null,
      runnerId: null,
      state: "disabled",
    },
    schemaVersion: 4,
  };
}

describe("localJoinOffer", () => {
  it("joins to be reached wherever the shell module runs", () => {
    expect(localJoinOffer(onPlatform("macos"))).toEqual({ runAgents: false });
    expect(localJoinOffer(onPlatform("linux"))).toEqual({ runAgents: false });
  });

  it("offers a Windows computer nothing, since it could only join running agents", () => {
    expect(localJoinOffer(onPlatform("windows"))).toBeNull();
  });

  it("offers nothing without a slot, or once the slot has been used", () => {
    expect(localJoinOffer(null)).toBeNull();
    expect(localJoinOffer({ ...onPlatform("macos"), available: false })).toBeNull();
    const joined = onPlatform("macos");
    expect(localJoinOffer({ ...joined, runner: { ...joined.runner, enrolled: true } })).toBeNull();
  });
});
