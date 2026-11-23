import { afterEach, expect, it, vi } from "vitest";
import { DisplayStreamIdSchema } from "@opensteer/protocol";

import { FakeIphoneMacSupport, FakeIphoneNative, fixture, ownerA, ownerB } from "./test-support.js";
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

it.each([true, false])(
  "waits for native iPhone session close and reports its result (%s)",
  async (success) => {
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
    const nativeClose = Promise.withResolvers<void>();
    f.native.held.set("session.close", nativeClose.promise);
    if (!success) f.native.failures.set("session.close", new Error("Native close failed"));
    const confirmed = vi.fn();
    const closing = Promise.resolve(connection.close()).then(confirmed);
    try {
      await vi.waitFor(() =>
        expect(f.native.calls.some(({ method }) => method === "session.close")).toBe(true),
      );
      expect(confirmed).not.toHaveBeenCalled();
    } finally {
      nativeClose.resolve();
    }
    await closing;
    expect(confirmed).toHaveBeenCalledWith(success);
    await expect(connection.close()).resolves.toBe(success);
  },
);

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
  if ("reason" in observation) throw new Error("Expected a captured observation.");
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

it("qualifies first observe with runtime's content protection", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const record = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  f.native.foreground = { appId: "com.opensteer.opensteer", label: "Opensteer" };
  await expect(f.service.firstObserve(record, new AbortController().signal)).rejects.toMatchObject({
    code: "screenshot-failed",
  });
  // iOS 27 can't always name the front app; an unlocked, lit screen still passes.
  for (const foreground of [null, { appId: "example.app", label: "Example" }]) {
    f.native.foreground = foreground;
    await expect(
      f.service.firstObserve(record, new AbortController().signal),
    ).resolves.toBeUndefined();
  }
});

it("delegates DDI selection to the bridge with mount timeout and propagates failures", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const record = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  const signal = new AbortController().signal;
  await expect(f.service.prepare(record, signal)).resolves.toBeUndefined();
  expect(f.native.calls.find((c) => c.method === "setup.prepareDeveloperServices")).toMatchObject({
    params: { localPhoneId: "candidate", nativeEpoch: 1 },
    timeoutMs: 120000,
  });
  f.native.failures.set(
    "setup.prepareDeveloperServices",
    new IphoneServiceError("developer-image-incompatible"),
  );
  await expect(f.service.prepare(record, signal)).rejects.toMatchObject({
    code: "developer-image-incompatible",
  });
});

it("gives runtime probes the mount budget and auto-heals when Xcode updates", async () => {
  const mac = new FakeIphoneMacSupport();
  const f = await fixture({ mac });
  cleanups.push(f.cleanup);
  f.native.probeReady = false;
  let incompatible = true;
  const originalRequest = f.native.request.bind(f.native);
  vi.spyOn(f.native, "request").mockImplementation(async (method, params, schema, opts) => {
    if (method === "binding.probe") {
      f.native.calls.push({
        method,
        params,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (incompatible) {
        f.native.roster = {
          revision: f.native.roster.revision + 1,
          candidates: f.native.roster.candidates.map((candidate) => ({
            ...candidate,
            capabilities: {
              observe: "developer-image-incompatible",
              act: "developer-image-incompatible",
              launch: "developer-image-incompatible",
              installedApps: "developer-image-incompatible",
              text: "unsupported-text",
              clear: "unsupported-clear",
              indexedTargets: "geometry-unavailable",
              liveVideo: "unsupported",
            },
          })),
        };
        f.native.publish();
        throw new IphoneServiceError("developer-image-incompatible");
      }
      f.native.ready(false);
      return schema.parse({});
    }
    return originalRequest(method, params, schema, opts);
  });
  await f.bind();
  await vi.waitFor(() =>
    expect(f.native.calls.some((c) => c.method === "binding.probe")).toBe(true),
  );
  expect(f.native.calls.find((c) => c.method === "binding.probe")?.timeoutMs).toBe(120000);
  expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
    ready: false,
    reason: "developer-image-incompatible",
  });
  expect(mac.listeners.size).toBe(1);

  // Unchanged Xcode check does not spam probes.
  const probesBefore = f.native.calls.filter((c) => c.method === "binding.probe").length;
  const refreshesBefore = f.native.calls.filter((c) => c.method === "images.refresh").length;
  f.native.images = [{ build: "test" }];
  mac.changed();
  await vi.waitFor(() =>
    expect(f.native.calls.filter((c) => c.method === "images.refresh").length).toBeGreaterThan(
      refreshesBefore,
    ),
  );
  await Promise.resolve();
  expect(f.native.calls.filter((c) => c.method === "binding.probe").length).toBe(probesBefore);

  // Once Xcode updates to a newer DDI build, IphoneService refreshes images, re-probes, and stops watching.
  incompatible = false;
  f.native.images = [{ build: "27B52" }];
  mac.changed();
  await vi.waitFor(async () => {
    expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
      ready: true,
      reason: null,
    });
  });
  expect(mac.listeners.size).toBe(0);
});

