import { afterEach, expect, it } from "vitest";
import { fixture, ownerA } from "./test-support.js";
import { IphoneSetup } from "./iphone-setup.js";

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
