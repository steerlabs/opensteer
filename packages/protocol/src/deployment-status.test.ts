import { deploymentClientPolicy, deploymentPolicy } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  DeploymentStatusInfoSchema,
  DesktopPersonalDeploymentStateSchema,
  type DeploymentStatus,
  type DeploymentStatusInfo,
  type DesktopPersonalDeploymentState,
  type DesktopPersonalDeploymentStatus,
} from "./desktop.js";
import {
  deploymentStatusFromAccountDirectory,
  deploymentStatusFromPersonalConnect,
  deploymentStatusFromPersonalStack,
  deploymentStatusSelectable,
  placeStatus,
} from "./deployment-status.js";

describe("deployment status vocabulary", () => {
  it("keeps an unanswered place openable and names how to try again", () => {
    const info = placeStatus.notResponding("Lab server", { ownership: "members" });
    expect(DeploymentStatusInfoSchema.parse(info)).toStrictEqual({
      label: "Can’t reach Lab server",
      reason: "Lab server's server isn't answering. It may be stopped or updating.",
      status: "attention",
    });
    expect(deploymentStatusSelectable(info.status)).toBe(true);
  });

  it("projects every Personal stack state onto exactly one status", () => {
    const projected = new Map<string, DeploymentStatus>();
    for (const state of DesktopPersonalDeploymentStateSchema.options) {
      const info = deploymentStatusFromPersonalStack(personalStack(state));
      expect(DeploymentStatusInfoSchema.parse(info)).toStrictEqual(info);
      projected.set(state, info.status);
    }
    expect(Object.fromEntries(projected)).toStrictEqual({
      checking: "starting",
      degraded: "attention",
      ready: "ready",
      "repair-required": "attention",
      starting: "starting",
      stopped: "offline",
      stopping: "offline",
      "update-required": "attention",
    });
  });

  it("carries the supervisor's own repair sentence when the local stack needs attention", () => {
    const failing = personalStack("repair-required", {
      code: "database-unavailable",
      component: "postgresql",
      detail: "The database did not start. Restart Opensteer to try again.",
      repairAction: "restart-opensteer",
    });
    expect(deploymentStatusFromPersonalStack(failing)).toStrictEqual({
      reason: "The database did not start. Restart Opensteer to try again.",
      status: "attention",
    } satisfies DeploymentStatusInfo);
    expect(deploymentStatusFromPersonalStack(personalStack("degraded")).reason).toBe(
      "Opensteer needs attention on this computer.",
    );
  });

  it("reads Connect reachability the same way for every Directory", () => {
    const now = new Date("2026-08-20T12:01:00.000Z");
    expect(
      deploymentStatusFromPersonalConnect({ hasConnectRoute: false, livenessExpiresAt: null }, now),
    ).toStrictEqual({
      reason: "Remote access is off on the computer that runs this deployment.",
      status: "offline",
    } satisfies DeploymentStatusInfo);
    // A route nobody has answered on is a computer that is off, not a place
    // that refuses remote access.
    expect(
      deploymentStatusFromPersonalConnect({ hasConnectRoute: true, livenessExpiresAt: null }, now),
    ).toStrictEqual({ reason: "That computer is offline.", status: "offline" });
    expect(
      deploymentStatusFromPersonalConnect(
        { hasConnectRoute: true, livenessExpiresAt: "2026-08-20T12:02:00.000Z" },
        now,
      ),
    ).toStrictEqual({ reason: null, status: "ready" });
    // Liveness is a lease: the moment it expires the computer is offline again.
    expect(
      deploymentStatusFromPersonalConnect(
        { hasConnectRoute: true, livenessExpiresAt: "2026-08-20T12:01:00.000Z" },
        now,
      ).status,
    ).toBe("offline");
  });

  it("does not infer health or a fault from an unobserved canonical Host", () => {
    const now = new Date("2026-08-20T12:01:00.000Z");
    expect(
      deploymentStatusFromAccountDirectory(
        { compatible: true, present: true, reachability: "canonical" },
        now,
      ),
    ).toBeNull();
    expect(
      deploymentStatusFromAccountDirectory(
        {
          compatible: true,
          hasConnectRoute: true,
          livenessExpiresAt: "2026-08-20T12:02:00.000Z",
          present: true,
          reachability: "routed",
        },
        now,
      )?.status,
    ).toBe("ready");
  });

  it("puts removed access and incompatible authority ahead of stale reachability", () => {
    expect(
      deploymentStatusFromAccountDirectory({
        compatible: true,
        hasConnectRoute: true,
        livenessExpiresAt: "2099-08-20T12:02:00.000Z",
        present: false,
        reachability: "routed",
      }),
    ).toStrictEqual({
      reason: "You no longer have access to this deployment.",
      status: "offline",
    });
    expect(
      deploymentStatusFromAccountDirectory({
        compatible: false,
        hasConnectRoute: true,
        livenessExpiresAt: "2099-08-20T12:02:00.000Z",
        present: true,
        reachability: "routed",
      }),
    ).toStrictEqual({
      reason: "Update Opensteer to use this deployment’s published connection details.",
      status: "attention",
    });
  });
});

function personalStack(
  state: DesktopPersonalDeploymentState,
  issue: DesktopPersonalDeploymentStatus["issue"] = null,
): DesktopPersonalDeploymentStatus {
  const component = { state: "stopped", version: null } as const;
  return {
    canStart: true,
    components: {
      browser: component,
      host: component,
      messaging: component,
      postgresql: component,
      runner: component,
    },
    deploymentId: null,
    environmentId: null,
    issue,
    schemaVersion: 1,
    state,
    step: null,
  };
}

it("names the side to update from Host policy while retaining the same attention state", () => {
  const personal = deploymentClientPolicy(
    deploymentPolicy({ kind: "personal", defaultWorkspaceBacking: "local-directory" }),
  );
  const team = deploymentClientPolicy(
    deploymentPolicy({ kind: "server", defaultWorkspaceBacking: "local-directory" }),
  );
  expect(placeStatus.unavailable("host-too-old", "Studio Mac", personal)).toEqual({
    status: "attention",
    label: "Needs update",
    reason: "Update Opensteer on Studio Mac to open it from here.",
  });
  expect(placeStatus.unavailable("host-too-old", "Acme", team)).toEqual({
    status: "attention",
    label: "Needs update",
    reason: "This app is newer than Acme's server. Whoever runs Acme's server needs to update it.",
  });
  expect(placeStatus.unavailable("client-too-old", "Acme", team)).toEqual({
    status: "attention",
    label: "Update Opensteer",
    reason: "Acme runs a newer Opensteer than this app.",
  });
  expect(placeStatus.unavailable("host-unavailable", "Acme", team)).toEqual({
    status: "offline",
    label: "Can’t reach Acme",
    reason: "Acme's server isn't answering. It may be stopped or updating.",
  });
  expect(placeStatus.notResponding("Studio Mac", personal)).toEqual({
    status: "attention",
    label: "Not responding",
    reason: "Studio Mac didn’t answer just now. Make sure it’s on and reachable, then try again.",
  });
});
