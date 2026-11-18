import { withTimeout } from "@opensteer/shared/withTimeout";
import { createId, DeviceIdSchema, type DeviceDriverIdentity } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { DeviceDriverResolver } from "./device-drivers.js";

it("fences replacement on the same Runner and retains bindings across transport loss", async () => {
  const deviceId = DeviceIdSchema.parse(createId("device"));
  const runnerId = createId("runner");
  let binding: DeviceDriverIdentity = { deviceId, runnerId, role: "screen", generation: 1 };
  const invalidated: DeviceDriverIdentity[] = [];
  const resolver = new DeviceDriverResolver({
    store: {
      getDevice: async () => ({ id: deviceId, removedAt: null, platform: "ios", kind: "phone" }),
      listDeviceDrivers: async () => [{ ...binding, detachedAt: null }],
    },
    invalidated: (route) => invalidated.push(route),
  });
  await resolver.refresh();
  const old = await resolver.resolve(deviceId, "iphone-screen");
  binding = { ...binding, generation: 2 };
  await resolver.refresh();
  expect(resolver.current(old)).toBe(false);
  expect(invalidated).toEqual([old]);
  expect((await resolver.resolve(deviceId, "iphone-screen")).generation).toBe(2);
  expect(() => resolver.binding(deviceId, "macos-app")).toThrow();
});

describe("Device admissions", () => {
  it("serializes the same Device while other Devices proceed", async () => {
    const resolver = new DeviceDriverResolver({
      store: {
        getDevice: async () => null,
        listDeviceDrivers: async () => [],
      },
    });
    const first = DeviceIdSchema.parse(createId("device"));
    const second = DeviceIdSchema.parse(createId("device"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const a = resolver.withAdmission(first, async () => {
      order.push("first");
      await held;
    });
    const b = resolver.withAdmission(first, async () => {
      order.push("queued");
    });
    await resolver.withAdmission(second, async () => {
      order.push("second");
    });
    expect(order).toEqual(["first", "second"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["first", "second", "queued"]);
  });
});

it("retains a detached Device in assignment snapshots until that Device is removed", async () => {
  const deviceId = createId("device");
  const runnerId = createId("runner");
  let removedAt: Date | null = null;
  const resolver = new DeviceDriverResolver({
    store: {
      getDevice: async () => ({ id: deviceId, removedAt, platform: "ios", kind: "phone" }),
      listDeviceDrivers: async (input) =>
        input?.includeDetached
          ? [{ deviceId, runnerId, role: "screen", generation: 1, detachedAt: new Date() }]
          : [],
    },
  });
  await resolver.refresh();
  expect(resolver.bindings()).toEqual([]);
  expect(resolver.retainedScreenDeviceIds(runnerId)).toEqual([deviceId]);
  removedAt = new Date();
  await resolver.refresh();
  expect(resolver.retainedScreenDeviceIds(runnerId)).toEqual([]);
});

it("admits overlapping Device sets in stable order and locks repeated Devices once", async () => {
  const resolver = new DeviceDriverResolver({
    store: { getDevice: async () => null, listDeviceDrivers: async () => [] },
  });
  const first = createId("device"),
    second = createId("device");
  const completed: string[] = [];
  await withTimeout(
    Promise.all([
      resolver.withAdmissions([second, first, second], async () => {
        completed.push("first");
      }),
      resolver.withAdmissions([first, second], async () => {
        completed.push("second");
      }),
    ]),
    1_000,
    { timeoutError: () => new Error("Overlapping Device admissions did not finish") },
  );
  expect(completed).toEqual(["first", "second"]);
});
