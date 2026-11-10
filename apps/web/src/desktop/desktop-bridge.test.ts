import { describe, expect, it } from "vitest";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { localJoinOffer } from "./desktop-bridge.js";
import { hostDeploymentPolicy } from "@opensteer/client/host";

it.each(["personal", "server"] as const)(
  "keeps Windows offers compatible with an older %s Host",
  (kind) => {
    const bootstrap = { deploymentShape: { kind } };
    expect(
      localJoinOffer({
        deploymentPolicy: hostDeploymentPolicy(bootstrap) ?? null,
        status: onPlatform("windows"),
      }),
    ).toEqual(kind === "server" ? { runAgents: true } : null);
  },
);

it.each([true, false])("uses agent modules, not ownership, for a Windows offer: %s", (allowed) => {
  expect(
    localJoinOffer({
      deploymentPolicy: {
        ownership: allowed ? "single-user" : "members",
        localRunnerDefaultModules: allowed ? ["agents"] : ["shell"],
      },
      status: onPlatform("windows"),
    }),
  ).toEqual(allowed ? { runAgents: true } : null);
});

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
  it("joins with both facts off wherever the shell module runs", () => {
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "members",
          personalRemoteAccess: false,
          nativeWebLinks: false,
          localOwnerClaim: false,
          deploymentOwnsMainComputer: false,
          nativePasswords: false,
          deploymentComputerAccess: false,
          sharing: true,
          serviceManagement: true,
          runnerEnrollmentMode: "unrestricted",
          projectConsent: "per-project",
          localRunnerDefaultModules: ["agents", "browser", "shell"],
        },
        status: onPlatform("macos"),
      }),
    ).toEqual({
      runAgents: false,
    });
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "single-user",
          personalRemoteAccess: true,
          nativeWebLinks: true,
          localOwnerClaim: true,
          deploymentOwnsMainComputer: true,
          nativePasswords: true,
          deploymentComputerAccess: true,
          sharing: false,
          serviceManagement: false,
          runnerEnrollmentMode: "reach-only",
          projectConsent: "owner-wide",
          localRunnerDefaultModules: ["shell"],
        },
        status: onPlatform("linux"),
      }),
    ).toEqual({
      runAgents: false,
    });
  });

  it("joins a Windows computer running agents, which is the only way it can join", () => {
    // `shell` is deferred on Windows, so there is no reach-only shape to start.
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "members",
          personalRemoteAccess: false,
          nativeWebLinks: false,
          localOwnerClaim: false,
          deploymentOwnsMainComputer: false,
          nativePasswords: false,
          deploymentComputerAccess: false,
          sharing: true,
          serviceManagement: true,
          runnerEnrollmentMode: "unrestricted",
          projectConsent: "per-project",
          localRunnerDefaultModules: ["agents", "browser", "shell"],
        },
        status: onPlatform("windows"),
      }),
    ).toEqual({
      runAgents: true,
    });
  });

  it("offers a Windows computer nothing on a Personal Deployment", () => {
    // Personal admits other computers only to be reached, and this one cannot.
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "single-user",
          personalRemoteAccess: true,
          nativeWebLinks: true,
          localOwnerClaim: true,
          deploymentOwnsMainComputer: true,
          nativePasswords: true,
          deploymentComputerAccess: true,
          sharing: false,
          serviceManagement: false,
          runnerEnrollmentMode: "reach-only",
          projectConsent: "owner-wide",
          localRunnerDefaultModules: ["shell"],
        },
        status: onPlatform("windows"),
      }),
    ).toBeNull();
    expect(localJoinOffer({ deploymentPolicy: null, status: onPlatform("windows") })).toBeNull();
  });

  it("offers nothing without a slot, or once the slot has been used", () => {
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "members",
          personalRemoteAccess: false,
          nativeWebLinks: false,
          localOwnerClaim: false,
          deploymentOwnsMainComputer: false,
          nativePasswords: false,
          deploymentComputerAccess: false,
          sharing: true,
          serviceManagement: true,
          runnerEnrollmentMode: "unrestricted",
          projectConsent: "per-project",
          localRunnerDefaultModules: ["agents", "browser", "shell"],
        },
        status: null,
      }),
    ).toBeNull();
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "members",
          personalRemoteAccess: false,
          nativeWebLinks: false,
          localOwnerClaim: false,
          deploymentOwnsMainComputer: false,
          nativePasswords: false,
          deploymentComputerAccess: false,
          sharing: true,
          serviceManagement: true,
          runnerEnrollmentMode: "unrestricted",
          projectConsent: "per-project",
          localRunnerDefaultModules: ["agents", "browser", "shell"],
        },
        status: { ...onPlatform("macos"), available: false },
      }),
    ).toBeNull();
    const joined = onPlatform("macos");
    expect(
      localJoinOffer({
        deploymentPolicy: {
          ownership: "members",
          personalRemoteAccess: false,
          nativeWebLinks: false,
          localOwnerClaim: false,
          deploymentOwnsMainComputer: false,
          nativePasswords: false,
          deploymentComputerAccess: false,
          sharing: true,
          serviceManagement: true,
          runnerEnrollmentMode: "unrestricted",
          projectConsent: "per-project",
          localRunnerDefaultModules: ["agents", "browser", "shell"],
        },
        status: { ...joined, runner: { ...joined.runner, enrolled: true } },
      }),
    ).toBeNull();
  });
});
