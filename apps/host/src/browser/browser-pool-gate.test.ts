import { expect, it, vi } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { BrowserPoolAdmissionClosed } from "@opensteer/database";
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
      // After the commit the driver asks again: a send during the commit still vetoes.
      return subject.committed() ? "parked" : "vetoed";
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
  waiting.abort(new OpensteerError({ code: "conflict", message: "Ended" }));
  await expect(background).rejects.toThrow("Ended");
});

it("vetoes a park for a send that arrives while the intent is being committed", async () => {
  const g = gate();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  g.beforeCheck.resolve();
  expect(await g.checked.promise).toBe(false);
  // The intent is written but not committed: the gate is still before D.
  expect(g.subject.phase).toBe("preparing");
  const send = g.subject.reserve(new AbortController().signal);
  g.commit.resolve();
  expect(await parking).toBe("vetoed");
  (await send).release();
  expect(g.wakes()).toBe(0);
});

it("makes a send after the commit wait for one wake, and Stop while waiting dispatches nothing", async () => {
  const g = gate();
  g.beforeCheck.resolve();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  expect(await g.checked.promise).toBe(false);
  g.commit.resolve();
  expect(await parking).toBe("parked");
  const stop = new AbortController();
  let dispatched = 0;
  const cancelled = g.subject.reserve(stop.signal).then(() => dispatched++);
  const first = g.subject.reserve(new AbortController().signal);
  const second = g.subject.reserve(new AbortController().signal);
  stop.abort(new OpensteerError({ code: "conflict", message: "Stopped" }));
  await expect(cancelled).rejects.toThrow("Stopped");
  await vi.waitFor(() => expect(g.subject.phase).toBe("waking"));
  g.wake.resolve();
  (await first).release();
  (await second).release();
  expect([g.wakes(), dispatched]).toEqual([1, 0]);
});

it("answers a wake that runs out of time with a refusal before any effect", async () => {
  const g = gate();
  g.beforeCheck.resolve();
  g.commit.resolve();
  expect(await g.subject.tryPark()).toBe("parked");
  const refused = await g.subject.reserve(AbortSignal.timeout(10)).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(BrowserPoolAdmissionClosed);
  expect(refused).toBeInstanceOf(OpensteerError);
  g.wake.resolve();
});

/** Lets every queued promise reaction run, so a reservation that could be granted is. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

it("stays released for good when a park in flight finishes after the removal, and never wakes", async () => {
  const g = gate();
  const parking = g.subject.tryPark();
  await g.inD.promise;
  g.subject.released();
  g.beforeCheck.resolve();
  g.commit.resolve();
  expect(await parking).toBe("vetoed");
  expect(g.subject.phase).toBe("released");
  // Nothing that finishes later moves it, and a waiter with demand is refused without a wake.
  g.subject.settle("parked");
  g.subject.reconnecting();
  expect(g.subject.phase).toBe("released");
  await expect(g.subject.reserve(new AbortController().signal)).rejects.toThrow("removed");
  expect(await g.subject.tryPark()).toBe("vetoed");
  expect(g.wakes()).toBe(0);
});

for (const during of ["park", "reconnect"] as const)
  it(`holds admission through a restart while a ${during} in flight finishes`, async () => {
    const g = gate();
    let parking: Promise<"parked" | "vetoed"> | undefined;
    if (during === "park") {
      parking = g.subject.tryPark();
      await g.inD.promise;
    } else g.subject.reconnecting();
    const done = g.subject.restarting();
    // A waiter with demand arrives while the restart holds admission.
    const waiting = g.subject.reserve(AbortSignal.timeout(5_000));
    if (parking) {
      g.beforeCheck.resolve();
      g.commit.resolve();
      expect(await parking).toBe("vetoed");
    } else g.subject.settle("open");
    // Where the browser is was reported, but nothing is admitted, woken or parked.
    await settled();
    expect(g.subject.held).toBe(0);
    expect(await g.subject.tryPark()).toBe("vetoed");
    expect(g.wakes()).toBe(0);
    // The restart installs its fresh guest and lets go: only now is the waiter admitted.
    g.subject.settle("open");
    done();
    (await waiting).release();
    expect(g.subject.phase).toBe("open");
    expect(g.wakes()).toBe(0);
  });
