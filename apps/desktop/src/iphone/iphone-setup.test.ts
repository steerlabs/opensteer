import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { fixture, ownerA } from "./test-support.js";
import { IphoneSetup } from "./iphone-setup.js";
import { IphoneServiceError } from "./iphone-store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function boundAfterSetup(f: Awaited<ReturnType<typeof fixture>>) {
  await f.bind();
  await f.service.save({ ...(await f.store.records())[0]!, setupComplete: true });
}
it("persists an idempotent pending attach before dispatch and recovers a failed local save", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  await setup.advance(state.setupId, "trust");
  await setup.advance(state.setupId, "developer-mode");
  await setup.advance(state.setupId, "prepare");
  await setup.advance(state.setupId, "observe");
  await setup.wifi(state.setupId, "skip");
  const pending = await setup.advance(state.setupId, "attach");
  expect((await f.store.records())[0]?.phase).toBe("pending-attach");
  const command = pending.attachCommand!;
  f.failWrite();
  const failed = await setup.complete(state.setupId, {
    type: "iphone.screen.attach",
    deviceId: f.deviceId,
    generation: 1,
  });
  expect(failed.reason).toBe("local-mapping-save-failed");
  expect((await setup.advance(state.setupId, "attach")).attachCommand).toEqual(command);
  await setup.complete(state.setupId, {
    type: "iphone.screen.attach",
    deviceId: f.deviceId,
    generation: 1,
  });
  expect((await f.store.records())[0]?.phase).toBe("bound");
  expect((await setup.status(state.setupId)).step).toBe("confirm");
});

it("offers Wi-Fi only after first observe and persists only a confirmed choice", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  await expect(setup.wifi(state.setupId, "enable")).rejects.toMatchObject({ code: "no-session" });
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  expect(await setup.status(state.setupId)).toMatchObject({
    step: "wifi",
    personAction: "choose-wifi",
    wifiEnabled: false,
  });
  expect(f.native.calls.some(({ method }) => method === "setup.enableWifi")).toBe(false);
  const enabled = Promise.withResolvers<void>();
  const paired = Promise.withResolvers<void>();
  f.native.held.set("setup.enableWifi", enabled.promise);
  f.native.held.set("setup.pairWifi", paired.promise);
  const enabling = setup.wifi(state.setupId, "enable");
  try {
    await vi.waitFor(
      () => expect(f.native.calls.some(({ method }) => method === "setup.enableWifi")).toBe(true),
      { timeout: 1000 },
    );
    expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
    enabled.resolve();
    await vi.waitFor(
      () => expect(f.native.calls.some(({ method }) => method === "setup.pairWifi")).toBe(true),
      { timeout: 1000 },
    );
    expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
  } finally {
    enabled.resolve();
    paired.resolve();
  }
  expect(await enabling).toMatchObject({ step: "attach", reason: null, wifiEnabled: true });
  expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(true);
});

it("keeps failed Wi-Fi optional and carries the chosen name in the stable attach command", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA, { kind: "new", name: "Initial name" });
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  f.native.failures.set("setup.pairWifi", new IphoneServiceError("wifi-pairing-required"));
  expect(await setup.wifi(state.setupId, "enable")).toMatchObject({
    step: "wifi",
    reason: "wifi-pairing-required",
    wifiEnabled: false,
  });
  expect(f.native.calls.some(({ method }) => method === "setup.withdrawWifi")).toBe(true);
  f.native.calls = [];
  await setup.wifi(state.setupId, "skip");
  expect(f.native.calls.some(({ method }) => method === "setup.withdrawWifi")).toBe(true);
  const attached = await setup.advance(state.setupId, "attach", "Chosen name");
  expect(attached.attachCommand).toMatchObject({
    idempotencyKey: state.setupId,
    target: { kind: "new", name: "Chosen name" },
  });
  expect((await f.store.records())[0]?.userLabel).toBe("Chosen name");
  expect(await setup.advance(state.setupId, "attach", "Changed too late")).toMatchObject({
    reason: "attach-conflict",
    attachCommand: attached.attachCommand,
  });
  expect((await setup.advance(state.setupId, "attach", "Chosen name")).attachCommand).toEqual(
    attached.attachCommand,
  );
});

it("withdraws Wi-Fi on cancel even after partial enablement and disconnection", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  f.native.failures.set("setup.pairWifi", new IphoneServiceError("wifi-pairing-required"));
  await setup.wifi(state.setupId, "enable");
  f.native.roster = { revision: f.native.roster.revision + 1, candidates: [] };
  f.native.publish();
  f.native.calls = [];
  await setup.cancel(state.setupId);
  expect(f.native.calls).toContainEqual({
    method: "setup.withdrawWifi",
    params: expect.objectContaining({ udid: "synthetic-private-phone", deviceId: state.setupId }),
  });
  expect(await f.store.records()).toEqual([]);
});

it("cancels temporary setup on navigation without discarding a dispatched attach", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  await setup.cancel(state.setupId);
  expect(await f.store.records()).toEqual([]);
  await expect(setup.status(state.setupId)).rejects.toMatchObject({ code: "cancelled" });
});