it("returns iphone.targets promptly during a slow probe, passes 120s to session open, and probes a new route epoch", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  const events: IphoneRunnerEvent[] = [];
  const connection = f.service.forSlot(ownerA).connect((event) => events.push(event));
  cleanups.push(async () => {
    await connection.close();
  });

  // First observe passes the 120s DDI mount budget to session.open.
  const record = (await f.store.records())[0]!;
  await f.service.firstObserve(record, new AbortController().signal);
  expect(f.native.calls.filter((c) => c.method === "session.open").at(-1)?.timeoutMs).toBe(120000);

  // Hold binding.probe so iphone.targets must return immediately without awaiting the slow mount.
  const heldProbe = Promise.withResolvers<void>();
  f.native.held.set("binding.probe", heldProbe.promise);
  const assignment = {
    deviceId: f.deviceId,
    generation: 1,
    role: "screen" as const,
    definitionId: "iphone-screen" as const,
  };
  const targets = await connection.request(
    "iphone.targets",
    { assignments: [assignment] },
    f.options(),
  );
  expect(targets.targets).toHaveLength(1);
  await vi.waitFor(
    () => expect(f.native.calls.some((c) => c.method === "binding.probe")).toBe(true),
    { timeout: 1000 },
  );

  // While epoch 1's probe is still held, the phone switches to Wi-Fi epoch 2.
  const probesBefore = f.native.calls.filter((c) => c.method === "binding.probe").length;
  f.native.held.delete("binding.probe");
  f.native.epoch = 2;
  f.native.roster = {
    revision: f.native.roster.revision + 1,
    candidates: [
      {
        ...f.native.roster.candidates[0]!,
        nativeEpoch: 2,
        transport: "wifi",
      },
    ],
  };
  f.native.publish();
  heldProbe.resolve();

  // Epoch 2 must get its own fresh probe and publish ready via iphone.targetsChanged.
  await vi.waitFor(
    () =>
      expect(f.native.calls.filter((c) => c.method === "binding.probe").length).toBeGreaterThan(
        probesBefore,
      ),
    { timeout: 1000 },
  );
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "iphone.targetsChanged",
          params: expect.objectContaining({ deviceId: f.deviceId, nativeEpoch: 2, ready: true }),
        }),
      ),
    { timeout: 1000 },
  );

  // Runtime iphone.session.open respects a caller deadline above 30s up to 120s.
  await connection.request(
    "iphone.session.open",
    {
      deviceId: f.deviceId,
      driverGeneration: 1,
      sessionId: "session-long",
      runId: "run-long",
      access: "observe",
    },
    { deadline: Date.now() + 90_000 },
  );
  const openTimeout = f.native.calls.filter((c) => c.method === "session.open").at(-1)?.timeoutMs;
  expect(openTimeout).toBeGreaterThan(30_000);
  expect(openTimeout).toBeLessThanOrEqual(120_000);
});

