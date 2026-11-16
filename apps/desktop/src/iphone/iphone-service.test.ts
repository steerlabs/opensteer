import { afterEach, expect, it, vi } from "vitest";
import { fixture, ownerA, ownerB } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
  f.native.roster = { revision: 2, candidates: [] };
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
