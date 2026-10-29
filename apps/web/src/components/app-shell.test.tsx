import { createId } from "@opensteer/core";
import {
  DesktopDeploymentSummarySchema,
  type DesktopDeploymentSummary,
  type DesktopLocalExecutionStatus,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { localRunnerSlotDeploymentId, removeLocalComputer } from "./app-shell.js";

const bridge = {} as OpensteerDesktopBridge;

function deployment(overrides: Partial<DesktopDeploymentSummary> = {}): DesktopDeploymentSummary {
  const origin = "https://opensteer.example.test";
  return DesktopDeploymentSummarySchema.parse({
    access: "native",
    activeOrigin: origin,
    canonicalOrigin: origin,
    id: createId("deployment"),
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Acme",
    onThisComputer: false,
    routes: [{ kind: "canonical", origin, selected: true }],
    ...overrides,
  });
}

describe("localRunnerSlotDeploymentId", () => {
  it("supervises a slot for every Deployment this desktop attaches to", () => {
    const server = deployment();
    expect(localRunnerSlotDeploymentId({ desktopBridge: bridge, desktopDeployment: server })).toBe(
      server.id,
    );

    // A Personal Deployment reached over its access route is joined like any
    // other: this computer can be one of its reachable computers.
    const remotePersonal = deployment({
      access: "connect",
      kind: "personal",
      onThisComputer: false,
    });
    expect(
      localRunnerSlotDeploymentId({ desktopBridge: bridge, desktopDeployment: remotePersonal }),
    ).toBe(remotePersonal.id);
  });

  it("has no slot for the Personal Deployment this computer hosts", () => {
    // Its local Runner is the Main, which the Deployment owns; there is nothing
    // here to add, remove, or switch.
    expect(
      localRunnerSlotDeploymentId({
        desktopBridge: bridge,
        desktopDeployment: deployment({ access: "owner", kind: "personal", onThisComputer: true }),
      }),
    ).toBeNull();
  });

  it("has no slot in a browser, which supervises nothing", () => {
    expect(
      localRunnerSlotDeploymentId({ desktopBridge: null, desktopDeployment: deployment() }),
    ).toBeNull();
    expect(
      localRunnerSlotDeploymentId({ desktopBridge: bridge, desktopDeployment: null }),
    ).toBeNull();
  });
});

describe("removeLocalComputer", () => {
  const deploymentId = createId("deployment");
  const runnerId = "rnr_33333333-3333-4333-8333-333333333333";

  it("revokes at the Host before it stops the Runner", async () => {
    const order: string[] = [];
    const dispatch = vi.fn(async () => {
      order.push("revoke");
      return { machineId: runnerId, type: "machine.revoke" as const };
    });
    const stopLocalRunner = vi.fn(async () => {
      order.push("stop");
      return stopped(deploymentId);
    });

    await removeLocalComputer({
      bridge: { stopLocalRunner },
      client: { dispatch } as unknown as Pick<HostClient, "dispatch">,
      deploymentId,
      runnerId,
    });

    expect(order).toEqual(["revoke", "stop"]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: runnerId, type: "machine.revoke" }),
    );
  });

  it("stops nothing when the Host refuses to forget the computer", async () => {
    const stopLocalRunner = vi.fn(async () => stopped(deploymentId));
    const dispatch = vi.fn(async () => {
      throw new Error("The deployment refused that.");
    });

    await expect(
      removeLocalComputer({
        bridge: { stopLocalRunner },
        client: { dispatch } as unknown as Pick<HostClient, "dispatch">,
        deploymentId,
        runnerId,
      }),
    ).rejects.toThrow("The deployment refused that.");
    // A Runner stopped for a computer the Host still holds is a computer that
    // is enrolled and away, with nothing on the page saying so.
    expect(stopLocalRunner).not.toHaveBeenCalled();
  });

  it("reports a stop that fails after the revoke rather than calling it done", async () => {
    const dispatch = vi.fn(async () => ({ machineId: runnerId, type: "machine.revoke" as const }));
    const stopLocalRunner = vi.fn(async () => {
      throw new Error("The local agent service did not stop.");
    });

    await expect(
      removeLocalComputer({
        bridge: { stopLocalRunner },
        client: { dispatch } as unknown as Pick<HostClient, "dispatch">,
        deploymentId,
        runnerId,
      }),
    ).rejects.toThrow("The local agent service did not stop.");
  });

  it("has nothing to revoke for a slot that never enrolled", async () => {
    const dispatch = vi.fn();
    const stopLocalRunner = vi.fn(async () => stopped(deploymentId));

    await removeLocalComputer({
      bridge: { stopLocalRunner },
      client: { dispatch } as unknown as Pick<HostClient, "dispatch">,
      deploymentId,
      runnerId: null,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(stopLocalRunner).toHaveBeenCalledWith({ deploymentId });
  });
});

function stopped(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
): DesktopLocalExecutionStatus {
  return {
    available: true,
    computerName: "Alex's MacBook Pro",
    deploymentId,
    mayRunAgents: true,
    platform: "macos",
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
