import { expect, it, vi } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { BrowserPoolAdmissionClosed } from "@opensteer/database";
import {
  BrowserPoolAttemptRefused,
  BrowserPoolGate,
  BrowserPoolTargetOver,
  browserPoolUnsentNext,
} from "./browser-pool-gate.js";

function gate() {
  const inD = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const beforeCheck = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<boolean>();
  let wakes = 0;
  const wake = Promise.withResolvers<void>();
  const subject = new BrowserPoolGate();
  subject.set({ recovered: true, away: null, hold: null });
  // Stands in for the coordinator's loop: demand on a parked browser wakes it, once.
  subject.onChange = () => {
    if (subject.away !== "parked" || !subject.demand) return;
    wakes++;
    subject.set({ away: "waking" });
    void wake.promise.then(() => subject.set({ away: null }));
  };
  // Stands in for its park step: D's intent check runs inside its transaction, then it commits.
  const tryPark = async (): Promise<"parked" | "vetoed"> => {
    if (!subject.beginPark()) return "vetoed";
    inD.resolve();
    await beforeCheck.promise;
    const vetoed = subject.demandedSince();
    checked.resolve(vetoed);
    if (vetoed) {
      subject.endPark();
      return "vetoed";
    }
    await commit.promise;
    // After the commit the step asks again: a send during the commit still vetoes. The vetoed
    // park is undone, and the loop publishes the row read running again: only then is it open.
    if (!subject.committed()) {
      expect(subject.admits).toBe(false);
      subject.set({ away: null });
      return "vetoed";
    }
    subject.set({ away: "parked" });
    return "parked";
  };
  return { subject, tryPark, inD, beforeCheck, checked, commit, wake, wakes: () => wakes };
}

it("vetoes a park for demand that arrives before the intent check", async () => {
  const g = gate();
  const parking = g.tryPark();
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
  const parking = g.tryPark();
  await g.inD.promise;
  expect(g.subject.backgroundNow()).toBeUndefined();
  g.beforeCheck.resolve();
  expect(await parking).toBe("vetoed");
  const held = g.subject.backgroundNow();
  expect(held).toBeDefined();
  expect(await g.tryPark()).toBe("vetoed");
  held!.release();
  // Parked: background traffic waits and wakes nothing.
  const second = g.tryPark();
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
  const parking = g.tryPark();
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
  const parking = g.tryPark();
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
  expect(await g.tryPark()).toBe("parked");
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
  const parking = g.tryPark();
  await g.inD.promise;
  g.subject.set({ hold: "released" });
  g.beforeCheck.resolve();
  g.commit.resolve();
  expect(await parking).toBe("vetoed");
  expect(g.subject.phase).toBe("released");
  // Nothing that finishes later moves it, and a waiter with demand is refused without a wake.
  g.subject.set({ away: "parked" });
  g.subject.set({ away: "reconnecting", hold: null });
  expect(g.subject.phase).toBe("released");
  await expect(g.subject.reserve(new AbortController().signal)).rejects.toThrow("removed");
  expect(await g.tryPark()).toBe("vetoed");
  expect(g.wakes()).toBe(0);
});

for (const during of ["park", "reconnect"] as const)
  it(`holds admission through a restart while a ${during} in flight finishes`, async () => {
    const g = gate();
    let parking: Promise<"parked" | "vetoed"> | undefined;
    if (during === "park") {
      parking = g.tryPark();
      await g.inD.promise;
    } else g.subject.set({ away: "reconnecting" });
    g.subject.set({ hold: "restart" });
    // A waiter with demand arrives while the restart holds admission.
    const waiting = g.subject.reserve(AbortSignal.timeout(5_000));
    if (parking) {
      g.beforeCheck.resolve();
      g.commit.resolve();
      expect(await parking).toBe("vetoed");
    } else g.subject.set({ away: null });
    // Where the browser is was reported, but nothing is admitted, woken or parked.
    await settled();
    expect(g.subject.held).toBe(0);
    expect(await g.tryPark()).toBe("vetoed");
    expect(g.wakes()).toBe(0);
    // The restart installs its fresh guest and lets go: only now is the waiter admitted.
    g.subject.set({ away: null, hold: null });
    (await waiting).release();
    expect(g.subject.phase).toBe("open");
    expect(g.wakes()).toBe(0);
  });

it("lets only a command in flight hold a repair: a send with no demand neither keeps it from beginning nor vetoes it", async () => {
  const subject = new BrowserPoolGate();
  subject.set({ recovered: true, away: null, hold: null });
  // A viewer's send, admitted: an ordinary park cannot begin under it; a repair can.
  const frame = subject.backgroundNow()!;
  expect(subject.commands).toBe(0);
  expect(subject.beginPark()).toBe(false);
  expect(subject.beginPark(true)).toBe(true);
  // While the repair prepares, another send with no demand waits for the wake and vetoes nothing.
  expect(subject.backgroundNow()).toBeUndefined();
  const waiting = subject.background(AbortSignal.timeout(10_000));
  expect(subject.demandedSince()).toBe(false);
  expect(subject.committed()).toBe(true);
  subject.set({ away: null });
  (await waiting).release();
  frame.release();

  // A command in flight keeps a repair from beginning; its end lets it begin.
  const command = await subject.reserve(AbortSignal.timeout(10_000));
  expect(subject.commands).toBe(1);
  expect(subject.beginPark(true)).toBe(false);
  const idle = subject.commandsIdle();
  command.release();
  await idle;
  expect(subject.commands).toBe(0);
  // One that arrives while the repair prepares vetoes it, as it does any park.
  expect(subject.beginPark(true)).toBe(true);
  const late = subject.reserve(AbortSignal.timeout(10_000));
  expect(subject.demandedSince()).toBe(true);
  subject.endPark();
  (await late).release();
});

