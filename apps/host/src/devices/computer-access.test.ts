import { DeviceIdSchema, createId, type UserId } from "@opensteer/core";
import { expect, it } from "vitest";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { gatherComputerAccess } from "./computer-access.js";
import type { DeviceService } from "./device-service.js";
import { deviceAccessBlocked } from "./target-blocked.js";

const deviceId = DeviceIdSchema.parse(createId("runner"));

/** A Mac with Notes approved, whose device refuses for `reason`, as the Home reads it. */
function platform(reason: DeviceAccessRefusal["reason"], connection: boolean) {
  const refusal = deviceAccessBlocked(
    new DeviceAccessRefusal(reason, deviceId, "apps", "Studio Mac"),
    connection,
  );
  return {
    refusal,
    platform: {
      computerAppApprovals: {
        computerUseInventory: async () => ({
          machines: [
            {
              name: "Studio Mac",
              ready: true,
              state: "ready",
              appApproval: "ask",
              accessPolicy: { apps: reason !== "device-access-off" },
              apps: [
                {
                  bundleId: "com.apple.Safari",
                  teamId: null,
                  name: "Safari",
                  access: "read-write",
                  status: "approved",
                  connectionId: "con_00000000-0000-4000-8000-000000000001",
                },
              ],
              deviceId,
              definitionId: "macos-app",
            },
          ],
          phones: [],
        }),
        computerAppHolders: () => new Map(),
      },
      store: {
        requesterShown: async () => null,
        listDeviceComputerAppSetupRequests: async () => [],
        integrationRequests: { listPendingIntegrationAccessRequests: async () => [] },
      },
      listCallableTools: async () => [],
      computerToolEnabled: () => true,
      computerUseVersion: () => 2,
      // The call's own check of the device: what its refusal says, in each caller's words.
      localDeviceAccessBlocked: async () => refusal,
    } as unknown as DeviceService,
  };
}

it.each([
  ["device-access-off", true],
  ["device-offline", true],
  ["device-stopped", true],
  ["device-asleep", true],
  ["device-stopped", false],
  ["device-asleep", false],
] as const)(
  "lists a Mac app whose device refuses (%s; connected agent %s) with the words a call to it gets",
  async (reason, connection) => {
    const { platform: source, refusal } = platform(reason, connection);
    const access = await gatherComputerAccess(source, {
      ownerUserId: createId("user") as UserId,
      ...(connection
        ? { connectionId: "agc_test", direct: true as const }
        : { agentBindingId: "run:test", runId: createId("run") as never }),
    } as never);
    const [machine] = access.machines;
    expect(access.appEntries(machine!)).toEqual([
      expect.objectContaining({ bundleId: "com.apple.Safari", blocked: refusal }),
    ]);
  },
);
