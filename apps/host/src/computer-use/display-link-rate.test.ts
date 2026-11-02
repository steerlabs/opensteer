import { describe, expect, it } from "vitest";
import { DisplayLinkRate } from "./display-link-rate.js";

const limits = { maximumBitrate: 20_000_000, initialBitrate: 4_000_000 };

/**
 * A bottleneck link at `mbps` with a fixed base round trip, fed by an encoder
 * that follows the cap (or `contentMbps` when the window needs less) at 60 fps,
 * while in-flight bytes respect the controller's credit. Returns the cap and the
 * queue delay each frame met, so tests can check convergence and staleness.
 */
function simulate(
  rate: DisplayLinkRate,
  steps: { untilMs: number; mbps: number; rttMs: number; contentMbps?: number; pauseMs?: number }[],
) {
  let now = 0;
  let sequence = 0;
  let linkFreeAt = 0;
  const inFlight: { sequence: number; bytes: number; sentAt: number; ackAt: number }[] = [];
  const trace: { at: number; cap: number | null; queueMs: number; skipped: boolean }[] = [];
  for (const step of steps) {
    for (; now < step.untilMs; now += 1_000 / 60) {
      while (inFlight[0] && inFlight[0].ackAt <= now) {
        const frame = inFlight.shift()!;
        rate.ack(frame.sequence, frame.ackAt, step.rttMs);
      }
      const bitrate = Math.min(rate.cap ?? limits.maximumBitrate, (step.contentMbps ?? 99) * 1e6);
      const bytes = Math.round(bitrate / 8 / 60);
      const outstanding = inFlight.reduce((sum, f) => sum + f.bytes, 0);
      const credit = rate.creditBytes(now, step.rttMs, 1_048_576);
      if (inFlight.length > 0 && outstanding + bytes > credit) {
        rate.stalled(now, now - inFlight[0]!.sentAt - step.rttMs, step.rttMs);
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
    const settled = window(trace, 3_000, 12_000);
    expect(rate.cap).toBeGreaterThan(600_000);
    expect(rate.cap).toBeLessThan(1_000_000);
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

  it("does not cut for a receiver pause on a fast link", () => {
    const rate = new DisplayLinkRate(limits);
    simulate(rate, [
      { untilMs: 3_000, mbps: 200, rttMs: 10 },
      { untilMs: 4_000, mbps: 200, rttMs: 10, pauseMs: 700 },
      { untilMs: 5_000, mbps: 200, rttMs: 10 },
    ]);
    expect(rate.cap === null || rate.cap >= 15_000_000).toBe(true);
  });

  it("never probes on a still window, whose small frames prove nothing", () => {
    const rate = new DisplayLinkRate(limits);
    simulate(rate, [{ untilMs: 10_000, mbps: 1, rttMs: 400, contentMbps: 0.1 }]);
    expect(rate.cap).toBe(limits.initialBitrate);
  });
});
