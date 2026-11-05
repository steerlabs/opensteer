import { z } from "zod";

const RoundTimingSchema = z.strictObject({
  /** Since the last tool ended, or the turn began. */
  waitMs: z.number(),
  toolMs: z.number(),
  tools: z.number().int(),
});
export const TurnTimingSchema = z.strictObject({
  rounds: z.array(RoundTimingSchema),
  /** After the last tool, to the end of the turn. */
  finalWaitMs: z.number(),
  totalMs: z.number(),
});
export type TurnTiming = z.infer<typeof TurnTimingSchema>;

type ClockEvent =
  | { readonly type: "tool.started"; readonly data: { readonly callId: string } }
  | { readonly type: "tool.completed"; readonly data: { readonly callId: string } }
  | { readonly type: string };

/**
 * One round is the wait for the engine to act, then its tools. A wait holds
 * model, engine and transport time together: harness events cannot separate
 * them, and neither engine's telemetry measures a whole model response.
 */
export class TurnClock {
  readonly #startedAt: number;
  readonly #rounds: { waitMs: number; toolMs: number; tools: number }[] = [];
  readonly #seen = new Set<string>();
  readonly #running = new Set<string>();
  #idleSince: number;
  #toolsSince: number | undefined;

  constructor(now: number) {
    this.#startedAt = now;
    this.#idleSince = now;
  }

  note(event: ClockEvent, now: number): void {
    if (event.type !== "tool.started" && event.type !== "tool.completed") return;
    const { callId } = (event as { readonly data: { readonly callId: string } }).data;
    if (event.type === "tool.completed") {
      if (!this.#running.delete(callId) || this.#running.size > 0) return;
      this.#rounds.at(-1)!.toolMs = now - this.#toolsSince!;
      this.#toolsSince = undefined;
      this.#idleSince = now;
      return;
    }
    // Engines can announce a call before dispatching it, under one ID.
    if (this.#seen.has(callId)) return;
    this.#seen.add(callId);
    this.#running.add(callId);
    if (this.#toolsSince === undefined) {
      this.#toolsSince = now;
      this.#rounds.push({ waitMs: now - this.#idleSince, toolMs: 0, tools: 0 });
    }
    this.#rounds.at(-1)!.tools += 1;
  }

  finish(now: number): TurnTiming {
    if (this.#toolsSince !== undefined) this.#rounds.at(-1)!.toolMs = now - this.#toolsSince;
    return {
      rounds: this.#rounds,
      finalWaitMs: this.#toolsSince === undefined ? now - this.#idleSince : 0,
      totalMs: now - this.#startedAt,
    };
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function timingLines(
  rows: readonly { readonly caseId: string; readonly timing?: readonly TurnTiming[] | undefined }[],
): string[] {
  const cases = [...new Set(rows.map((row) => row.caseId))].flatMap((id) => {
    const samples = rows.filter((row) => row.caseId === id).flatMap((row) => row.timing ?? []);
    if (samples.length === 0) return [];
    const rounds = samples.flatMap((turn) => turn.rounds);
    const milliseconds = (value: number) => `${Math.round(value)}ms`;
    return [
      `| ${id} | ${median(samples.map((turn) => turn.rounds.length))} | ${milliseconds(median(rounds.map((round) => round.waitMs)))} | ${milliseconds(median(rounds.map((round) => round.toolMs)))} | ${milliseconds(median(samples.map((turn) => turn.finalWaitMs)))} | ${milliseconds(median(samples.map((turn) => turn.totalMs)))} |`,
    ];
  });
  if (cases.length === 0) return [];
  return [
    "",
    "## Timing",
    "",
    "Medians per turn. Wait is model, engine and transport together; these events cannot separate provider time.",
    "",
    "| Case | Rounds | Wait per round | Tools per round | Final wait | Turn |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...cases,
  ];
}
