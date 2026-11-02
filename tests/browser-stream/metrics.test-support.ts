import { z } from "zod";

export const scenarios = ["article-scroll", "nested-scroll", "typing", "click"] as const;
export type Scenario = (typeof scenarios)[number];
export const browserStreamOptions = z.object({
  profile: z.enum(["all", "lan", "4g", "weak-cell"]),
  scenario: z.enum(["all", ...scenarios]),
  runs: z.coerce.number().int().min(1).max(20),
  duration: z.coerce.number().min(2).max(30),
  out: z.string(),
});

export interface InputSample {
  readonly at: number;
  readonly expected: number;
  readonly sequence?: number;
}
export interface InputRejection {
  readonly first: number;
  readonly last: number;
  readonly reason: string;
}

/** Refused native input has no pixel effect; subtract only explicit sequence-fenced refusals. */
export function resolveInputs(
  inputs: readonly InputSample[],
  rejections: readonly InputRejection[],
) {
  let refusedEffect = 0;
  return inputs.map((input, index) => {
    const rejected =
      input.sequence !== undefined &&
      rejections.some((range) => input.sequence! >= range.first && input.sequence! <= range.last);
    if (rejected) refusedEffect += input.expected - (inputs[index - 1]?.expected ?? 0);
    return { ...input, expected: input.expected - refusedEffect, rejected };
  });
}
export interface PresentedSample {
  readonly at: number;
  readonly epoch: number;
  readonly value: number;
  readonly paintedAt: number;
  readonly receivedAt: number;
  readonly frameId: number;
}

export function distribution(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

/** A skipped intermediate picture may acknowledge several inputs, never an earlier input's picture. */
export function causalLatencies(
  inputs: readonly InputSample[],
  pictures: readonly PresentedSample[],
) {
  return inputs.map((input) => {
    const first = pictures.find(
      (picture) => picture.at >= input.at && picture.value >= input.expected,
    );
    return first ? first.at - input.at : null;
  });
}

export function motionMetrics(pictures: readonly PresentedSample[], start: number, end: number) {
  const moving = pictures.filter((picture) => picture.at >= start && picture.at <= end);
  const gaps = moving.slice(1).map((picture, index) => picture.at - moving[index]!.at);
  const mean = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null;
  return {
    frames: moving.length,
    fps: (moving.length * 1000) / (end - start),
    gapMs: distribution(gaps),
    // Standard deviation of consecutive presentation intervals, not deviation from an assumed FPS.
    pacingJitterMs:
      mean === null
        ? null
        : Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length),
    maxGapIncludingEdgesMs: Math.max(
      0,
      ...gaps,
      (moving[0]?.at ?? end) - start,
      end - (moving.at(-1)?.at ?? start),
    ),
  };
}
