import { DeviceIdSchema, createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { deviceAccessBlocked } from "./target-blocked.js";

it.each([
  [
    "device-stopped",
    "Agents are stopped on Studio Mac.",
    "The person can resume agents there; other work can continue.",
  ],
  [
    "device-asleep",
    "Studio Mac is asleep.",
    "It can be used again once it wakes; other work can continue.",
  ],
  [
    "device-offline",
    "Studio Mac is offline.",
    "The person can bring it online; other work can continue.",
  ],
] as const)(
  "tells a connected agent a device's %s refusal in plain words, with no ids or access to ask for",
  (reason, message, next) => {
    const deviceId = DeviceIdSchema.parse(createId("runner"));
    const blocked = deviceAccessBlocked(
      new DeviceAccessRefusal(reason, deviceId, "apps", "Studio Mac"),
      true,
    );
    expect(blocked?.message).toBe(message);
    expect(blocked?.next).toBe(next);
    expect(JSON.stringify(blocked)).not.toMatch(/computerId=|access=|computer_access_request/u);
  },
);