it("does not reacquire a binding after slot close during recovery and retries when setup refreshes images first", async () => {
  const mac = new FakeIphoneMacSupport();
  const f = await fixture({ mac });
  cleanups.push(f.cleanup);
  f.native.probeReady = false;
  let incompatible = true;
  const originalRequest = f.native.request.bind(f.native);
  vi.spyOn(f.native, "request").mockImplementation(async (method, params, schema, opts) => {
    if (method === "binding.probe") {
      f.native.calls.push({
        method,
        params,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (incompatible) {
        f.native.roster = {
          revision: f.native.roster.revision + 1,
          candidates: f.native.roster.candidates.map((candidate) => ({
            ...candidate,
            capabilities: {
              observe: "developer-image-incompatible",
              act: "developer-image-incompatible",
              launch: "developer-image-incompatible",
              installedApps: "developer-image-incompatible",
              text: "unsupported-text",
              clear: "unsupported-clear",
              indexedTargets: "geometry-unavailable",
              liveVideo: "unsupported",
            },
          })),
        };
        f.native.publish();
        throw new IphoneServiceError("developer-image-incompatible");
      }
      f.native.ready(false);
      return schema.parse({});
    }
    return originalRequest(method, params, schema, opts);
  });

  await f.bind();
  await vi.waitFor(
    async () =>
      expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
        ready: false,
        reason: "developer-image-incompatible",
      }),
    { timeout: 1000 },
  );
  expect(mac.listeners.size).toBe(1);

  // Even if another caller (such as Setup) refreshes images first with a CFBundleVersion bump,
  // the blocked bound phone still retries and recovers.
  incompatible = false;
  f.native.images = [{ build: "test", version: "27.2.52.0" }];
  await f.service.refreshImages(["/Applications/Xcode.app/Contents/Developer"]);
  await vi.waitFor(
    async () =>
      expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
        ready: true,
        reason: null,
      }),
    { timeout: 1000 },
  );
  expect(mac.listeners.size).toBe(0);

  // If a recovery probe pauses in mac.inspect() while the slot closes, it must stop watching
  // and never reacquire a binding after slot close.
  incompatible = true;
  f.native.roster = {
    revision: f.native.roster.revision + 1,
    candidates: f.native.roster.candidates.map((candidate) => ({
      ...candidate,
      nativeEpoch: 2,
      capabilities: {
        observe: "developer-image-incompatible",
        act: "developer-image-incompatible",
        launch: "developer-image-incompatible",
        installedApps: "developer-image-incompatible",
        text: "unsupported-text",
        clear: "unsupported-clear",
        indexedTargets: "geometry-unavailable",
        liveVideo: "unsupported",
      },
    })),
  };
  const inspectHeld = Promise.withResolvers<void>();
  vi.spyOn(mac, "inspect").mockImplementationOnce(async () => {
    await inspectHeld.promise;
    return {
      xcodeApps: ["/Applications/Xcode.app"],
      xcodeInstalling: false,
      imageRoots: ["/Applications/Xcode.app/Contents/Developer"],
    };
  });
  const acquiresBefore = f.native.calls.filter((c) => c.method === "binding.acquire").length;
  f.native.publish();
  await vi.waitFor(() => expect(mac.inspect).toHaveBeenCalledOnce(), { timeout: 1000 });
  const stopping = f.service.stopForSlot(ownerA.deploymentId);
  try {
    await vi.waitFor(() => expect(mac.listeners.size).toBe(0), { timeout: 1000 });
  } finally {
    inspectHeld.resolve();
  }
  await stopping;
  expect(f.native.calls.filter((c) => c.method === "binding.acquire").length).toBe(acquiresBefore);
});