it.each(["trust-pending", "trust-denied"] as const)(
  "retries pairing after %s when the person checks again",
  async (reason) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const setup = new IphoneSetup(f.service);
    const state = await setup.begin(ownerA);
    await setup.choose(state.setupId, state.candidates[0]!.candidateId);
    f.native.failures.set("setup.inspect", new IphoneServiceError("trust-required"));
    f.native.failures.set("setup.pair", new IphoneServiceError(reason));
    expect(await setup.advance(state.setupId, "trust")).toMatchObject({ step: "trust", reason });
    f.native.failures.delete("setup.pair");
    const pair = vi.spyOn(f.service, "pair").mockImplementationOnce(async () => {
      f.native.failures.delete("setup.inspect");
    });
    expect(await setup.advance(state.setupId, "trust")).toMatchObject({
      step: "developer-mode",
      reason: null,
    });
    expect(pair).toHaveBeenCalledOnce();
  },
);

it("probes the completed mapping when the Host assignment arrives before the attach reply", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  await setup.wifi(state.setupId, "skip");
  await setup.advance(state.setupId, "attach");
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  try {
    await connection.request(
      "iphone.targets",
      {
        assignments: [
          { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
        ],
      },
      f.options(),
    );
    await setup.complete(state.setupId, {
      type: "iphone.screen.attach",
      deviceId: f.deviceId,
      generation: 1,
    });
    expect(await f.service.targets(ownerA.deploymentId)).toMatchObject([
      { ready: true, reason: null },
    ]);
  } finally {
    connection.close();
  }
});

it("withdraws Wi-Fi on cancel while retaining an already dispatched attach", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const setup = new IphoneSetup(f.service);
  const state = await setup.begin(ownerA);
  await setup.choose(state.setupId, state.candidates[0]!.candidateId);
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  await setup.wifi(state.setupId, "enable");
  await setup.advance(state.setupId, "attach");
  f.native.calls = [];
  await setup.cancel(state.setupId);
  expect(await f.store.records()).toMatchObject([
    { phase: "pending-attach", wifiEnabledByOpensteer: false },
  ]);
  expect(f.native.calls.some(({ method }) => method === "setup.withdrawWifi")).toBe(true);
});

it("sets an existing Device up again on its stale phone, keeping its name and forgetting the old binding", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await boundAfterSetup(f);
  const detached = f.service.forSlot(ownerA).connect(() => undefined);
  await detached.request("iphone.targets", { assignments: [] }, f.options());
  const setup = new IphoneSetup(f.service);
  const target = { kind: "existing" as const, deviceId: f.deviceId, expectedGeneration: 1 };
  const state = await setup.begin(ownerA, target);
  expect(state.target).toEqual(target);
  f.native.calls = [];
  expect(await setup.choose(state.setupId, state.candidates[0]!.candidateId)).toMatchObject({
    step: "trust",
    reason: null,
  });
  const forget = f.native.calls.findIndex(({ method }) => method === "binding.forget");
  expect(f.native.calls[forget]?.params).toMatchObject({
    deviceId: f.deviceId,
    driverGeneration: 1,
  });
  expect(forget).toBeLessThan(
    f.native.calls.findIndex(({ method }) => method === "binding.acquire"),
  );
  expect(await f.store.records()).toMatchObject([{ setupId: state.setupId, phase: "reserved" }]);
  for (const step of ["trust", "developer-mode", "prepare", "observe"] as const)
    await setup.advance(state.setupId, step);
  await setup.wifi(state.setupId, "skip");
  const attached = await setup.advance(state.setupId, "attach");
  expect(attached.attachCommand).toMatchObject({ driverRunnerId: ownerA.runnerId, target });
  expect((await f.store.records())[0]?.userLabel).toBe("Test phone");
  await setup.complete(state.setupId, {
    type: "iphone.screen.attach",
    deviceId: f.deviceId,
    generation: 2,
  });
  await detached.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation: 2, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  expect(await setup.status(state.setupId)).toMatchObject({ step: "done", target });
  expect(await f.store.records()).toMatchObject([
    { deviceId: f.deviceId, driverGeneration: 2, phase: "bound", setupComplete: true },
  ]);
  detached.close();
});

it("refuses a phone that is already another Device, or still drives this one", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  await boundAfterSetup(f);
  const setup = new IphoneSetup(f.service);
  const other = await setup.begin(ownerA, {
    kind: "existing",
    deviceId: createId("device"),
    expectedGeneration: 3,
  });
  expect(await setup.choose(other.setupId, other.candidates[0]!.candidateId)).toMatchObject({
    step: "choose",
    reason: "phone-already-added",
  });
  const same = await setup.begin(ownerA, {
    kind: "existing",
    deviceId: f.deviceId,
    expectedGeneration: 1,
  });
  expect(await setup.choose(same.setupId, same.candidates[0]!.candidateId)).toMatchObject({
    step: "choose",
    reason: "phone-already-added",
  });
  const fresh = await setup.begin(ownerA);
  expect(await setup.choose(fresh.setupId, fresh.candidates[0]!.candidateId)).toMatchObject({
    reason: "phone-already-added",
  });
  expect(await f.store.records()).toMatchObject([
    { deviceId: f.deviceId, driverGeneration: 1, phase: "bound" },
  ]);
  expect(f.native.calls.some(({ method }) => method === "binding.forget")).toBe(false);
});
