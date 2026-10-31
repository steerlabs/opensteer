import { describe, expect, it } from "vitest";
import { DisplayViewerBitrate } from "./display-viewer-bitrate.js";

describe("viewer-driven phone bitrate", () => {
  it("does not cap a brief credit stall followed by healthy ACKs", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 2_000; now += 100) rate.ack(now, 12_500, 110, 100);
    rate.stall(2_385);
    rate.ack(2_387, 12_500, 385, 100);
    rate.ack(2_407, 12_500, 331, 100);
    rate.ack(2_565, 12_500, 149, 100);
    for (let now = 2_700; now <= 12_000; now += 100) rate.ack(now, 12_500, 110, 100);
    expect(rate.cap).toBeNull();
  });
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
  it("counts sustained credit stalls without queue-delay samples and bounds the floor", () => {
    const rate = new DisplayViewerBitrate();
    for (let now = 0; now <= 20_000; now += 111) {
      rate.stall(now);
      expect(rate.cap === null || Number.isInteger(rate.cap)).toBe(true);
    }
    expect(rate.cap).toBe(400_000);
  });
});
