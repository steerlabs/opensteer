import { readFile } from "node:fs/promises";
import type { RunId, RunUsage, ThreadId } from "@opensteer/core";
import { expect } from "vitest";
import type { VerticalStack } from "./vertical-stack.test-support.js";

/*
 * Codex states a thread's running token total after each model response. The
 * fake app-server, launched with `--token-usage`, records every statement it
 * sends; a journey reads them back, says which ones its Run ran, and checks
 * that the Run's usage reads the same in every place the Host keeps it.
 */

/** Codex's counters in one statement. */
export interface CodexTokens {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

/** One `thread/tokenUsage/updated` the fake app-server sent, in the order it sent them. */
export interface CodexUsageFrame {
  /**
   * What the fake said it was: `response` and `compaction` are a model
   * response's own reading; `duplicate` and `restated` repeat one; `foreign
   * turn`, `foreign thread` and `late` name turns no Run of the journey ran;
   * `impossible` states more cached input than input.
   */
  readonly label: string;
  readonly last: CodexTokens;
  readonly threadId: string;
  readonly total: CodexTokens;
  readonly turnId: string;
  /** How many turns the fake had been asked to start when it sent this. */
  readonly turnStarts: number;
}

/** A model response's own reading: what a Run running its turn consumed. */
const consumedLabels = new Set(["compaction", "response"]);

export interface UsageExpectation {
  readonly attempt: RunUsage | null;
  /** Each subagent invocation's own share, in the order they started. */
  readonly nodes: readonly (RunUsage | null)[];
}

export interface RecordedUsage {
  /** Each attempt's usage as `run_attempts` holds it, oldest first. */
  readonly attempts: readonly (RunUsage | null)[];
  /** The `runs` row: the sum over its attempts. */
  readonly run: RunUsage | null;
  /** Each `run.usage` in the Run's log, and whether it came before the Run's end. */
  readonly statements: readonly { readonly beforeEnd: boolean; readonly data: unknown }[];
  /** What a client reads from the Run's execution details. */
  readonly view: {
    readonly attempts: readonly (RunUsage | null)[];
    readonly nodes: readonly (RunUsage | null)[];
  };
}

/** What one journey's artifact records about usage. */
export interface UsageRecord {
  readonly expected: UsageExpectation;
  readonly frames: readonly (CodexUsageFrame & { readonly counted: boolean })[];
  readonly recorded: RecordedUsage;
}

export async function codexUsageFrames(captureFile: string): Promise<CodexUsageFrame[]> {
  const text = await readFile(captureFile, "utf8").catch(() => "");
  let turnStarts = 0;
  const namingThreads = new Set<string>();
  const frames: CodexUsageFrame[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const captured = JSON.parse(line) as {
      readonly fakeTurn?: unknown;
      readonly fakeTitleTurn?: { readonly threadId: string };
      readonly usageFrame?: {
        readonly label: string;
        readonly threadId: string;
        readonly tokenUsage: { readonly last: CodexTokens; readonly total: CodexTokens };
        readonly turnId: string;
      };
    };
    if (captured.fakeTurn) turnStarts += 1;
    if (captured.fakeTitleTurn) namingThreads.add(captured.fakeTitleTurn.threadId);
    const frame = captured.usageFrame;
    if (!frame || namingThreads.has(frame.threadId)) continue;
    frames.push({
      label: frame.label,
      last: frame.tokenUsage.last,
      threadId: frame.threadId,
      total: frame.tokenUsage.total,
      turnId: frame.turnId,
      turnStarts,
    });
  }
  return frames;
}

/**
 * What the journey's Run should have recorded, summed from the readings of
 * the responses it ran. `frames` are the statements sent while it ran; those
 * not on `rootThreadId` are its subagents', one invocation per child turn.
 */
export function expectedUsage(
  frames: readonly CodexUsageFrame[],
  rootThreadId: string,
): UsageExpectation {
  const consumed = frames.filter((frame) => consumedLabels.has(frame.label));
  const invocations = new Map<string, CodexTokens[]>();
  for (const frame of consumed) {
    if (frame.threadId === rootThreadId) continue;
    const key = JSON.stringify([frame.threadId, frame.turnId]);
    invocations.set(key, [...(invocations.get(key) ?? []), frame.last]);
  }
  return {
    attempt: runUsage(consumed.map((frame) => frame.last)),
    nodes: [...invocations.values()].map(runUsage),
  };
}

/** Opensteer's terms: input without cache reads and writes, output with reasoning. */
function runUsage(readings: readonly CodexTokens[]): RunUsage | null {
  if (readings.length === 0) return null;
  const sum = (field: keyof CodexTokens) =>
    readings.reduce((total, reading) => total + reading[field], 0);
  return {
    cacheWriteTokens: sum("cacheWriteInputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    inputTokens: sum("inputTokens") - sum("cachedInputTokens") - sum("cacheWriteInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningOutputTokens"),
  };
}

export async function recordedUsage(active: VerticalStack, runId: RunId): Promise<RecordedUsage> {
  const database = active.host.store.database;
  const listed = await active.api["run.attempts.list"]({ runId });
  if (!listed.ok) throw new Error(listed.error.message);
  const attempts = await database
    .selectFrom("runAttempts")
    .select([
      "cacheWriteTokens",
      "cachedInputTokens",
      "costUsd",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
    ])
    .where("runId", "=", runId)
    .orderBy("ordinal", "asc")
    .execute();
  const run = await database
    .selectFrom("runs")
    .select([
      "cacheWriteTokens",
      "cachedInputTokens",
      "costUsd",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
    ])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const events = await database
    .selectFrom("workspaceEvents")
    .select(["data", "type"])
    .where("runId", "=", runId)
    .orderBy("sequence", "asc")
    .execute();
  const end = events.findIndex((event) =>
    ["run.completed", "run.failed", "run.interrupted"].includes(event.type),
  );
  return {
    attempts: attempts.map(usageOfRow),
    run: usageOfRow(run),
    statements: events.flatMap((event, index) =>
      event.type === "run.usage"
        ? [{ beforeEnd: end === -1 || index < end, data: event.data }]
        : [],
    ),
    view: {
      attempts: listed.data.attempts.map((attempt) => attempt.usage),
      nodes: listed.data.nodes.map((node) => node.usage),
    },
  };
}

/** A Run of one attempt recorded exactly what was expected, everywhere. */
export function expectRecordedUsage(recorded: RecordedUsage, expected: UsageExpectation): void {
  expect(recorded.attempts).toEqual([expected.attempt]);
  expect(recorded.view.attempts).toEqual([expected.attempt]);
  expect(recorded.run).toEqual(expected.attempt);
  expect(recorded.statements).toEqual(
    expected.attempt ? [{ beforeEnd: true, data: expected.attempt }] : [],
  );
  expect(recorded.view.nodes).toEqual(expected.nodes);
}

export function usageRecord(
  frames: readonly CodexUsageFrame[],
  expected: UsageExpectation,
  recorded: RecordedUsage,
): UsageRecord {
  return {
    expected,
    frames: frames.map((frame) => ({ ...frame, counted: consumedLabels.has(frame.label) })),
    recorded,
  };
}

/** The Codex thread a Thread's conversation is. */
export async function codexThreadOf(active: VerticalStack, threadId: ThreadId): Promise<string> {
  const session = await active.host.store.database
    .selectFrom("providerSessions")
    .select("providerSessionReference")
    .where("threadId", "=", threadId)
    .where("providerSessionReference", "is not", null)
    .executeTakeFirstOrThrow();
  return session.providerSessionReference!;
}

function usageOfRow(row: {
  readonly cacheWriteTokens: string | null;
  readonly cachedInputTokens: string | null;
  readonly costUsd: string | null;
  readonly inputTokens: string | null;
  readonly outputTokens: string | null;
  readonly reasoningTokens: string | null;
}): RunUsage | null {
  if (row.inputTokens === null || row.outputTokens === null) return null;
  const optional = {
    cacheWriteTokens: row.cacheWriteTokens,
    cachedInputTokens: row.cachedInputTokens,
    costUsd: row.costUsd,
    reasoningTokens: row.reasoningTokens,
  };
  return {
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    ...Object.fromEntries(
      Object.entries(optional).flatMap(([key, value]) =>
        value === null ? [] : [[key, Number(value)]],
      ),
    ),
  };
}
