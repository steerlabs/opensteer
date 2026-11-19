import { expect, it } from "vitest";
import { createId, DeviceIdSchema } from "@opensteer/core";
import type { DeviceInventoryRecord } from "@opensteer/database";
import {
  DeviceMachineSummarySchema,
  machineAccessPolicyDefault,
  RunnerAuxiliaryFrameFenceSchema,
} from "@opensteer/protocol";
import { projectMachines } from "../runtime/machines.js";
const project = (
  device: DeviceInventoryRecord,
  runnerId: import("@opensteer/core").RunnerId,
  attached = false,
  availability: import("@opensteer/protocol").DeviceAvailability = {
    state: "unavailable",
    reason: { kind: "not-connected" },
  },
) =>
  projectMachines({
    devices: [
      {
        device,
        selfRunnerId: null,
        drivers: [{ runnerId, role: "screen", generation: 2, attached, runnerName: "Work Mac" }],
        screenConnected: attached,
        screenStatus: attached
          ? {
              ...RunnerAuxiliaryFrameFenceSchema.parse({
                runnerId,
                module: "integrations",
                connectionGeneration: 1,
                connectionId: `rcn_${crypto.randomUUID()}`,
                connectionLeaseId: `rls_${crypto.randomUUID()}`,
                bootId: `rbt_${crypto.randomUUID()}`,
                auxiliaryStreamId: `rax_${crypto.randomUUID()}`,
              }),
              module: "integrations",
              type: "runner.integrations.device-status",
              deviceId: device.id,
              driverGeneration: 2,
              definitionId: "iphone-screen",
              operations: [],
              availability,
              navigationButtons: [],
              actions: [],
              wake: false,
              lock: null,
              displayVersion: null,
              ownerViewVersion: null,
              inputVersion: null,
              powerVersion: null,
            }
          : null,
        phoneAccess: "read-write",
      },
    ],
    runners: [],
    pendingRunners: [],
    access: new Map(),
    apps: new Map(),
    threadsByEnvironment: new Map(),
    deploymentOwnsMainComputer: true,
  });

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
  const result = project(device, runnerId);
  expect(DeviceMachineSummarySchema.parse(result[0])).toMatchObject({
    id: deviceId,
    name: "Travel iPhone",
    selfRunnerId: null,
    allowedModules: [],
    modules: {},
    fullDiskAccess: null,
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
  const runnerId = createId("runner");
  expect(
    project(device, runnerId, true, { state: "unavailable", reason: { kind: "locked" } })[0]
      ?.capabilities?.apps,
  ).toMatchObject({
    supported: true,
    enabled: true,
    state: "unavailable",
    reason: { kind: "locked" },
  });
  expect(
    project({ ...device, accessPolicy: { ...device.accessPolicy, apps: false } }, runnerId, true, {
      state: "ready",
      reason: null,
    })[0]?.capabilities?.apps,
  ).toMatchObject({
    enabled: false,
    state: "disabled",
    reason: { kind: "access-off" },
  });
});
