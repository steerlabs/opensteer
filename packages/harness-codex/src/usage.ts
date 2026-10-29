import type { RunUsage } from "@opensteer/core";
import { z } from "zod";
import { protocolError } from "./protocol.js";

/** One reading of Codex's token counters, in its own terms. */
export interface CodexTokenCounts {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * OpenAI counts cache reads and writes inside `inputTokens` and reasoning
 * inside `outputTokens`, so counts whose parts exceed their whole are not
 * counts Codex can state.
 */
function partsWithinWhole(counts: CodexTokenCounts): boolean {
  return (
    counts.cachedInputTokens + counts.cacheWriteInputTokens <= counts.inputTokens &&
    counts.reasoningOutputTokens <= counts.outputTokens
  );
}

const CodexTokenUsageBreakdownSchema = z
  .looseObject({
    // Codex 0.156's schema defaults an absent count to zero.
    cacheWriteInputTokens: tokenCount.default(0),
    cachedInputTokens: tokenCount,
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    reasoningOutputTokens: tokenCount,
    totalTokens: tokenCount,
  })
  .transform((breakdown): CodexTokenCounts => ({
    cacheWriteInputTokens: breakdown.cacheWriteInputTokens,
    cachedInputTokens: breakdown.cachedInputTokens,
    inputTokens: breakdown.inputTokens,
    outputTokens: breakdown.outputTokens,
    reasoningOutputTokens: breakdown.reasoningOutputTokens,
    totalTokens: breakdown.totalTokens,
  }))
  .refine(partsWithinWhole, "A token reading's parts exceed its whole");

/**
 * `thread/tokenUsage/updated`, sent after each model response: the thread's
 * running `total` and the newest response's own `last`.
 */
const CodexTokenUsageUpdatedSchema = z.looseObject({
  threadId: z.string().min(1),
  tokenUsage: z.looseObject({
    last: CodexTokenUsageBreakdownSchema,
    modelContextWindow: tokenCount.nullish(),
    total: CodexTokenUsageBreakdownSchema,
  }),
  turnId: z.string().min(1),
});

export interface CodexTokenUsageUpdate {
  readonly last: CodexTokenCounts;
  readonly threadId: string;
  readonly total: CodexTokenCounts;
  readonly turnId: string;
}

export function parseCodexTokenUsageUpdate(params: unknown): CodexTokenUsageUpdate {
  const parsed = CodexTokenUsageUpdatedSchema.safeParse(params);
  if (!parsed.success) {
    throw protocolError("Codex thread/tokenUsage/updated did not match the expected shape", {
      details: { issues: parsed.error.issues.slice(0, 8) },
    });
  }
  const { threadId, tokenUsage, turnId } = parsed.data;
  return { last: tokenUsage.last, threadId, total: tokenUsage.total, turnId };
}

const countFields = [
  "cacheWriteInputTokens",
  "cachedInputTokens",
  "inputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const satisfies readonly (keyof CodexTokenCounts)[];

function combine(
  left: CodexTokenCounts,
  right: CodexTokenCounts,
  operation: (left: number, right: number) => number,
): CodexTokenCounts {
  return {
    cacheWriteInputTokens: operation(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    cachedInputTokens: operation(left.cachedInputTokens, right.cachedInputTokens),
    inputTokens: operation(left.inputTokens, right.inputTokens),
    outputTokens: operation(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: operation(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: operation(left.totalTokens, right.totalTokens),
  };
}

export function addTokenCounts(
  sum: CodexTokenCounts | undefined,
  counts: CodexTokenCounts,
): CodexTokenCounts {
  return sum ? combine(sum, counts, (left, right) => left + right) : counts;
}

/**
 * What each statement added to its thread's consumption. A thread's previous
 * `total` is kept for as long as the app-server runs, so a later Run on the
 * same engine counts only its own growth and a restated reading adds nothing;
 * Codex restates a thread's reading when it resumes it, which gives a cold
 * engine its baseline. Without one, or once the running total went down, as
 * compaction resets it, the newest response's own `last` is what was added.
 */
export class CodexTokenLedger {
  readonly #baselines = new Map<string, CodexTokenCounts>();

  observe(update: CodexTokenUsageUpdate): CodexTokenCounts {
    const baseline = this.#baselines.get(update.threadId);
    this.#baselines.set(update.threadId, update.total);
    if (!baseline || countFields.some((field) => update.total[field] < baseline[field])) {
      return update.last;
    }
    const added = combine(update.total, baseline, (total, previous) => total - previous);
    if (!partsWithinWhole(added)) {
      throw protocolError(
        "Codex thread/tokenUsage/updated added more cache or reasoning tokens than input or output",
      );
    }
    return added;
  }
}

/**
 * Opensteer counts input without the cache reads and writes OpenAI includes
 * in it; output already includes reasoning on both sides.
 */
export function codexRunUsage(counts: CodexTokenCounts): RunUsage {
  return {
    cacheWriteTokens: counts.cacheWriteInputTokens,
    cachedInputTokens: counts.cachedInputTokens,
    inputTokens: counts.inputTokens - counts.cachedInputTokens - counts.cacheWriteInputTokens,
    outputTokens: counts.outputTokens,
    reasoningTokens: counts.reasoningOutputTokens,
  };
}
