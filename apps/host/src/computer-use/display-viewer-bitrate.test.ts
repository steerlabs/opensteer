import { describe, expect, it } from "vitest";
import { DisplayViewerBitrate } from "./display-viewer-bitrate.js";

describe("viewer-driven phone bitrate", () => {
  it.each([650, 1_200])("does not cap a %i ms receiver pause or its late ACK burst", (pause) => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 1_000, 100, 100);
    const resumedAt = 2_000 + pause;
    for (const sentAt of [2_000, 2_100, 2_200]) {
      rate.ack(resumedAt, 1_000, resumedAt - sentAt, 100);
      expect(rate.cap).toBeNull();
    }
    for (let now = resumedAt + 100; now <= resumedAt + 10_000; now += 100)
      rate.ack(now, 1_000, 100, 100);
    expect(rate.cap).toBeNull();
  });

  it("does not cap a brief credit stall followed by healthy ACKs", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 12_500, 110, 100);
    rate.stall(2_385, 282, 2_003);
    rate.ack(2_387, 12_500, 385, 100);
    rate.ack(2_407, 12_500, 331, 100);
    rate.ack(2_565, 12_500, 149, 100);
    for (let now = 2_700; now <= 12_000; now += 100) rate.ack(now, 12_500, 110, 100);
    expect(rate.cap).toBeNull();
  });
  it("does not confirm old queueing with a fresh delivery that only exhausts byte credit", () => {
    const rate = new DisplayViewerBitrate();
    rate.stall(2_350, 350, 1_900);
    rate.stall(2_500, 0, 2_400);
    expect(rate.cap).toBeNull();
  });
  it("keeps measured throughput across queued ACK gaps until a later delivery confirms", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 12_500, 100, 100);
    rate.stall(2_350, 250, 2_000);
    rate.ack(2_600, 12_500, 600, 100);
    expect(rate.cap).toBeNull();
    rate.ack(3_201, 12_500, 600, 100);
    expect(rate.cap).not.toBeNull();
    expect(rate.cap).toBeLessThanOrEqual(1_000_000);
  });
  it.each(["stall", "ack"] as const)(
    "counts existing queue age from %s once a later delivery confirms it",
    (signal) => {
      const rate = new DisplayViewerBitrate();
      for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 12_500, 110, 100);
      const observe = (now: number, age: number) =>
        signal === "stall"
          ? rate.stall(now, age, now - 100 - age)
          : rate.ack(now, 12_500, 100 + age, 100);
      observe(2_350, 350);
      observe(2_499, 499);
      expect(rate.cap).toBeNull();
      observe(2_500, 500);
      expect(rate.cap).toBeNull();
      observe(2_700, 250);
      expect(rate.cap).toBeNull();
      observe(2_700, 249);
      expect(rate.cap).not.toBeNull();
    },
  );
  it("keeps a high RTT alone uncapped, reduces queued flow and never raises through silence", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 4_000; now += 100) rate.ack(now, 12_500, 400, 400);
    expect(rate.cap).toBeNull();
    for (let now = 4_100; now <= 8_000; now += 100) rate.ack(now, 12_500, 750, 400);
    expect(rate.cap).toBeGreaterThanOrEqual(400_000);
    expect(rate.cap).toBeLessThan(1_000_000);
    const reduced = rate.cap;
    rate.ack(30_000, 12_500, 400, 400);
    expect(rate.cap).toBe(reduced);
    for (let now = 30_100; now <= 40_000; now += 100) rate.ack(now, 12_500, 400, 400);
    expect(rate.cap).toBeGreaterThan(reduced!);
  });
  it("recovers during continuous healthy flow without replaying old congestion", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 12_500, 400, 400);
    for (let now = 2_100; now <= 8_000; now += 100) rate.ack(now, 12_500, 750, 400);
    const reduced = rate.cap;
    expect(reduced).not.toBeNull();
    for (let now = 8_100; now <= 20_000; now += 100) rate.ack(now, 12_500, 400, 400);
    expect(rate.cap).toBeGreaterThan(reduced!);
  });
  it("counts sustained credit stalls without ACK samples and bounds the floor", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 20_000; now += 111) {
      rate.stall(now, 500, now - 900);
      expect(rate.cap === null || Number.isInteger(rate.cap)).toBe(true);
    }
    expect(rate.cap).toBe(400_000);
  });
});