it("releases a newly acquired binding when a probe is canceled while binding.acquire is in flight", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  await f.service.stop();
  const service = f.restart();
  await service.start();
  const heldAcquire = Promise.withResolvers<void>();
  let acquireSignal: AbortSignal | undefined;
  let acquireStarted = false;
  const originalRequest = f.native.request.bind(f.native);
  vi.spyOn(f.native, "request").mockImplementation(async (method, params, schema, opts) => {
    if (method === "binding.acquire") {
      acquireStarted = true;
      acquireSignal = opts?.signal;
      f.native.calls.push({ method, params });
      await heldAcquire.promise;
      return schema.parse({ bindingToken: "late-binding-token" });
    }
    return originalRequest(method, params, schema, opts);
  });
  const connection = service.forSlot(ownerA).connect(() => undefined);
  cleanups.push(async () => {
    await connection.close();
  });
  await connection.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  await vi.waitFor(() => expect(acquireStarted).toBe(true), { timeout: 1000 });
  expect(acquireSignal).toBeUndefined();
  connection.close();
  heldAcquire.resolve();
  await vi.waitFor(
    () =>
      expect(
        f.native.calls.some(
          (c) =>
            c.method === "binding.release" &&
            (c.params as { bindingToken?: string }).bindingToken === "late-binding-token",
        ),
      ).toBe(true),
    { timeout: 1000 },
  );
});

it("refuses first observations with stale epochs or unusable geometry", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const record = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  const request = f.native.request.bind(f.native);
  let stale = true;
  vi.spyOn(f.native, "request").mockImplementation(async (method, params, schema) => {
    const result = await request(method, params, schema);
    if (method !== "phone.observe") return result;
    const observation = result as { nativeEpoch: number; geometry: { rotation: number | null } };
    if (stale) observation.nativeEpoch++;
    else observation.geometry.rotation = null;
    return result;
  });
  await expect(f.service.firstObserve(record, new AbortController().signal)).rejects.toMatchObject({
    code: "stale-native-epoch",
  });
  stale = false;
  await expect(f.service.firstObserve(record, new AbortController().signal)).rejects.toMatchObject({
    code: "geometry-unknown",
  });
});

async function displayFixture() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await f.bind();
  const port = f.service.forSlot(ownerA);
  const events: IphoneRunnerEvent[] = [];
  const connection = port.connect((event) => events.push(event));
  await connection.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  f.native.probeReady = false;
  f.native.roster.candidates[0]!.capabilities = {
    observe: null,
    act: null,
    launch: null,
    installedApps: null,
    text: null,
    clear: null,
    indexedTargets: null,
    liveVideo: null,
    wake: null,
  };
  f.native.publish();
  const started = Promise.withResolvers<void>();
  const request = f.native.request.bind(f.native);
  const calls = vi
    .spyOn(f.native, "request")
    .mockImplementation(async (method, params, schema, options) => {
      if (method === "display.start") {
        started.resolve();
        await f.native.held.get(method);
        return schema.parse({ socketPath: "/tmp/synthetic-iphone-media.sock" });
      }
      if (method === "display.input" || method === "display.power")
        return schema.parse({ outcome: "dispatched" });
      return request(method, params, schema, options);
    });
  return { ...f, port, connection, events, calls, started: started.promise };
}

