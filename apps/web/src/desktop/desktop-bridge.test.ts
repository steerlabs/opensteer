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
    portableFs: {
      binaryPath: null,
      detail: "Not installed",
      installAvailable: false,
      issue: null,
      state: "missing",
      version: null,
    },
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
  it("joins with both facts off wherever the shell module runs", () => {
    expect(localJoinOffer({ deploymentKind: "server", status: onPlatform("macos") })).toEqual({
      runAgents: false,
    });
    expect(localJoinOffer({ deploymentKind: "personal", status: onPlatform("linux") })).toEqual({
      runAgents: false,
    });
  });

  it("joins a Windows computer running agents, which is the only way it can join", () => {
    // `shell` is deferred on Windows, so there is no reach-only shape to start.
    expect(localJoinOffer({ deploymentKind: "server", status: onPlatform("windows") })).toEqual({
      runAgents: true,
    });
  });

  it("offers a Windows computer nothing on a Personal Deployment", () => {
    // Personal admits other computers only to be reached, and this one cannot.
    expect(
      localJoinOffer({ deploymentKind: "personal", status: onPlatform("windows") }),
    ).toBeNull();
    expect(localJoinOffer({ deploymentKind: null, status: onPlatform("windows") })).toBeNull();
  });

  it("offers nothing without a slot, or once the slot has been used", () => {
    expect(localJoinOffer({ deploymentKind: "server", status: null })).toBeNull();
    expect(
      localJoinOffer({
        deploymentKind: "server",
        status: { ...onPlatform("macos"), available: false },
      }),
    ).toBeNull();
    const joined = onPlatform("macos");
    expect(
      localJoinOffer({
        deploymentKind: "server",
        status: { ...joined, runner: { ...joined.runner, enrolled: true } },
      }),
    ).toBeNull();
  });
});
