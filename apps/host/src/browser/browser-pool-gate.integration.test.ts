import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  readBrowserPoolSlot,
  requireBrowserPoolAdmission,
  type BrowserPoolTargetIdentity,
} from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BrowserPoolGate } from "./browser-pool-gate.js";

it("orders park intent against demand and wakes once without dispatching a cancelled waiter", async () => {
  const fixture = await createStoreFixture();
  const hold = Promise.withResolvers<void>();
  const wake = Promise.withResolvers<void>();
  try {
    const task = await fixture.createRunFixture("browser-pool");
    const { database } = fixture;
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "pool-slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const afterD = Promise.withResolvers<void>();
    const wakeStarted = Promise.withResolvers<void>();
    let wakes = 0;
    let dispatched = 0;
    const read = () => readBrowserPoolSlot(database, target.runnerId);
    const gate = new BrowserPoolGate({
      read,
      begin: async (id, demanded) => {
        await beginBrowserPoolPark(database, target, id, demanded);
        throw new Error("Commit reply lost");
      },
      park: async (slot) => {
        afterD.resolve();
        await hold.promise;
        return advanceBrowserPoolSlot(database, slot, { ...slot, phase: "parked", retained: null });
      },
      abortPark: (slot) => advanceBrowserPoolSlot(database, slot, { ...slot, phase: "running" }),
      wake: async (slot) => {
        wakes++;
        wakeStarted.resolve();
        await wake.promise;
        return advanceBrowserPoolSlot(database, slot, { ...slot, phase: "running" });
      },
    });
    gate.recovered(undefined);
    const stop = new AbortController();
    const first = await gate.reserve(stop.signal);
    expect(await gate.tryPark()).toBe("vetoed");
    expect(await read()).toBeUndefined();
    first.release();
    const parking = gate.tryPark();
    await afterD.promise;
    expect(await read()).toMatchObject({ phase: "preparing", intentSequence: 1 });
    await expect(
      commitPersonalMutation(database, (tx) => requireBrowserPoolAdmission(tx, target.runnerId)),
    ).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
    const cancelled = expect(
      gate.reserve(stop.signal).then(() => {
        dispatched++;
      }),
    ).rejects.toThrow("Stopped");
    const next = gate.reserve(new AbortController().signal);
    const other = gate.reserve(new AbortController().signal);
    stop.abort(new Error("Stopped"));
    await cancelled;
    expect(wakes).toBe(0);
    hold.resolve();
    expect(await parking).toBe("parked");
    await wakeStarted.promise;
    expect([wakes, dispatched]).toEqual([1, 0]);
    wake.resolve();
    (await next).release();
    (await other).release();
    expect(wakes).toBe(1);
    await expect(
      commitPersonalMutation(database, (tx) => requireBrowserPoolAdmission(tx, target.runnerId)),
    ).resolves.toBeUndefined();
  } finally {
    hold.resolve();
    wake.resolve();
    await fixture.close();
  }
});

it("vetoes D on an ended session with confined CDP contact loss", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("park-cdp-loss");
    const { database } = fixture;
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "pool-slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await personalBrowserRepository(fixture.store).createBrowserSession({
      ownerId: task.userId,
      id: sessionId,
      origin: "person",
      placementKey: "pool-test",
      profileId: null,
      runnerId: target.runnerId,
      runtimeId: target.runtimeId,
    });
    const attachmentId = randomUUID();
    const lost = { runtimeBootId: target.instanceId, contactLostAt: new Date().toISOString() };
    await database
      .updateTable("browserSessions")
      .set({
        state: "closed",
        closedAt: new Date(),
        standardCdpAttempts: { [attachmentId]: lost },
      })
      .where("id", "=", sessionId)
      .execute();
    const begin = () => beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(await begin()).toBeUndefined();
    expect(await readBrowserPoolSlot(database, target.runnerId)).toBeUndefined();
    await database
      .updateTable("browserSessions")
      .set({
        standardCdpAttempts: {
          [attachmentId]: { ...lost, terminalEvidenceAt: new Date().toISOString() },
        },
      })
      .where("id", "=", sessionId)
      .execute();
    expect(await begin()).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});
