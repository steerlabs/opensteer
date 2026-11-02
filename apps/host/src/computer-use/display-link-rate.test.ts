import { describe, expect, it } from "vitest";
import { DisplayLinkRate, macLinkRate } from "./display-link-rate.js";

const limits = macLinkRate;

/**
 * A bottleneck link at `mbps` with a fixed base round trip, fed by an encoder
 * that follows the cap (or `contentMbps` when the window needs less) at 60 fps,
 * while in-flight bytes respect the controller's credit. Returns the cap and the
 * queue delay each frame met, so tests can check convergence and staleness.
 */
function simulate(
  rate: DisplayLinkRate,
  steps: {
    untilMs: number;
    mbps: number;
    rttMs: number;
    contentMbps?: number;
    pauseMs?: number;
    keyEveryMs?: number;
  }[],
) {
  let now = 0;
  let sequence = 0;
  let linkFreeAt = 0;
  let pingedAt = -Infinity;
  const inFlight: { sequence: number; bytes: number; sentAt: number; ackAt: number }[] = [];
  const trace: { at: number; cap: number | null; queueMs: number; skipped: boolean }[] = [];
  for (const step of steps) {
    for (; now < step.untilMs; now += 1_000 / 60) {
      while (inFlight[0] && inFlight[0].ackAt <= now) {
        const frame = inFlight.shift()!;
        rate.ack(frame.sequence, frame.ackAt);
      }
      // The Host pings an empty path at most every 2 s.
      if (inFlight.length === 0 && now - pingedAt >= 2_000) {
        rate.roundTrip(step.rttMs, now);
        pingedAt = now;
      }
      const bitrate = Math.min(rate.cap ?? limits.maximumBitrate, (step.contentMbps ?? 99) * 1e6);
      const frameMs = 1_000 / 60;
      const key =
        step.keyEveryMs !== undefined &&
        Math.floor(now / step.keyEveryMs) !== Math.floor((now - frameMs) / step.keyEveryMs);
      const bytes = key ? 250_000 : Math.round(bitrate / 8 / 60);
      const outstanding = inFlight.reduce((sum, f) => sum + f.bytes, 0);
      const credit = rate.creditBytes(now, 1_048_576);
      if (inFlight.length > 0 && outstanding + bytes > credit) {
        rate.stalled(now, inFlight[0]!.sentAt);
        trace.push({ at: now, cap: rate.cap, queueMs: 0, skipped: true });
        continue;
      }
      const start = Math.max(now, linkFreeAt);
      linkFreeAt = start + (bytes * 8) / (step.mbps * 1_000);
      const pause = step.pauseMs && now >= step.untilMs - step.pauseMs ? step.untilMs - now : 0;
      const ackAt = linkFreeAt + step.rttMs + pause;
      rate.sent(sequence, bytes, now);
      inFlight.push({ sequence: sequence++, bytes, sentAt: now, ackAt });
      inFlight.sort((a, b) => a.sequence - b.sequence);
      trace.push({ at: now, cap: rate.cap, queueMs: start - now, skipped: false });
    }
  }
  return trace;
}

const window = (trace: ReturnType<typeof simulate>, from: number, to: number) =>
  trace.filter((t) => t.at >= from && t.at < to);
const p95 = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;

describe("display link rate", () => {
  it("settles a weak cellular link within two seconds without standing queues", () => {
    const rate = new DisplayLinkRate(limits);
    const trace = simulate(rate, [{ untilMs: 12_000, mbps: 1, rttMs: 400 }]);
    // The cap settles around the link, probing a little above it and back.
    expect(trace.find((t) => t.cap !== null && t.cap <= 1_000_000)!.at).toBeLessThan(2_000);
    const settled = window(trace, 3_000, 12_000);
    expect(rate.cap).toBeGreaterThan(700_000);
    expect(rate.cap).toBeLessThan(1_300_000);
    expect(p95(settled.map((t) => t.queueMs))).toBeLessThan(250);
  });

  it("reaches full LAN quality within about a second of motion", () => {
    const rate = new DisplayLinkRate(limits);
    const trace = simulate(rate, [{ untilMs: 3_000, mbps: 200, rttMs: 4 }]);
    expect(trace.find((t) => t.cap === null)?.at).toBeLessThan(1_500);
    expect(p95(trace.map((t) => t.queueMs))).toBeLessThan(5);
  });

  it("follows a Wi-Fi to cellular handover down within 1.5 seconds and back up", () => {
    const rate = new DisplayLinkRate(limits);
    const trace = simulate(rate, [
      { untilMs: 4_000, mbps: 100, rttMs: 20 },
      { untilMs: 12_000, mbps: 1.5, rttMs: 150 },
      { untilMs: 40_000, mbps: 100, rttMs: 20 },
    ]);
    const after = window(trace, 4_000, 12_000);
    expect(after.find((t) => t.cap !== null && t.cap < 1_500_000)!.at).toBeLessThan(5_500);
    expect(p95(window(trace, 6_000, 12_000).map((t) => t.queueMs))).toBeLessThan(300);
    expect(rate.cap === null || rate.cap >= 12_000_000).toBe(true);
  });

  it("recovers full quality within 1.5 s after a receiver pause on a fast link", () => {
    const rate = new DisplayLinkRate(limits);
    simulate(rate, [
      { untilMs: 3_000, mbps: 200, rttMs: 10 },
      { untilMs: 4_000, mbps: 200, rttMs: 10, pauseMs: 700 },
      { untilMs: 5_500, mbps: 200, rttMs: 10 },
    ]);
    expect(rate.cap).toBeNull();
  });

  it("does not cut a fast link for a key's own transfer while the window is mostly still", () => {
    const rate = new DisplayLinkRate(limits);
    // 4G with a still window: tiny deltas and a 250 KB key every 2 s.
    const trace = simulate(rate, [
      { untilMs: 12_000, mbps: 9, rttMs: 100, contentMbps: 0.3, keyEveryMs: 2_000 },
    ]);
    expect(trace.every((t) => t.cap === limits.initialBitrate)).toBe(true);
  });

  it("never probes on a still window, whose small frames prove nothing", () => {
    const rate = new DisplayLinkRate(limits);
    simulate(rate, [{ untilMs: 10_000, mbps: 1, rttMs: 400, contentMbps: 0.1 }]);
    expect(rate.cap).toBe(limits.initialBitrate);
  });
});
