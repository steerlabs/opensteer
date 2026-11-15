import {
  createId,
  type ModelSelection,
  type RunAttemptId,
  type RunId,
  type RunnerId,
} from "@opensteer/core";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { DatabaseSchema, RunAttemptTable } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

export type RunAttemptRow = Selectable<RunAttemptTable>;
export type RunAttemptOutcome = NonNullable<RunAttemptTable["outcome"]>;

/**
 * Attempts rank with grants, last in ./lock-order.ts: every writer already
 * holds the Run, and writes them as its final locks.
 */

/** The Run's current attempt, created as attempt 1 when it has none yet. */
export async function currentRunAttempt(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<RunAttemptRow> {
  const current = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", runId)
    .where("status", "=", "current")
    .executeTakeFirst();
  if (current) return current;
  return transaction
    .insertInto("runAttempts")
    .values({
      id: createId("runAttempt"),
      ordinal: 1,
      reason: "initial",
      runId,
      status: "current",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Where and how the attempt was sent to a Runner; each binding replaces the last. */
export async function recordAttemptDispatch(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly attemptId: RunAttemptId;
    readonly bindingGeneration: number;
    readonly modelSelection: ModelSelection;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
): Promise<void> {
  await transaction
    .updateTable("runAttempts")
    .set({
      bindingGeneration: input.bindingGeneration,
      dispatchedAt: new Date(),
      modelSelection: jsonValue(input.modelSelection),
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
    })
    .where("id", "=", input.attemptId)
    .execute();
}

/**
 * Replaces the current attempt with one that will take the steered message,
 * or returns the replacement already waiting when a restart is in progress.
 */
export async function supersedeCurrentAttempt(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<{ readonly successor: RunAttemptRow; readonly superseded: RunAttemptRow | null }> {
  const current = await currentRunAttempt(transaction, runId);
  // The current attempt has not been sent yet: it is the replacement itself.
  if (current.reason === "steer_restart" && current.bindingGeneration === null) {
    return { successor: current, superseded: null };
  }
  const now = new Date();
  const superseded = await transaction
    .updateTable("runAttempts")
    .set({ status: "superseded", supersededAt: now })
    .where("id", "=", current.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const successor = await transaction
    .insertInto("runAttempts")
    .values({
      id: createId("runAttempt"),
      ordinal: current.ordinal + 1,
      reason: "steer_restart",
      runId,
      status: "current",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("runAttempts")
    .set({ supersededBy: successor.id })
    .where("id", "=", superseded.id)
    .execute();
  return { successor, superseded };
}

/** The attempt that executed under `bindingGeneration`. */
export async function attemptForBinding(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  bindingGeneration: number,
): Promise<RunAttemptRow | undefined> {
  return transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", runId)
    .where("bindingGeneration", "=", bindingGeneration)
    .executeTakeFirst();
}

/** An unstarted steering or recovery replacement, dispatched without reclaiming the seed. */
export async function pendingReplacementAttempt(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<RunAttemptRow | undefined> {
  return database
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", runId)
    .where("status", "=", "current")
    .where("reason", "in", ["steer_restart", "recovery"])
    .where("firstEventAt", "is", null)
    .executeTakeFirst();
}

export async function markAttemptStarted(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  bindingGeneration: number,
): Promise<void> {
  await transaction
    .updateTable("runAttempts")
    .set({ firstEventAt: new Date() })
    .where("runId", "=", runId)
    .where("bindingGeneration", "=", bindingGeneration)
    .where("firstEventAt", "is", null)
    .execute();
}

export async function endAttempt(
  transaction: Transaction<DatabaseSchema>,
  attemptId: RunAttemptId,
  outcome: RunAttemptOutcome,
): Promise<void> {
  await transaction
    .updateTable("runAttempts")
    .set({ endedAt: new Date(), outcome })
    .where("id", "=", attemptId)
    .where("endedAt", "is", null)
    .execute();
}

/**
 * Ends whatever of the Run's attempts is still open when the Run itself ends.
 * An attempt still executing ends with the Run's outcome, even one already
 * superseded: the Run ended before its interruption did. A replacement that
 * never reached a Runner is cancelled.
 */
export async function endOpenAttempts(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  runOutcome: "completed" | "failed" | "interrupted",
): Promise<void> {
  const open = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", runId)
    .where("endedAt", "is", null)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  for (const attempt of open) {
    await endAttempt(
      transaction,
      attempt.id,
      attempt.status === "current" && attempt.dispatchedAt === null ? "cancelled" : runOutcome,
    );
  }
}

export type SteeringMode = "native" | "restart";

/**
 * What the Runner holding this Run last advertised: its capabilities and the
 * Run's engine driver. Null when no Runner holds the Run or the driver is
 * unavailable there.
 */
export async function runHolder(transaction: Transaction<DatabaseSchema>, runId: RunId) {
  const holder = await transaction
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .innerJoin("runners", "runners.id", "providerSessions.runnerId")
    .innerJoin("harnessInstances", "harnessInstances.id", "runs.harnessInstanceId")
    .select(["harnessInstances.driverKind", "runners.capabilities", "runners.moduleDescriptors"])
    .where("runs.id", "=", runId)
    .whereRef("providerSessions.bindingGeneration", "=", "runs.bindingGeneration")
    .executeTakeFirst();
  if (!holder) return null;
  const driver = holder.moduleDescriptors.agents?.harnessDrivers.find(
    (candidate) => candidate.driverKind === holder.driverKind,
  );
  if (!driver || driver.readiness === "unavailable") return null;
  return { capabilities: holder.capabilities, driver };
}

/**
 * How the Runner holding this Run takes a steered message, from its last
 * signed advertisement: its engine's own steering, or a restart with the
 * message as the next attempt's input. Null when it can take neither.
 */
export async function runSteeringMode(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<SteeringMode | null> {
  const holder = await runHolder(transaction, runId);
  if (!holder) return null;
  if (holder.driver.steering === true) return "native";
  return holder.capabilities.includes("attempts-v1") ? "restart" : null;
}

export interface RunUsage {
  readonly cacheWriteTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number | undefined;
}

/**
 * Records what one attempt consumed, once, and makes the Run's usage the sum
 * over its attempts. Returns false when the attempt had already stated it.
 */
export async function recordAttemptUsage(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly attemptId: RunAttemptId; readonly runId: RunId; readonly usage: RunUsage },
): Promise<boolean> {
  const recorded = await transaction
    .updateTable("runAttempts")
    .set({
      cacheWriteTokens: input.usage.cacheWriteTokens ?? null,
      cachedInputTokens: input.usage.cachedInputTokens ?? null,
      costUsd: input.usage.costUsd ?? null,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningTokens: input.usage.reasoningTokens ?? null,
    })
    .where("id", "=", input.attemptId)
    .where("inputTokens", "is", null)
    .executeTakeFirst();
  if (recorded.numUpdatedRows !== 1n) return false;
  const total = await transaction
    .selectFrom("runAttempts")
    .select(({ fn }) => [
      fn.sum<string>("inputTokens").as("inputTokens"),
      fn.sum<string>("outputTokens").as("outputTokens"),
      fn.sum<string | null>("cachedInputTokens").as("cachedInputTokens"),
      fn.sum<string | null>("cacheWriteTokens").as("cacheWriteTokens"),
      fn.sum<string | null>("reasoningTokens").as("reasoningTokens"),
      fn.sum<string | null>("costUsd").as("costUsd"),
    ])
    .where("runId", "=", input.runId)
    .where("inputTokens", "is not", null)
    .executeTakeFirstOrThrow();
  const count = (value: string | null) => (value === null ? null : Number(value));
  await transaction
    .updateTable("runs")
    .set({
      cacheWriteTokens: count(total.cacheWriteTokens),
      cachedInputTokens: count(total.cachedInputTokens),
      costUsd: count(total.costUsd),
      inputTokens: count(total.inputTokens),
      outputTokens: count(total.outputTokens),
      reasoningTokens: count(total.reasoningTokens),
    })
    .where("id", "=", input.runId)
    .execute();
  return true;
}

/** The Run's newest hundred attempts, oldest first. */
export async function listRunAttempts(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<readonly RunAttemptRow[]> {
  const newest = await database
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", runId)
    .orderBy("ordinal", "desc")
    .limit(100)
    .execute();
  return newest.reverse();
}
