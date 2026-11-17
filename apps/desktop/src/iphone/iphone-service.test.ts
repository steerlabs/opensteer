import { afterEach, expect, it, vi } from "vitest";
import { FakeIphoneNative, fixture, ownerA, ownerB } from "./test-support.js";
import { IphoneServiceError } from "./iphone-store.js";
import { IphoneService } from "./iphone-service.js";
import type { IphoneRunnerEvent } from "@opensteer/protocol/iphone-bridge";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sleepFixture() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  await f.service.stop();
  const beforeSleep = new FakeIphoneNative();
  const afterSleep = new FakeIphoneNative();
  afterSleep.epoch = 2;
  afterSleep.probeReady = false;
  afterSleep.roster.candidates[0]!.nativeEpoch = 2;
  const startNative = vi
    .fn(async () => ({ client: afterSleep, images: [] }))
    .mockResolvedValueOnce({ client: beforeSleep, images: [] });
  const service = new IphoneService({ store: f.store, startNative });
  cleanups.unshift(() => service.stop());
  await service.start();
  const events: IphoneRunnerEvent[] = [];
  const connection = service.forSlot(ownerA).connect((event) => events.push(event));
  await connection.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  return { ...f, service, beforeSleep, afterSleep, startNative, connection, events };
}

it("configures Wi-Fi only for this Mac's bound phone and preserves preferences on native refusal", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  await expect(f.service.configureWifi(ownerB, f.deviceId, "enable")).rejects.toMatchObject({
    code: "candidate-gone",
  });
  expect(await f.service.wifiStatus(ownerA, f.deviceId)).toMatchObject({
    enabled: false,
    transport: "usb",
  });
  f.native.failures.set("setup.enableWifi", new IphoneServiceError("wifi-pairing-required"));
  expect(await f.service.configureWifi(ownerA, f.deviceId, "enable")).toMatchObject({
    enabled: false,
    reason: "wifi-pairing-required",
  });
  expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
  f.native.failures.clear();
  expect(await f.service.configureWifi(ownerA, f.deviceId, "enable")).toMatchObject({
    enabled: true,
    reason: null,
  });
  expect(await f.service.configureWifi(ownerA, f.deviceId, "pair")).toMatchObject({
    enabled: true,
    reason: null,
  });
  expect(await f.service.configureWifi(ownerA, f.deviceId, "disable")).toMatchObject({
    enabled: false,
    reason: null,
  });
  expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
});

it("ends USB input on a Wi-Fi transport event and never accepts or replays its late receipt", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  const events: unknown[] = [];
  const connection = f.service.forSlot(ownerA).connect((event) => events.push(event));
  const assignment = {
    deviceId: f.deviceId,
    generation: 1,
    role: "screen" as const,
    definitionId: "iphone-screen" as const,
  };
  await connection.request("iphone.targets", { assignments: [assignment] }, f.options());
  const session = { deviceId: f.deviceId, driverGeneration: 1, sessionId: "session", runId: "run" };
  await connection.request("iphone.session.open", { ...session, access: "control" }, f.options());
  const observation = await connection.request(
    "iphone.observe",
    { ...session, includeScreenshot: true },
    f.options(),
  );
  const held = Promise.withResolvers<void>();
  f.native.held.set("phone.perform", held.promise);
  const input = connection.request(
    "iphone.perform",
    {
      ...session,
      nativeEpoch: observation.nativeEpoch,
      geometryRevision: observation.geometryRevision,
      observationToken: observation.observationToken,
      actions: [{ kind: "tap", target: { point: { x: 20, y: 30 } } }],
    },
    f.options(),
  );
  const refusal = expect(input).rejects.toMatchObject({ code: "no-session", effect: "unknown" });
  try {
    await vi.waitFor(
      () => expect(f.native.calls.some(({ method }) => method === "phone.perform")).toBe(true),
      { timeout: 1000 },
    );
    f.native.epoch = 2;
    f.native.roster = {
      revision: f.native.roster.revision + 1,
      candidates: [{ ...f.native.roster.candidates[0]!, nativeEpoch: 2, transport: "wifi" }],
    };
    f.native.publish();
    expect(events).toContainEqual(expect.objectContaining({ event: "iphone.sessionEnded" }));
  } finally {
    held.resolve();
  }
  await refusal;
  await expect(
    connection.request("iphone.observe", { ...session, includeScreenshot: true }, f.options()),
  ).rejects.toMatchObject({ code: "no-session" });
  await connection.request("iphone.session.open", { ...session, access: "control" }, f.options());
  expect(
    (
      await connection.request(
        "iphone.observe",
        { ...session, includeScreenshot: true },
        f.options(),
      )
    ).nativeEpoch,
  ).toBe(2);
  f.native.epoch = 3;
  f.native.roster = {
    revision: f.native.roster.revision + 1,
    candidates: [{ ...f.native.roster.candidates[0]!, nativeEpoch: 3, transport: "usb" }],
  };
  f.native.publish();
  await expect(
    connection.request("iphone.observe", { ...session, includeScreenshot: true }, f.options()),
  ).rejects.toMatchObject({ code: "no-session" });
  expect(f.native.calls.filter(({ method }) => method === "phone.perform")).toHaveLength(1);
  expect((await f.store.records())[0]).toMatchObject({ deviceId: f.deviceId, driverGeneration: 1 });
  connection.close();
});

