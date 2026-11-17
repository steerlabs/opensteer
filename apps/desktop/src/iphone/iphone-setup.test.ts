import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type DeviceId, createId } from "@opensteer/core";
import type { DesktopIphoneSetupStatus } from "@opensteer/protocol/desktop";
import { fixture, ownerA, ownerB, FakeIphoneMacSupport } from "./test-support.js";
import { IphoneSetup } from "./iphone-setup.js";
import { IphoneServiceError } from "./iphone-store.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }),
);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
async function harness() {
  const f = await fixture();
  const mac = new FakeIphoneMacSupport();
  const setup = new IphoneSetup(f.service, mac);
  cleanups.push(f.cleanup, () => setup.stop());
  return { ...f, setup, mac };
}
function until(
  setup: IphoneSetup,
  setupId: string,
  predicate: (s: DesktopIphoneSetupStatus) => boolean,
) {
  return new Promise<DesktopIphoneSetupStatus>((resolve, reject) => {
    let off = () => {};
    let settled = false;
    const deadline = setTimeout(() => {
      off();
      reject(new Error("Setup never reached the expected status"));
    }, 1000);
    off = setup.subscribe(setupId, (state) => {
      if (!predicate(state)) return;
      settled = true;
      clearTimeout(deadline);
      off();
      resolve(state);
    });
    if (settled) off();
  });
}
const stage = (
  f: Awaited<ReturnType<typeof harness>>,
  id: string,
  expected: DesktopIphoneSetupStatus["stage"],
) => until(f.setup, id, (s) => s.stage === expected && s.state !== "working");
async function wifiReady(f: Awaited<ReturnType<typeof harness>>) {
  const initial = await f.setup.begin(ownerA);
  return stage(f, initial.setupId, "wifi");
}
async function assign(f: Awaited<ReturnType<typeof harness>>, generation = 1) {
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  cleanups.push(async () => connection.close());
  await connection.request(
    "iphone.targets",
    {
      assignments: [
        { deviceId: f.deviceId, generation, role: "screen", definitionId: "iphone-screen" },
      ],
    },
    f.options(),
  );
  return connection;
}
const result = (deviceId: DeviceId, generation = 1) => ({
  type: "iphone.screen.attach" as const,
  deviceId,
  generation,
});

it("drives every stage, publishes progress, and completes on assignment without renderer polling", async () => {
  const f = await harness();
  const initial = await f.setup.begin(ownerA);
  expect(initial).toMatchObject({ stage: "mac", state: "working" });
  const stages: string[] = [];
  const revisions: number[] = [];
  f.setup.subscribe(initial.setupId, (s) => {
    stages.push(s.stage);
    revisions.push(s.revision);
  });
  const wifi = await stage(f, initial.setupId, "wifi");
  expect(wifi).toMatchObject({
    state: "decide",
    action: "choose-wifi",
    suggestedName: "Test phone screen",
    phone: { name: "Test phone" },
  });
  expect(f.native.calls.some((c) => c.method === "setup.enableWifi")).toBe(false);
  expect(await f.setup.wifi(initial.setupId, "usb-only")).toMatchObject({
    stage: "add",
    action: "name-phone",
  });
  const pending = await f.setup.add(initial.setupId);
  expect(pending.attachCommand).toMatchObject({
    idempotencyKey: initial.setupId,
    target: { kind: "new", name: "Test phone screen" },
  });
  expect((await f.store.records())[0]?.phase).toBe("pending-attach");
  expect(await f.setup.complete(initial.setupId, result(f.deviceId))).toMatchObject({
    stage: "add",
    state: "waiting",
    reason: "assignment-pending",
  });
  const done = stage(f, initial.setupId, "done");
  await assign(f);
  expect(await done).toMatchObject({ state: "done", action: "none", reason: null });
  expect(initial.revision).toBeGreaterThan(0);
  expect(
    revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
  ).toBe(true);
  expect((await f.setup.status(initial.setupId)).revision).toBe(revisions.at(-1));
  expect([...new Set(stages)]).toEqual([
    "mac",
    "connect",
    "trust",
    "developer-mode",
    "prepare",
    "wifi",
    "add",
    "done",
  ]);
  expect(await f.store.records()).toMatchObject([{ setupComplete: true }]);
  expect(f.mac.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("detects missing Xcode before any phone, opens the offered helper, and resumes when support appears", async () => {
  const f = await harness();
  f.mac.xcodeApps = [];
  f.native.images = [];
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "mac")).toMatchObject({
    state: "waiting",
    reason: "xcode-missing",
    action: "get-xcode",
    candidates: [],
  });
  expect(f.native.calls.some((c) => c.method === "phone.identity")).toBe(false);
  expect(await f.setup.help(initial.setupId, "get-xcode")).toMatchObject({
    reason: "xcode-installing",
    action: "none",
  });
  expect(await stage(f, initial.setupId, "mac")).toMatchObject({
    reason: "xcode-installing",
    action: "none",
  });
  expect(await f.setup.retry(initial.setupId)).toMatchObject({
    reason: "xcode-installing",
    action: "none",
  });
  f.mac.xcodeApps = ["/Applications/Xcode-Beta.app"];
  const required = until(f.setup, initial.setupId, (s) => s.reason === "xcode-setup-required");
  f.mac.changed();
  expect(await required).toMatchObject({ action: "open-xcode" });
  await f.setup.help(initial.setupId, "open-xcode");
  await stage(f, initial.setupId, "mac");
  f.native.images = [{ handle: "fresh", build: "test" }];
  const ready = stage(f, initial.setupId, "wifi");
  f.mac.changed();
  await ready;
  expect(f.mac.helps).toEqual(["get-xcode", "open-xcode"]);
  expect(
    f.native.calls.find((c) => c.method === "setup.prepareDeveloperServices")?.params,
  ).toMatchObject({ imageHandle: "fresh" });
});

it("waits for a USB roster event and automatically chooses the only usable phone", async () => {
  const f = await harness();
  const candidate = f.native.roster.candidates[0]!;
  f.native.roster = { revision: 2, candidates: [] };
  f.native.publish();
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "connect")).toMatchObject({
    state: "waiting",
    reason: "no-phone",
  });
  expect(vi.getTimerCount()).toBe(0);
  const ready = stage(f, initial.setupId, "wifi");
  f.native.roster = { revision: 3, candidates: [candidate] };
  f.native.publish();
  await ready;
});

