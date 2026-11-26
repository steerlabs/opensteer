import { describe, expect, it, vi } from "vitest";
import { OrderedInputLane } from "./ordered-input-lane.js";

/**
 * One stream's input reaches the Mac's helper one batch at a time, in the order it arrived:
 * the helper admits four batches a stream and refuses the rest, and batches relayed at once
 * can reach it out of order. Each batch keeps its own answer; nothing queued is ever lost
 * without one.
 */
function harness(options: { refuse?: (value: number) => boolean } = {}) {
  const sent: string[] = [];
  const answers: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const pending: (() => void)[] = [];
  const lane = new OrderedInputLane<number>({
    maxBatches: 4,
    maxBytes: 1_000,
    send: async (value) => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      sent.push(`input ${value}`);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight--;
      answers.push(options.refuse?.(value) ? `refused ${value}` : `dispatched ${value}`);
    },
    reset: async (source) => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      sent.push(`reset ${source}`);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight--;
    },
    notSent: (value) => answers.push(`not-sent ${value}`),
  });
  /** The helper answers what it holds, one at a time, until nothing waits. */
  const drain = () =>
    vi.waitFor(() => {
      pending.shift()?.();
      if (pending.length || lane.busy) throw new Error("The lane is still relaying.");
    });
  return { lane, sent, answers, drain, mostInFlight: () => mostInFlight };
}
const batch = (value: number, source = "owner:a") => ({ source, bytes: 10, value });

describe("ordered input lane", () => {
  it("relays batches arriving at once one at a time, in order, and answers all of them", async () => {
    const h = harness();
    for (const value of [1, 2, 3, 4, 5]) expect(h.lane.input(batch(value))).toBe(true);
    expect(h.sent).toEqual(["input 1"]);
    await h.drain();
    expect(h.sent).toEqual(["input 1", "input 2", "input 3", "input 4", "input 5"]);
    expect(h.answers).toEqual([
      "dispatched 1",
      "dispatched 2",
      "dispatched 3",
      "dispatched 4",
      "dispatched 5",
    ]);
    expect(h.mostInFlight()).toBe(1);
  });

  it("answers a refused batch truthfully and goes on with the ones after it", async () => {
    const h = harness({ refuse: (value) => value === 2 });
    for (const value of [1, 2, 3]) h.lane.input(batch(value));
    await h.drain();
    expect(h.answers).toEqual(["dispatched 1", "refused 2", "dispatched 3"]);
  });

  it("answers what is still queued not-sent when the stream ends, never the batch in flight", async () => {
    const h = harness();
    for (const value of [1, 2, 3, 4]) h.lane.input(batch(value));
    h.lane.end();
    expect(h.answers).toEqual(["not-sent 2", "not-sent 3", "not-sent 4"]);
    await h.drain();
    // The batch already with the helper keeps its own answer.
    expect(h.answers).toEqual(["not-sent 2", "not-sent 3", "not-sent 4", "dispatched 1"]);
    expect(h.sent).toEqual(["input 1"]);
    expect(h.lane.input(batch(5))).toBe(false);
  });

  it("refuses a batch past its bound without sending it, as the helper's own full lane does", async () => {
    const h = harness();
    for (const value of [1, 2, 3, 4, 5]) expect(h.lane.input(batch(value))).toBe(true);
    // One in flight and four queued: the bound is reached.
    expect(h.lane.input(batch(6))).toBe(false);
    expect(h.lane.input({ source: "owner:a", bytes: 2_000, value: 7 })).toBe(false);
    await h.drain();
    expect(h.sent).toHaveLength(5);
  });

  it("always has room for a release, so a press is never stranded by a full lane", async () => {
    const h = harness();
    for (const value of [1, 2, 3, 4, 5]) h.lane.input(batch(value));
    expect(h.lane.input({ source: "owner:a", bytes: 10, value: 6, release: true })).toBe(true);
    await h.drain();
    expect(h.sent.at(-1)).toBe("input 6");
    expect(h.answers.at(-1)).toBe("dispatched 6");
  });

  it("sends a reset after the batch in flight, never before it, and answers that source's queue not-sent", async () => {
    const h = harness();
    h.lane.input(batch(1));
    h.lane.input(batch(2));
    h.lane.input(batch(3, "owner:b"));
    h.lane.reset("owner:a");
    expect(h.answers).toEqual(["not-sent 2"]);
    await h.drain();
    expect(h.sent).toEqual(["input 1", "input 3", "reset owner:a"]);
    expect(h.answers).toEqual(["not-sent 2", "dispatched 1", "dispatched 3"]);
    expect(h.mostInFlight()).toBe(1);
  });
});