it("reserves one physical phone across Deployments and restarts, without exposing its identity", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const a = await f.service.reserve(ownerA, "candidate", "setup-a");
  await expect(f.service.reserve(ownerB, "candidate", "setup-b")).rejects.toMatchObject({
    code: "owned-by-another-deployment",
  });
  expect(JSON.stringify(f.service.candidates())).not.toContain("synthetic-private-phone");
  expect((await f.store.records())[0]?.udid).toBe("synthetic-private-phone");
  await f.service.stop();
  const next = f.restart();
  await next.start();
  await expect(next.reserve(ownerB, "candidate", "setup-b")).rejects.toMatchObject({
    code: "owned-by-another-deployment",
  });
  expect(a.phase).toBe("reserved");
});

it("invalidates old sessions on helper loss and generation replacement, never replaying effects", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  await connection.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  await connection.request(
    "iphone.session.open",
    {
      deviceId: f.deviceId,
      driverGeneration: 1,
      sessionId: "session",
      runId: "run",
      access: "control",
    },
    f.options(),
  );
  f.native.lose();
  await expect(
    connection.request(
      "iphone.observe",
      {
        deviceId: f.deviceId,
        driverGeneration: 1,
        sessionId: "session",
        runId: "run",
        includeScreenshot: true,
      },
      f.options(),
    ),
  ).rejects.toMatchObject({ code: "no-session" });
  expect(f.native.calls.filter(({ method }) => method === "phone.perform")).toHaveLength(0);
  connection.close();
});

it("keeps offline removal pending and disables control before Host acknowledgement", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  await f.service.detach(ownerA, f.deviceId);
  expect((await f.store.records())[0]?.phase).toBe("pending-detach");
  expect(await f.service.targets(ownerA.deploymentId)).toEqual([]);
  await f.service.confirmDetach(ownerA, f.deviceId);
  expect(await f.store.records()).toEqual([]);
});

it("tears down exactly its own transport once", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await Promise.all([f.service.stop(), f.service.stop()]);
  expect(f.native.closed).toBe(1);
});

it("rediscovers bound phones after sleep without reconnecting the Runner or replaying its session", async () => {
  const f = await sleepFixture();
  const { service, beforeSleep, afterSleep, startNative, connection, events } = f;
  const session = { deviceId: f.deviceId, driverGeneration: 1, sessionId: "session", runId: "run" };
  await connection.request("iphone.session.open", { ...session, access: "control" }, f.options());
  await connection.request("iphone.observe", { ...session, includeScreenshot: true }, f.options());
  expect(await service.targets(ownerA.deploymentId)).toMatchObject([{ ready: true }]);

  beforeSleep.ready(true);
  service.suspend();
  expect(await service.targets(ownerA.deploymentId)).toMatchObject([
    { deviceId: f.deviceId, driverGeneration: 1, ready: false, nativeEpoch: 0 },
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "iphone.sessionEnded",
      params: { ...session, nativeEpoch: 1, reason: "phone-disconnected" },
    }),
  );
  expect(
    events.filter((event) => event.event === "iphone.targetsChanged").at(-1)?.params.ready,
  ).toBe(false);
  await service.resume();
  expect(await service.targets(ownerA.deploymentId)).toMatchObject([
    { ready: false, nativeEpoch: 2, reason: "not-initialized" },
  ]);
  await vi.waitFor(
    () => expect(afterSleep.calls.some(({ method }) => method === "binding.probe")).toBe(true),
    { timeout: 1000 },
  );
  afterSleep.ready(false);
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "iphone.targetsChanged",
          params: expect.objectContaining({ deviceId: f.deviceId, ready: true, nativeEpoch: 2 }),
        }),
      ),
    { timeout: 1000 },
  );
  expect(await service.targets(ownerA.deploymentId)).toMatchObject([
    { ready: true, nativeEpoch: 2 },
  ]);
  await expect(
    connection.request("iphone.observe", { ...session, includeScreenshot: true }, f.options()),
  ).rejects.toMatchObject({ code: "no-session" });
  expect(
    afterSleep.calls.some(({ method }) => method === "session.open" || method === "phone.perform"),
  ).toBe(false);
  await connection.request("iphone.session.open", { ...session, access: "control" }, f.options());
  expect(
    (
      await connection.request(
        "iphone.observe",
        { ...session, includeScreenshot: true },
        f.options(),
      )
    ).nativeEpoch,
  ).toBe(2);
  expect(startNative).toHaveBeenCalledTimes(2);
  connection.close();
});

