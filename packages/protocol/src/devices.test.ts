import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  DeviceCapabilityReasonSchema,
  normalizeDeviceCapabilityReason,
  PhoneDisplayViewSchema,
} from "./devices.js";
import { hostApi } from "./host-api.js";
import { DeviceMachineSummarySchema, MachineSummarySchema } from "./machines.js";

const ready = { state: "ready", reason: null };
const unsupported = {
  supported: false,
  enabled: false,
  configurable: false,
  state: "unsupported",
  reason: { kind: "unsupported" },
};
const phone = {
  definitionId: "iphone-screen",
  driver: {
    runnerId: createId("runner"),
    runnerName: "Mac",
    role: "screen",
    generation: 1,
    attached: true,
  },
  control: { state: "disabled", reason: { kind: "access-off" } },
  view: ready,
  input: ready,
  navigationButtons: [{ id: "home", label: "Home" }],
  actions: ["navigate"],
  wake: false,
  lock: null,
  setup: { location: "driver-mac", driverRunnerId: createId("runner"), driverRunnerName: "Mac" },
};
describe("Device projection and commands", () => {
  it("keeps independent agent and owner availability with conservative unknown reasons", () => {
    expect(PhoneDisplayViewSchema.parse(phone)).toMatchObject({
      control: { state: "disabled" },
      view: ready,
    });
    expect(
      PhoneDisplayViewSchema.parse({
        ...phone,
        control: { state: "future", reason: { kind: "future" } },
      }).control,
    ).toEqual({ state: "unavailable", reason: { kind: "runtime-failed" } });
    expect(DeviceCapabilityReasonSchema.safeParse({ kind: "future" }).success).toBe(false);
    expect(normalizeDeviceCapabilityReason({ kind: "future" })).toEqual({ kind: "runtime-failed" });
  });
  it("accepts legacy machine rows and screen-only Devices without a Runner grant", () => {
    const legacy = {
      id: createId("runner"),
      kind: "phone",
      apps: null,
      access: null,
      computerUse: null,
      detail: null,
      device: { platform: "ios", form: "phone" },
      enrollmentId: null,
      expiresAt: null,
      fullDiskAccess: null,
      lastSeenAt: null,
      runtimeVersion: null,
      allowedModules: ["integrations"],
      modules: {},
      name: "Phone",
      ownership: "mine",
      pinnedThreads: 0,
      revocable: true,
      status: "offline",
    };
    expect(MachineSummarySchema.parse(legacy)).toEqual(legacy);
    const device = {
      ...legacy,
      id: createId("device"),
      allowedModules: [],
      selfRunnerId: null,
      drivers: [phone.driver],
      capabilities: {
        browser: unsupported,
        files: unsupported,
        apps: {
          supported: true,
          enabled: false,
          configurable: true,
          state: "disabled",
          reason: { kind: "access-off" },
        },
      },
      phoneDisplay: phone,
    };
    expect(DeviceMachineSummarySchema.parse(device)).toEqual(device);
    expect(DeviceMachineSummarySchema.safeParse({ ...device, id: "not-a-device" }).success).toBe(
      false,
    );
  });
  it("declares attach/detach CAS commands without hardware identity", () => {
    const dispatch = hostApi["commands.dispatch"];
    const command = {
      type: "iphone.screen.attach",
      idempotencyKey: "attach-1",
      driverRunnerId: createId("runner"),
      target: { kind: "new", name: "iPhone" },
    };
    expect(dispatch.payload.parse(command)).toEqual(command);
    const deviceId = createId("device");
    expect(
      dispatch.payload.parse({
        ...command,
        target: { kind: "existing", deviceId, expectedGeneration: 3 },
      }),
    ).toMatchObject({ target: { deviceId, expectedGeneration: 3 } });
    for (const target of [
      { kind: "existing", deviceId },
      { kind: "new", name: "Phone", udid: "forbidden" },
      { kind: "existing", deviceId, expectedGeneration: 0 },
    ])
      expect(dispatch.payload.safeParse({ ...command, target }).success).toBe(false);
    const detach = {
      type: "iphone.screen.detach",
      idempotencyKey: "detach-1",
      deviceId,
      expectedGeneration: 3,
    };
    expect(dispatch.payload.parse(detach)).toEqual(detach);
    expect(
      dispatch.success.parse({ type: "iphone.screen.detach", deviceId, generation: 4 }),
    ).toEqual({ type: "iphone.screen.detach", deviceId, generation: 4 });
    for (const type of ["machine.rename", "machine.revoke"])
      expect(
        dispatch.payload.safeParse({
          type,
          machineId: deviceId,
          idempotencyKey: "edit-1",
          ...(type === "machine.rename" ? { name: "Phone" } : {}),
        }).success,
      ).toBe(true);
  });
});
