import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { ownedDeviceInventory } from "./owned-device-inventory.js";

it("discovers a disabled phone without granting a shell route and marks offline devices", async () => {
  const machineId = createId("runner");
  const text = await ownedDeviceInventory({
    requestedBy: createId("user"),
    store: {
      listOwnedDevices: async () => [
        {
          machineId,
          name: "Phone",
          access: { browser: "disabled", apps: "enabled", files: "unsupported" },
        },
      ],
    },
    runners: { isRunnerConnected: () => false },
  });
  expect(text).toContain(
    JSON.stringify({
      machineId,
      name: "Phone",
      access: { browser: "disabled", apps: "enabled", files: "unsupported" },
      status: "offline",
    }),
  );
  expect(text).toContain("does not grant shell routes");
});
