import { createId } from "@opensteer/core";
import {
  DesktopDeploymentSummarySchema,
  type DesktopDeploymentSummary,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { describe, expect, it } from "vitest";
import { localRunnerSlotDeploymentId } from "./app-shell.js";

const bridge = {} as OpensteerDesktopBridge;

function deployment(overrides: Partial<DesktopDeploymentSummary> = {}): DesktopDeploymentSummary {
  const origin = "https://opensteer.example.test";
  return DesktopDeploymentSummarySchema.parse({
    access: "native",
    activeOrigin: origin,
    canonicalOrigin: origin,
    id: createId("deployment"),
    kind: "personal",
    lastUsedAt: null,
    name: "Acme",
    onThisComputer: false,
    routes: [{ kind: "canonical", origin, selected: true }],
    ...overrides,
  });
}

describe("localRunnerSlotDeploymentId", () => {
  it("supervises no slot for the Personal Deployment hosted on this computer", () => {
    const personal = deployment({ kind: "personal", onThisComputer: true });
    expect(
      localRunnerSlotDeploymentId({ desktopBridge: bridge, desktopDeployment: personal }),
    ).toBeNull();
  });
  it("supervises a slot for another personal computer this desktop attaches to", () => {
    const server = deployment();
    expect(
      localRunnerSlotDeploymentId({
        desktopBridge: bridge,
        desktopDeployment: server,
      }),
    ).toBe(server.id);

    // A Personal Deployment reached over its access route is joined like any
    // other: this computer can be one of its reachable computers.
    const remotePersonal = deployment({
      access: "connect",
      kind: "personal",
      onThisComputer: false,
    });
    expect(
      localRunnerSlotDeploymentId({
        desktopBridge: bridge,
        desktopDeployment: remotePersonal,
      }),
    ).toBe(remotePersonal.id);
  });

  it("has no slot for the Personal Deployment this computer hosts", () => {
    // Its local Runner hosts this Deployment; there is nothing
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
      localRunnerSlotDeploymentId({
        desktopBridge: null,
        desktopDeployment: deployment(),
      }),
    ).toBeNull();
    expect(
      localRunnerSlotDeploymentId({
        desktopBridge: bridge,
        desktopDeployment: null,
      }),
    ).toBeNull();
  });
});