it("offers several usable phones, preserves candidate IDs, and reserves only the choice", async () => {
  const f = await harness();
  f.native.identities.set("candidate", "synthetic-other-phone");
  f.native.roster.candidates.push({
    ...f.native.roster.candidates[0]!,
    localPhoneId: "other",
    name: "Other phone",
    trusted: false,
  });
  f.native.roster.revision++;
  f.native.publish();
  const initial = await f.setup.begin(ownerA);
  const choice = await stage(f, initial.setupId, "connect");
  expect(choice).toMatchObject({ state: "decide", action: "choose-phone", reason: null });
  expect(choice.candidates.map((c) => c.trusted)).toEqual([true, false]);
  const next = until(
    f.setup,
    initial.setupId,
    (s) => s.stage === "connect" && s.state === "decide" && s.candidates[1]?.name === "Renamed",
  );
  f.native.roster.candidates[1]!.name = "Renamed";
  f.native.roster.revision++;
  f.native.publish();
  expect((await next).candidates.map((c) => c.candidateId)).toEqual(
    choice.candidates.map((c) => c.candidateId),
  );
  expect(await f.setup.choose(initial.setupId, choice.candidates[1]!.candidateId)).toMatchObject({
    stage: "wifi",
    phone: { name: "Renamed" },
  });
  expect((await f.store.records())[0]?.localPhoneId).toBe("other");
});

it("rechecks pending trust internally and continues as soon as pairing succeeds", async () => {
  const f = await harness();
  f.native.inspection.pairing = "unknown";
  f.native.failures.set("setup.pair", new IphoneServiceError("trust-pending"));
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "trust")).toMatchObject({
    state: "waiting",
    reason: "trust-pending",
  });
  f.native.failures.delete("setup.pair");
  f.native.inspection.pairing = "paired";
  await vi.advanceTimersByTimeAsync(2000);
  await stage(f, initial.setupId, "wifi");
  expect(vi.getTimerCount()).toBe(0);
});

it("retries denied trust only on request", async () => {
  const f = await harness();
  f.native.inspection.pairing = "unknown";
  f.native.failures.set("setup.pair", new IphoneServiceError("trust-denied"));
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "trust")).toMatchObject({
    state: "blocked",
    reason: "trust-denied",
    action: "retry",
  });
  expect(vi.getTimerCount()).toBe(0);
  f.native.failures.delete("setup.pair");
  f.native.inspection.pairing = "paired";
  expect(await f.setup.retry(initial.setupId)).toMatchObject({ stage: "wifi" });
});

