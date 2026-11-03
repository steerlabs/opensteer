import { describe, expect, it } from "vitest";
import {
  benchmarkTimeoutMs,
  causalLatencies,
  distribution,
  motionMetrics,
  resolveInputs,
  scenarioDeadlineMs,
  scenarios,
  type PresentedSample,
} from "./metrics.test-support.js";

const picture = (at: number, value: number): PresentedSample => ({
  at,
  value,
  epoch: 1,
  paintedAt: at - 20,
  receivedAt: at - 5,
  frameId: at,
});

describe("browser stream measurements", () => {
  it("does not attribute pixels to refused inputs, including merged and duplicate rejection ranges", () => {
    const inputs = [1, 2, 3, 4].map((sequence) => ({
      at: 10 * sequence,
      expected: 12 * sequence,
      sequence,
    }));
    const rejected = { first: 2, last: 3, reason: "browser-input-overload" };
    const resolved = resolveInputs(inputs, [rejected, rejected]);
    expect(resolved.map((input) => [input.expected, input.rejected])).toEqual([
      [12, false],
      [12, true],
      [12, true],
      [24, false],
    ]);
    // State 24 includes input 4, not the refused input 2. Its latency starts at 40.
    expect(
      causalLatencies(
        resolved.filter((input) => !input.rejected),
        [picture(50, 24)],
      ),
    ).toEqual([40, 10]);
  });
  it("waits for causal pixels, including coalesced input and unpresented tails", () => {
    const inputs = [
      { at: 100, expected: 12 },
      { at: 110, expected: 24 },
      { at: 120, expected: 36 },
    ];
    // The stale picture arrives after both first inputs. A single later picture includes both.
    const pictures = [picture(115, 0), picture(140, 24), picture(145, 24)];
    expect(causalLatencies(inputs, pictures)).toEqual([40, 30, null]);
  });

  it("reports nearest-rank quantiles and leaves empty measurements missing", () => {
    expect(distribution([])).toEqual({ count: 0, p50: null, p95: null });
    expect(distribution([100, 2, 4, 3, 1])).toEqual({ count: 5, p50: 3, p95: 100 });
  });

  it("counts motion presentations only in the input window and includes edge freezes", () => {
    expect(
      motionMetrics(
        [picture(90, 0), picture(110, 12), picture(130, 24), picture(170, 36), picture(220, 48)],
        100,
        200,
      ),
    ).toEqual({
      frames: 3,
      fps: 30,
      gapMs: { count: 2, p50: 20, p95: 40 },
      pacingJitterMs: 10,
      maxGapIncludingEdgesMs: 40,
    });
    expect(motionMetrics([], 100, 200)).toMatchObject({
      fps: 0,
      pacingJitterMs: null,
      maxGapIncludingEdgesMs: 100,
    });
  });

  it("sizes the run's limit beyond every bounded step of the selected workload", () => {
    const largest = { profile: "all", scenario: "all", runs: 20, duration: 30, out: "x" } as const;
    const workloads = scenarios.reduce((sum, s) => sum + scenarioDeadlineMs(s, 30), 0);
    expect(benchmarkTimeoutMs(largest)).toBeGreaterThan(3 * 20 * workloads);
    const single = { profile: "lan", scenario: "click", runs: 1, duration: 4, out: "x" } as const;
    expect(benchmarkTimeoutMs(single)).toBeGreaterThan(scenarioDeadlineMs("click", 4) + 50_000);
    expect(benchmarkTimeoutMs(single)).toBeLessThan(benchmarkTimeoutMs(largest));
  });
});