it("marks waited on a reservation only when the caller actually suspended", async () => {
  const g = gate();
  const immediate = await g.subject.reserve(new AbortController().signal);
  expect(immediate.waited).toBeUndefined();
  immediate.release();

  g.beforeCheck.resolve();
  g.commit.resolve();
  expect(await g.tryPark()).toBe("parked");
  const waiting = g.subject.reserve(new AbortController().signal);
  await vi.waitFor(() => expect(g.subject.phase).toBe("waking"));
  g.wake.resolve();
  const resumed = await waiting;
  expect(resumed.waited).toBe(true);
  resumed.release();
});

it("signals idle-state changes whenever admission, reservations, or viewers change", async () => {
  const subject = new BrowserPoolGate();
  let changes = 0;
  subject.onIdleStateChanged = () => {
    changes++;
  };
  subject.set({ recovered: true, away: null, hold: null });
  expect(changes).toBe(1);
  const res = await subject.reserve(new AbortController().signal);
  expect(changes).toBe(2);
  const stopViewing = subject.viewing();
  expect(changes).toBe(3);
  res.release();
  expect(changes).toBe(4);
  expect(subject.held).toBe(0);
  expect(subject.viewers).toBe(1);
  stopViewing();
  expect(changes).toBe(5);
  expect(subject.viewers).toBe(0);
});

it("ends failOnRefusal waiters at once on noteAttemptRefused while default waiters keep waiting", async () => {
  const subject = new BrowserPoolGate();
  subject.set({ recovered: true, away: "parked", hold: null });
  let asks = 0;
  subject.onChange = () => {
    asks++;
  };

  const defaultWaiter = subject.reserve(new AbortController().signal);
  const optInWaiter = subject.reserve(new AbortController().signal, { failOnRefusal: true });
  await Promise.resolve();
  expect(asks).toBe(2);

  subject.noteAttemptRefused("egress-proxy-down");
  await expect(optInWaiter).rejects.toBeInstanceOf(BrowserPoolAttemptRefused);
  expect(subject.demand).toBe(true);

  // Synchronous refusal inside onChange() must also wake the caller without missing the notify.
  subject.onChange = () => {
    asks++;
    subject.noteAttemptRefused("profile-disk-missing");
  };
  await expect(
    subject.reserve(new AbortController().signal, { failOnRefusal: true }),
  ).rejects.toMatchObject({
    name: "BrowserPoolAttemptRefused",
    refusedReason: "profile-disk-missing",
  });

  // Opening admission resolves the default waiter that stayed waiting across both refusals.
  subject.set({ away: null });
  const held = await defaultWaiter;
  expect(held.waited).toBe(true);
  held.release();
  expect(subject.demand).toBe(false);
});

it("tells the agent that nothing was sent and it may call again when a wait runs out or the target is over", async () => {
  const subject = new BrowserPoolGate();
  subject.set({ recovered: true, away: "parked", hold: null });
  const deadline = new AbortController();
  const waiting = subject.reserve(deadline.signal);
  deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
  const late = await waiting.catch((error: unknown) => error);
  expect(late).toBeInstanceOf(BrowserPoolAdmissionClosed);
  expect(late).toMatchObject({
    message: "The pooled browser did not wake in time. Nothing was sent.",
    next: browserPoolUnsentNext,
  });
  // A target over by its host's signed word: refused at once, with the same advice.
  subject.set({ hold: "over" });
  const over = await subject.reserve(new AbortController().signal).catch((error: unknown) => error);
  expect(over).toMatchObject({
    message: "This browser is not ready. Nothing was sent.",
    next: browserPoolUnsentNext,
  });
  expect(over).toBeInstanceOf(BrowserPoolTargetOver);
  expect(browserPoolUnsentNext).toBe("Nothing was sent. It is safe to call again.");
});

it("refuses a waiter of a target that goes over with one class a caller can follow, in the same words", async () => {
  const subject = new BrowserPoolGate();
  subject.set({ recovered: true, away: "waking", hold: null });
  const waiting = subject.reserve(new AbortController().signal);
  subject.set({ hold: "over" });
  const refused = await waiting.catch((error: unknown) => error);
  // A caller that can find the Home's next target follows it; anyone else reads these words.
  expect(refused).toBeInstanceOf(BrowserPoolTargetOver);
  expect(refused).toBeInstanceOf(BrowserPoolAdmissionClosed);
  expect(refused).toMatchObject({
    message: "This browser is not ready. Nothing was sent.",
    next: browserPoolUnsentNext,
  });
});