it("reveals Developer Mode and follows the same private identity through restart and a new epoch and local ID", async () => {
  const f = await harness();
  f.native.inspection.developerMode = "disabled";
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "developer-mode")).toMatchObject({
    state: "waiting",
    reason: "developer-mode-required",
  });
  expect(f.native.calls).toContainEqual({
    method: "setup.revealDeveloperMode",
    params: { localPhoneId: "candidate", nativeEpoch: 1 },
  });
  const disconnected = until(f.setup, initial.setupId, (s) => s.reason === "phone-disconnected");
  const candidate = f.native.roster.candidates[0]!;
  f.native.roster = { revision: f.native.roster.revision + 1, candidates: [] };
  f.native.publish();
  await disconnected;
  f.native.inspection.developerMode = "enabled";
  f.native.epoch = 2;
  const ready = stage(f, initial.setupId, "wifi");
  f.native.roster = {
    revision: f.native.roster.revision + 1,
    candidates: [{ ...candidate, localPhoneId: "reconnected", nativeEpoch: 2 }],
  };
  f.native.publish();
  await ready;
  expect(f.native.calls).toContainEqual({
    method: "setup.revealDeveloperMode",
    params: { localPhoneId: "reconnected", nativeEpoch: 2 },
  });
  expect((await f.store.records())[0]?.localPhoneId).toBe("reconnected");
});

it("maps locked preparation to a phone wait and personalization failure to a retriable block", async () => {
  const f = await harness();
  f.native.failures.set("setup.prepareDeveloperServices", new IphoneServiceError("phone-locked"));
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "prepare")).toMatchObject({
    state: "waiting",
    reason: "phone-locked",
  });
  f.native.failures.set(
    "setup.prepareDeveloperServices",
    new IphoneServiceError("personalization-network-unavailable"),
  );
  expect(await f.setup.retry(initial.setupId)).toMatchObject({
    state: "blocked",
    reason: "personalization-network-unavailable",
    action: "retry",
  });
  f.native.failures.delete("setup.prepareDeveloperServices");
  expect(await f.setup.retry(initial.setupId)).toMatchObject({ stage: "wifi" });
});