it("claims iPhone display media once and fences input by slot, generation and live geometry", async () => {
  const f = await displayFixture();
  const ref = {
    deviceId: f.deviceId,
    driverGeneration: 1,
    streamId: DisplayStreamIdSchema.parse("dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  };
  const profile = { maxLongSide: 1280, maxFps: 30 };
  await expect(
    f.connection.request(
      "iphone.display.start",
      {
        ...ref,
        ...profile,
        driverGeneration: 2,
      },
      f.options(),
    ),
  ).rejects.toMatchObject({ code: "no-session" });
  const { attachmentToken } = await f.connection.request(
    "iphone.display.start",
    { ...ref, ...profile },
    f.options(),
  );
  expect(f.calls.mock.calls.find(([method]) => method === "display.start")?.[1]).toEqual({
    bindingToken: expect.any(String),
    nativeEpoch: 1,
    streamId: ref.streamId,
    ...profile,
  });
  expect(f.service.forSlot(ownerB).claimMediaAttachment?.(attachmentToken)).toBeUndefined();
  const media = f.port.claimMediaAttachment?.(attachmentToken);
  expect(media?.socketPath).toBe("/tmp/synthetic-iphone-media.sock");
  expect(f.port.claimMediaAttachment?.(attachmentToken)).toBeUndefined();
  const state = {
    streamId: ref.streamId,
    state: "live" as const,
    generation: 3,
    width: 200,
    height: 400,
    rotation: 0 as const,
  };
  for (const listener of f.native.listeners)
    listener({
      kind: "event",
      event: "display.state",
      bootId: "boot",
      sequence: 1,
      displayState: state,
    });
  expect(f.events).toContainEqual({
    kind: "event",
    event: "iphone.displayState",
    params: { ...ref, ...state },
  });
  const input = { ...ref, sequence: 1, events: [{ kind: "nav" as const, to: "home" as const }] };
  await expect(
    f.connection.request("iphone.display.input", { ...input, geometry: 2 }, f.options()),
  ).resolves.toEqual({ outcome: "stale", reason: "stale" });
  await expect(
    f.connection.request("iphone.display.input", { ...input, geometry: 3 }, f.options()),
  ).resolves.toEqual({ outcome: "dispatched" });
  await expect(
    f.connection.request("iphone.display.input", { ...input, geometry: 3 }, f.options()),
  ).resolves.toEqual({ outcome: "stale", reason: "stale" });
  expect(
    f.calls.mock.calls.filter(([method]) => method === "display.input").map(([, params]) => params),
  ).toEqual([
    {
      bindingToken: expect.any(String),
      nativeEpoch: 1,
      streamId: ref.streamId,
      geometry: 3,
      events: input.events,
    },
  ]);
  await expect(
    f.connection.request("iphone.display.power", { ...ref, action: "lock" }, f.options()),
  ).resolves.toEqual({ outcome: "dispatched" });
  f.native.roster = {
    revision: f.native.roster.revision + 1,
    candidates: f.native.roster.candidates.map((candidate) => ({ ...candidate, nativeEpoch: 2 })),
  };
  f.native.publish();
  expect(media?.signal.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(f.native.calls.filter(({ method }) => method === "display.stop")).toHaveLength(1),
  );
});

it("stops a late native display start after the Runner disconnects", async () => {
  const f = await displayFixture();
  const gate = Promise.withResolvers<void>();
  f.native.held.set("display.start", gate.promise);
  const ref = {
    deviceId: f.deviceId,
    driverGeneration: 1,
    streamId: DisplayStreamIdSchema.parse("dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  };
  const start = f.connection.request(
    "iphone.display.start",
    { ...ref, maxLongSide: 1280, maxFps: 30 },
    f.options(),
  );
  const refused = expect(start).rejects.toMatchObject({ code: "no-session" });
  await f.started;
  f.connection.close();
  gate.resolve();
  await refused;
  await vi.waitFor(() =>
    expect(f.native.calls.filter(({ method }) => method === "display.stop")).toHaveLength(1),
  );
});

it.each(["slot close", "device detach", "bridge crash"] as const)(
  "revokes an unclaimed display attachment on %s",
  async (reason) => {
    const f = await displayFixture();
    const ref = {
      deviceId: f.deviceId,
      driverGeneration: 1,
      streamId: DisplayStreamIdSchema.parse("dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    };
    const { attachmentToken } = await f.connection.request(
      "iphone.display.start",
      { ...ref, maxLongSide: 1280, maxFps: 30 },
      f.options(),
    );
    if (reason === "slot close") await f.service.stopForSlot(ownerA.deploymentId);
    if (reason === "device detach") await f.service.detach(ownerA, f.deviceId);
    if (reason === "bridge crash") f.native.lose();
    expect(f.port.claimMediaAttachment?.(attachmentToken)).toBeUndefined();
    if (reason !== "bridge crash") {
      const methods = f.native.calls.map(({ method }) => method);
      expect(methods.lastIndexOf("display.stop")).toBeGreaterThan(-1);
      expect(methods.lastIndexOf("display.stop")).toBeLessThan(
        methods.lastIndexOf("binding.release"),
      );
    }
  },
);