it.each([
  ["suspend", "close"],
  ["stop", "close"],
  ["suspend", "start"],
  ["stop", "start"],
  ["suspend", "roster.subscribe"],
  ["stop", "roster.subscribe"],
  ["suspend", "roster.get"],
  ["stop", "roster.get"],
] as const)(
  "keeps phones unavailable when %s interrupts resume during %s",
  async (interrupt, phase) => {
    const f = await sleepFixture();
    const held = Promise.withResolvers<void>();
    const close = f.beforeSleep.close.bind(f.beforeSleep);
    if (phase === "close")
      vi.spyOn(f.beforeSleep, "close").mockImplementationOnce(async () => {
        await held.promise;
        await close();
      });
    f.service.suspend();
    if (phase === "start") {
      f.startNative.mockImplementationOnce(async () => {
        await held.promise;
        return { client: f.afterSleep, images: [] };
      });
    } else if (phase !== "close") f.afterSleep.held.set(phase, held.promise);
    const waking = Promise.allSettled([f.service.resume()]);
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(
        () => {
          if (phase === "close") expect(f.beforeSleep.close).toHaveBeenCalledOnce();
          else if (phase === "start") expect(f.startNative).toHaveBeenCalledTimes(2);
          else expect(f.afterSleep.calls.some(({ method }) => method === phase)).toBe(true);
        },
        { timeout: 1000 },
      );
      if (interrupt === "stop") stopping = f.service.stop();
      else f.service.suspend();
    } finally {
      held.resolve();
    }
    const [result] = await waking;
    if (result!.status === "rejected") expect(result!.reason).toMatchObject({ code: "cancelled" });
    await stopping;
    expect(f.service.candidates()).toEqual([]);
    expect(f.afterSleep.listeners.size).toBe(0);
    expect(f.afterSleep.closed).toBe(phase === "close" ? 0 : 1);
    if (interrupt === "suspend") {
      expect(await f.service.targets(ownerA.deploymentId)).toMatchObject([
        { ready: false, nativeEpoch: 0 },
      ]);
      const next = new FakeIphoneNative();
      f.startNative.mockResolvedValueOnce({ client: next, images: [] });
      await f.service.resume();
      await vi.waitFor(
        async () => {
          expect(await f.service.targets(ownerA.deploymentId)).toMatchObject([{ ready: true }]);
        },
        { timeout: 1000 },
      );
    } else {
      await f.service.resume();
      expect(f.startNative).toHaveBeenCalledTimes(phase === "close" ? 1 : 2);
    }
    f.connection.close();
  },
);

it("keeps reservations across independent desktop stores and a process restart", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.service.reserve(ownerA, "candidate", "setup-a");
  const peer = await f.peer();
  await expect(peer.reserve(ownerB, "candidate", "setup-b")).rejects.toMatchObject({
    code: "owned-by-another-deployment",
  });
  await f.service.stop();
  await expect(peer.reserve(ownerB, "candidate", "setup-b")).rejects.toMatchObject({
    code: "owned-by-another-deployment",
  });
});