it("discards late results and releases reservations when cancelled mid-stage", async () => {
  const f = await harness();
  const held = Promise.withResolvers<void>();
  f.native.held.set("setup.prepareDeveloperServices", held.promise);
  const initial = await f.setup.begin(ownerA);
  await vi.waitFor(
    () =>
      expect(f.native.calls.some((c) => c.method === "setup.prepareDeveloperServices")).toBe(true),
    { timeout: 1000 },
  );
  const states: DesktopIphoneSetupStatus[] = [];
  f.setup.subscribe(initial.setupId, (s) => states.push(s));
  const cancelled = f.setup.cancel(initial.setupId);
  const count = states.length;
  held.resolve();
  await cancelled;
  expect(states).toHaveLength(count);
  expect(f.native.calls.some((c) => c.method === "phone.observe")).toBe(false);
  expect(await f.store.records()).toEqual([]);
  await expect(f.setup.status(initial.setupId)).rejects.toMatchObject({ code: "cancelled" });
  expect(f.mac.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a late binding acquisition on slot invalidation", async () => {
  const f = await harness();
  const connection = f.service.forSlot(ownerA).connect(() => undefined);
  await connection.request("iphone.targets", { assignments: [] }, f.options());
  const held = Promise.withResolvers<void>();
  f.native.held.set("binding.acquire", held.promise);
  const initial = await f.setup.begin(ownerA);
  await vi.waitFor(
    () => expect(f.native.calls.some((c) => c.method === "binding.acquire")).toBe(true),
    { timeout: 1000 },
  );
  const stopped = f.service.stopForSlot(ownerA.deploymentId);
  held.resolve();
  await stopped;
  await f.setup.stop();
  expect(await f.store.records()).toEqual([]);
  expect(f.native.calls.some((c) => c.method === "binding.release")).toBe(true);
  await expect(f.setup.status(initial.setupId)).rejects.toMatchObject({ code: "cancelled" });
  connection.close();
});

it("persists Wi-Fi only after pairing and keeps a failed choice optional", async () => {
  const f = await harness();
  const ready = await wifiReady(f);
  f.native.failures.set("setup.pairWifi", new IphoneServiceError("wifi-pairing-required"));
  expect(await f.setup.wifi(ready.setupId, "wifi")).toMatchObject({
    stage: "wifi",
    reason: "wifi-pairing-required",
    wifiEnabled: false,
  });
  expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
  expect(f.native.calls.some((c) => c.method === "setup.withdrawWifi")).toBe(true);
  expect(await f.setup.wifi(ready.setupId, "usb-only")).toMatchObject({
    stage: "add",
    reason: null,
  });
});

it("retains a dispatched attach across cancellation and restart with the same command", async () => {
  const f = await harness();
  const ready = await wifiReady(f);
  await f.setup.wifi(ready.setupId, "wifi");
  const pending = await f.setup.add(ready.setupId, "Chosen name");
  await f.setup.cancel(ready.setupId);
  expect(await f.store.records()).toMatchObject([
    { phase: "pending-attach", wifiEnabledByOpensteer: false },
  ]);
  const restarted = await f.setup.begin(ownerA);
  const resumed = await stage(f, restarted.setupId, "add");
  expect(resumed.attachCommand).toEqual(pending.attachCommand);
  expect(resumed.setupId).toBe(ready.setupId);
  expect(await f.setup.add(resumed.setupId, "Changed too late")).toMatchObject({
    reason: "attach-conflict",
    attachCommand: pending.attachCommand,
  });
  expect((await f.setup.add(resumed.setupId, "Chosen name")).attachCommand).toEqual(
    pending.attachCommand,
  );
});

it("recovers local completion persistence and confirms an assignment that arrived before the reply", async () => {
  const f = await harness();
  const ready = await wifiReady(f);
  await f.setup.wifi(ready.setupId, "usb-only");
  await f.setup.add(ready.setupId);
  await assign(f);
  f.failWrite();
  expect(await f.setup.complete(ready.setupId, result(f.deviceId))).toMatchObject({
    reason: "local-mapping-save-failed",
    action: "retry",
  });
  expect(await f.setup.retry(ready.setupId)).toMatchObject({ stage: "done" });
  expect(await f.service.targets(ownerA.deploymentId)).toMatchObject([
    { ready: true, reason: null },
  ]);
});

it("sets up an attached Device that needs setup without detaching or renaming it", async () => {
  const f = await harness();
  await f.bind();
  await f.service.save({ ...(await f.store.records())[0]!, setupComplete: true });
  f.native.roster.candidates[0]!.reason = "developer-mode-required";
  f.native.roster.candidates[0]!.capabilities!.observe = "developer-mode-required";
  // A setup-capable USB candidate is selectable even when its assigned driver needs setup.
  f.native.roster.candidates[0]!.reason = null;
  f.native.roster.revision++;
  f.native.publish();
  const target = { kind: "existing" as const, deviceId: f.deviceId, expectedGeneration: 1 };
  f.native.calls = [];
  const initial = await f.setup.begin(ownerA, target);
  const ready = await stage(f, initial.setupId, "wifi");
  expect(ready.target).toEqual(target);
  expect(ready.suggestedName).toBe("Test phone");
  const forget = f.native.calls.findIndex(
    (c) => c.method === "binding.release" && (c.params as { forget?: boolean }).forget,
  );
  expect(forget).toBeGreaterThanOrEqual(0);
  expect(forget).toBeLessThan(f.native.calls.findIndex((c) => c.method === "binding.acquire"));
  await f.setup.wifi(initial.setupId, "usb-only");
  expect((await f.setup.add(initial.setupId, "Ignored")).attachCommand?.target).toEqual(target);
  expect((await f.store.records())[0]?.userLabel).toBe("Test phone");
});

it("refuses a phone assigned to another Device or still ready for this Device", async () => {
  const f = await harness();
  await f.bind();
  await f.service.save({ ...(await f.store.records())[0]!, setupComplete: true });
  for (const target of [
    { kind: "existing" as const, deviceId: createId("device"), expectedGeneration: 1 },
    { kind: "existing" as const, deviceId: f.deviceId, expectedGeneration: 1 },
  ]) {
    const initial = await f.setup.begin(ownerA, target);
    expect(await stage(f, initial.setupId, "connect")).toMatchObject({
      state: "blocked",
      reason: "phone-already-added",
    });
  }
  expect(await f.store.records()).toMatchObject([{ phase: "bound", deviceId: f.deviceId }]);
  expect(f.native.calls.some((c) => c.method === "binding.forget")).toBe(false);
});

it("rejects another Deployment's private reservation", async () => {
  const f = await harness();
  await wifiReady(f);
  const initial = await f.setup.begin(ownerB);
  expect(await stage(f, initial.setupId, "connect")).toMatchObject({
    reason: "owned-by-another-deployment",
  });
});

it("blocks at Mac prerequisites when the bridge is unavailable and retries that stage", async () => {
  const f = await harness();
  const discover = vi
    .spyOn(f.service, "discover")
    .mockRejectedValueOnce(new IphoneServiceError("bridge-not-built"));
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "mac")).toMatchObject({
    state: "blocked",
    reason: "bridge-not-built",
    action: "retry",
    candidates: [],
  });
  expect(f.native.calls.some((c) => c.method === "phone.identity")).toBe(false);
  expect(await f.setup.retry(initial.setupId)).toMatchObject({ stage: "wifi" });
  discover.mockRestore();
});

