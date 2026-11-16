import { afterEach, expect, it, vi } from "vitest";
import { fixture, ownerA } from "./test-support.js";
import { IphoneSetup } from "./iphone-setup.js";
import { IphoneServiceError } from "./iphone-store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
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
  await setup.wifi(state.setupId, "skip");
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
