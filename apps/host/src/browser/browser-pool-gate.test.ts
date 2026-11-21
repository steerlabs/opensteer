import { expect, it, vi } from "vitest";
import { BrowserPoolGate } from "./browser-pool-gate.js";

function gate() {
  const inD = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const beforeCheck = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<boolean>();
  let wakes = 0;
  const wake = Promise.withResolvers<void>();
  const subject = new BrowserPoolGate();
  subject.attach({
    // Stands in for D: the intent check runs inside its transaction, then it commits.
    park: async (demanded) => {
      inD.resolve();
      await beforeCheck.promise;
      const vetoed = demanded();
      checked.resolve(vetoed);
      if (vetoed) return "vetoed";
      await commit.promise;
      return "parked";
    },
    wake: async () => {
      wakes++;
      await wake.promise;
      subject.settle("open");
    },
  });
  subject.settle("open");
  return { subject, inD, beforeCheck, checked, commit, wake, wakes: () => wakes };
}

it("vetoes a park for demand that arrives before the intent check", async () => {
  const g = gate();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  const demand = g.subject.reserve(new AbortController().signal);
  g.beforeCheck.resolve();
  expect(await g.checked.promise).toBe(true);
  expect(await parking).toBe("vetoed");
  (await demand).release();
  expect(g.wakes()).toBe(0);
});

it("vetoes a park for a background send queued before the intent check, and never wakes for one", async () => {
  const g = gate();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  expect(g.subject.backgroundNow()).toBeUndefined();
  g.beforeCheck.resolve();
  expect(await parking).toBe("vetoed");
  const held = g.subject.backgroundNow();
  expect(held).toBeDefined();
  expect(await g.subject.tryPark()).toBe("vetoed");
  held!.release();
  // Parked: background traffic waits and wakes nothing.
  const second = g.subject.tryPark();
  g.commit.resolve();
  expect(await second).toBe("parked");
  const waiting = new AbortController();
  const background = g.subject.background(waiting.signal);
  // A wake would have started synchronously inside the call.
  await Promise.resolve();
  expect(g.subject.phase).toBe("parked");
  expect(g.wakes()).toBe(0);
  waiting.abort(new Error("Ended"));
  await expect(background).rejects.toThrow("Ended");
});

it("makes a send that arrives while the intent is being written wait for one wake", async () => {
  const g = gate();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  g.beforeCheck.resolve();
  expect(await g.checked.promise).toBe(false);
  expect(g.subject.phase).toBe("parking");
  const stop = new AbortController();
  let dispatched = 0;
  const cancelled = g.subject.reserve(stop.signal).then(() => dispatched++);
  const first = g.subject.reserve(new AbortController().signal);
  const second = g.subject.reserve(new AbortController().signal);
  stop.abort(new Error("Stopped"));
  await expect(cancelled).rejects.toThrow("Stopped");
  g.commit.resolve();
  expect(await parking).toBe("parked");
  await vi.waitFor(() => expect(g.subject.phase).toBe("waking"));
  g.wake.resolve();
  (await first).release();
  (await second).release();
  expect([g.wakes(), dispatched]).toEqual([1, 0]);
});
