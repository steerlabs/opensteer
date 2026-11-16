import { expect, it } from "vitest";
import { createId, DeviceIdSchema } from "@opensteer/core";
import type { DeviceInventoryRecord } from "@opensteer/database";
import { DeviceMachineSummarySchema, machineAccessPolicyDefault } from "@opensteer/protocol";
import { deviceCapabilities, projectDeviceMachines } from "./device-machine-projection.js";

it("keeps a detached screen Device visible without borrowing its Mac's execution or readiness", () => {
  const deviceId = DeviceIdSchema.parse(createId("device")),
    runnerId = createId("runner");
  const device: DeviceInventoryRecord = {
    id: deviceId,
    deploymentId: createId("deployment"),
    ownerKind: "user",
    ownerUserId: createId("user"),
    name: "Travel iPhone",
    kind: "phone",
    platform: "ios",
    form: "phone",
    accessPolicy: { ...machineAccessPolicyDefault, apps: false, browser: false },
    accessPolicyRevision: 1,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = projectDeviceMachines({
    devices: [device],
    drivers: [{ deviceId, runnerId, role: "screen", generation: 2, detachedAt: new Date() }],
    runnerNames: new Map([[runnerId, "Work Mac"]]),
    selfMachines: [],
    runnerConnected: () => true,
  });
  expect(DeviceMachineSummarySchema.parse(result[0])).toMatchObject({
    id: deviceId,
    name: "Travel iPhone",
    selfRunnerId: null,
    allowedModules: [],
    modules: {},
    fullDiskAccess: null,
    pinnedThreads: 0,
    status: "offline",
    capabilities: {
      apps: { enabled: false, state: "disabled" },
      browser: { supported: false },
      files: { supported: false },
    },
    phoneDisplay: {
      definitionId: "iphone-screen",
      driver: { runnerId, generation: 2, attached: false },
      view: { state: "unavailable", reason: { kind: "not-connected" } },
      setup: { location: "driver-mac", driverRunnerName: "Work Mac" },
    },
  });
});

it("keeps a connected iPhone's typed control availability in agent capabilities", () => {
  const deviceId = DeviceIdSchema.parse(createId("device"));
  const device: DeviceInventoryRecord = {
    id: deviceId,
    deploymentId: createId("deployment"),
    ownerKind: "user",
    ownerUserId: createId("user"),
    name: "Travel iPhone",
    kind: "phone",
    platform: "ios",
    form: "phone",
    accessPolicy: { ...machineAccessPolicyDefault, apps: true, browser: false },
    accessPolicyRevision: 1,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const display = projectDeviceMachines({
    devices: [device],
    drivers: [],
    selfMachines: [],
    runnerNames: new Map(),
    runnerConnected: () => true,
  })[0]!.phoneDisplay!;
  expect(
    deviceCapabilities(device, undefined, true, {
      ...display,
      control: { state: "unavailable", reason: { kind: "locked" } },
    }).apps,
  ).toMatchObject({
    supported: true,
    enabled: true,
    state: "unavailable",
    reason: { kind: "locked" },
  });
  expect(
    deviceCapabilities(
      { ...device, accessPolicy: { ...device.accessPolicy, apps: false } },
      undefined,
      true,
      { ...display, control: { state: "ready", reason: null } },
    ).apps,
  ).toMatchObject({ enabled: false, state: "disabled", reason: { kind: "access-off" } });
});