it("resumes a reserved phone after a crash and a completed attach awaiting assignment", async () => {
  const f = await harness();
  const reservation = await f.service.reserve(ownerA, "candidate", crypto.randomUUID());
  const initial = await f.setup.begin(ownerA);
  expect(initial.setupId).toBe(reservation.setupId);
  await stage(f, initial.setupId, "wifi");
  await f.setup.wifi(initial.setupId, "usb-only");
  await f.setup.add(initial.setupId);
  await f.setup.complete(initial.setupId, result(f.deviceId));
  await f.setup.cancel(initial.setupId);
  const resumed = await f.setup.begin(ownerA);
  expect(await stage(f, resumed.setupId, "add")).toMatchObject({
    reason: "assignment-pending",
    attachCommand: null,
    deviceId: f.deviceId,
  });
  const done = stage(f, resumed.setupId, "done");
  await assign(f);
  await done;
});

it("does not persist Wi-Fi enabled before both native enablement and pairing finish", async () => {
  const f = await harness();
  const ready = await wifiReady(f);
  const enabled = Promise.withResolvers<void>();
  const paired = Promise.withResolvers<void>();
  f.native.held.set("setup.enableWifi", enabled.promise);
  f.native.held.set("setup.pairWifi", paired.promise);
  const enabling = f.setup.wifi(ready.setupId, "wifi");
  try {
    await vi.waitFor(
      () => expect(f.native.calls.some((c) => c.method === "setup.enableWifi")).toBe(true),
      { timeout: 1000 },
    );
    expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
    enabled.resolve();
    await vi.waitFor(
      () => expect(f.native.calls.some((c) => c.method === "setup.pairWifi")).toBe(true),
      { timeout: 1000 },
    );
    expect((await f.store.records())[0]?.wifiEnabledByOpensteer).toBe(false);
  } finally {
    enabled.resolve();
    paired.resolve();
  }
  expect(await enabling).toMatchObject({ stage: "add", wifiEnabled: true });
});

it("waits on Local Network permission, opens its settings, and resumes after access", async () => {
  const f = await harness();
  const ready = await wifiReady(f);
  f.native.failures.set(
    "setup.pairWifi",
    new IphoneServiceError("local-network-permission-required"),
  );
  expect(await f.setup.wifi(ready.setupId, "wifi")).toMatchObject({
    state: "waiting",
    reason: "local-network-permission-required",
    action: "open-local-network",
  });
  await expect(f.setup.help(ready.setupId, "get-xcode")).rejects.toMatchObject({
    code: "no-session",
  });
  await f.setup.help(ready.setupId, "open-local-network");
  expect(f.mac.helps).toEqual(["open-local-network"]);
  f.native.failures.delete("setup.pairWifi");
  expect(await f.setup.retry(ready.setupId)).toMatchObject({ stage: "add", reason: null });
});

it("recognizes an incomplete Xcode installation before Get Xcode is pressed", async () => {
  const f = await harness();
  f.mac.xcodeApps = [];
  f.mac.xcodeInstalling = true;
  const initial = await f.setup.begin(ownerA);
  expect(await stage(f, initial.setupId, "mac")).toMatchObject({
    reason: "xcode-installing",
    action: "none",
  });
});
