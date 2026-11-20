import { describe, expect, it } from "vitest";
import { MachineSummarySchema, hostApi } from "@opensteer/protocol";
import {
  computerTargetId,
  deviceDriverKey,
  deviceReasonLabel,
  machineSelfRunnerId,
} from "./device-projection.js";

import { devicesView } from "../computers/devices.js";

const runner = "rnr_00000000-0000-4000-8000-000000000001";
const legacy = MachineSummarySchema.parse({
  id: runner,
  name: "Phone",
  access: null,
  allowedModules: ["browser"],
  detail: null,
  device: { platform: "ios", form: "phone", app: "opensteer" },
  enrollmentId: null,
  expiresAt: null,
  lastSeenAt: null,
  modules: {},
  ownership: "mine",
  revocable: true,
  status: "offline",
  unlinkedLocalFolders: 0,
});

describe("scoped device facts", () => {
  it("uses the Host's explicit device identity and attached driver generation", () => {
    expect(machineSelfRunnerId(legacy)).toBeNull();
    expect(deviceDriverKey(legacy)).toBeNull();
    const current = MachineSummarySchema.parse({
      ...legacy,
      kind: "computer",
      selfRunnerId: runner,
      phoneDisplay: null,
      drivers: [
        { role: "self", runnerId: runner, runnerName: "Phone", generation: 4, attached: true },
      ],
    });
    expect(machineSelfRunnerId(current)).toBe(runner);
    expect(deviceDriverKey(current)).toBe(JSON.stringify([runner, runner, 4, true]));
  });

  it("reads the typed target from the shared setup request", () => {
    expect(computerTargetId({ deviceId: runner })).toBe(runner);
    expect(computerTargetId({ runnerId: runner })).toBe(runner);
    expect(
      hostApi["machines.list"].success.parse({ machines: [{ ...legacy, pinnedThreads: 0 }] })
        .machines[0]?.id,
    ).toBe(runner);
  });
});

it("never offers screen control from phone platform or Device kind alone", () => {
  const phones = (["android", "ios"] as const).map((platform) =>
    MachineSummarySchema.parse({
      ...legacy,
      id: platform,
      device: { platform, form: "phone", app: "opensteer" },
      kind: "agent-phone",
      allowedModules: ["browser", "integrations"],
      phoneDisplay: null,
    }),
  );
  expect(phones.map(machineSelfRunnerId)).toEqual([null, null]);
  expect(
    devicesView({ machines: phones, sessions: [], hereId: null }).devices.map(
      ({ capabilitySummary }) => capabilitySummary,
    ),
  ).toEqual([null, null]);
});

it("keeps an explicitly advertised Android display and its offline reason", () => {
  const unavailable = { state: "unavailable", reason: { kind: "driver-offline" } };
  const phone = MachineSummarySchema.parse({
    ...legacy,
    kind: "agent-phone",
    device: { platform: "android", form: "phone" },
    phoneDisplay: {
      definitionId: "android-phone",
      driver: null,
      control: unavailable,
      view: unavailable,
      input: unavailable,
      navigationButtons: [],
      actions: [],
      wake: false,
      lock: null,
      setup: { location: "android-usb" },
    },
  });
  const row = devicesView({ machines: [phone], sessions: [], hereId: null }).devices[0];
  expect(row?.machine).toBe(phone);
  expect(row?.capabilitySummary).toBe("Screen control");
  expect(row?.machine.phoneDisplay).toMatchObject({
    definitionId: "android-phone",
    control: unavailable,
  });
  expect(deviceReasonLabel(phone.phoneDisplay?.control.reason ?? null)).toBe("Its Mac is offline");
});