it("drops a collected observation after assignment revocation and reconciles unplug/replug", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  const assignment = {
    deviceId: f.deviceId,
    generation: 1,
    role: "screen" as const,
    definitionId: "iphone-screen" as const,
  };
  await connection.request("iphone.targets", { assignments: [assignment] }, f.options());
  await connection.request(
    "iphone.session.open",
    {
      deviceId: f.deviceId,
      driverGeneration: 1,
      sessionId: "session",
      runId: "run",
      access: "control",
    },
    f.options(),
  );
  const held = Promise.withResolvers<void>();
  f.native.held.set("phone.observe", held.promise);
  const observation = connection.request(
    "iphone.observe",
    {
      deviceId: f.deviceId,
      driverGeneration: 1,
      sessionId: "session",
      runId: "run",
      includeScreenshot: true,
    },
    f.options(),
  );
  const refusal = expect(observation).rejects.toMatchObject({ code: "no-session" });
  try {
    await vi.waitFor(
      () => expect(f.native.calls.some((call) => call.method === "phone.observe")).toBe(true),
      { timeout: 1000 },
    );
    await connection.request("iphone.targets", { assignments: [] }, f.options());
  } finally {
    held.resolve();
  }
  await refusal;
  f.native.roster = { revision: f.native.roster.revision + 1, candidates: [] };
  await f.service.discover();
  await connection.request("iphone.targets", { assignments: [assignment] }, f.options());
  expect(await f.service.targets(ownerA.deploymentId)).toMatchObject([
    { reason: "phone-disconnected", nativeEpoch: 0 },
  ]);
  expect((await f.store.records())[0]).toMatchObject({ deviceId: f.deviceId, driverGeneration: 1 });
  connection.close();
});

it("does not erase a new reservation when retrying a failed local removal save", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  await f.service.detach(ownerA, f.deviceId);
  f.failWrite();
  await expect(f.service.confirmDetach(ownerA, f.deviceId)).rejects.toThrow(
    "synthetic write failed",
  );
  const peer = await f.peer();
  await peer.reserve(ownerB, "candidate", "setup-b");
  await f.service.confirmDetach(ownerA, f.deviceId);
  const third = await f.peer("third");
  await expect(third.reserve(ownerA, "candidate", "setup-c")).rejects.toMatchObject({
    code: "owned-by-another-deployment",
  });
  expect(await f.store.records()).toEqual([]);
});

it.each([false, true])(
  "reconciles Host removal after reconnect (detached=%s)",
  async (detached) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    await f.bind();
    await f.service.stop();
    const service = f.restart();
    await service.start();
    const connection = service.forSlot(ownerA).connect(() => undefined);
    try {
      await connection.request(
        "iphone.targets",
        { assignments: [], retainedDeviceIds: detached ? [f.deviceId] : [] },
        f.options(),
      );
      if (detached) {
        expect(await f.store.records()).toMatchObject([{ deviceId: f.deviceId, phase: "bound" }]);
        await expect(service.reserve(ownerA, "candidate", "new-setup")).rejects.toMatchObject({
          code: "phone-already-added",
        });
      } else {
        expect(await f.store.records()).toEqual([]);
        expect(f.native.calls.some(({ method }) => method === "setup.withdrawWifi")).toBe(true);
        await expect(service.reserve(ownerA, "candidate", "new-setup")).resolves.toMatchObject({
          phase: "reserved",
        });
      }
    } finally {
      connection.close();
    }
  },
);

it("does not release a replacement binding when an old setup's cancellation finishes late", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const old = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  const withdrawal = Promise.withResolvers<void>();
  f.native.held.set("setup.withdrawWifi", withdrawal.promise);
  const cancelled = f.service.cancelSetup(old);
  try {
    await vi.waitFor(
      () => expect(f.native.calls.some((c) => c.method === "setup.withdrawWifi")).toBe(true),
      { timeout: 1000 },
    );
    await f.service.finishSetup(old);
    await f.store.remove(old);
    const current = await f.service.reserve(ownerB, "candidate", crypto.randomUUID());
    const released = f.native.calls.filter((c) => c.method === "binding.release").length;
    withdrawal.resolve();
    await cancelled;
    expect(f.native.calls.filter((c) => c.method === "binding.release")).toHaveLength(released);
    expect(await f.store.records()).toEqual([current]);
  } finally {
    withdrawal.resolve();
    await cancelled;
  }
});
