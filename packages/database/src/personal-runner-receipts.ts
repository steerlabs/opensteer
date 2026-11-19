import { createHash } from "node:crypto";
import {
  OpensteerError,
  nonTerminalRunStatuses,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Selectable } from "kysely";
import type { ExecutionBindingFacts } from "./execution-authority.js";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import type { FinishIntent, RunnerEventReceiptTable } from "./personal-state-schema.js";
import type { RunAttemptTable, RunRow } from "./schema.js";
import { storableJson } from "./storable-json.js";

interface RunnerStatement<Data = unknown> {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly runnerId: RunnerId;
  readonly runnerBootId: string;
  readonly bindingGeneration: number;
  readonly ordinal: number;
  readonly type: string;
  readonly data: Data;
  readonly emittedAt: string;
}

function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, orderedJson(record[key])]),
  );
}

export function personalArgumentDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(orderedJson(value)) ?? "null")
    .digest();
}

function reportedDigest(statement: RunnerStatement) {
  const { emittedAt, ...reported } = statement;
  return personalArgumentDigest(
    statement.type === "assistant.message"
      ? reported
      : { ...reported, emittedAt: new Date(emittedAt).toISOString() },
  );
}

export function runnerStatementDigest(statement: RunnerStatement) {
  return reportedDigest(storableJson(statement));
}

type Disposition = RunnerEventReceiptTable["disposition"];
type Receipt = Omit<RunnerEventReceiptTable, "committedHead">;
type Tx = PersonalMutationTransaction;
type Authority = {
  readonly kind: "current" | "superseded";
  readonly attemptId: import("@opensteer/core").RunAttemptId;
};

/** The rows a Runner statement was admitted against, read once under the Run lock. */
export interface RunnerStatementContext {
  readonly run: RunRow;
  readonly attempt: Selectable<RunAttemptTable>;
  /** Undefined when the Run has no active session or its requester is not the owner. */
  readonly binding: ExecutionBindingFacts | undefined;
  readonly threadAdmitted: boolean;
  /** Whether queued Messaging inputs hold authority over this task. */
  readonly channelInputs: boolean;
}

function isTerminal(status: string) {
  return !nonTerminalRunStatuses.some((current) => current === status);
}

/**
 * Advances the Run's ordinal and keeps a receipt only while the Run can still change. Ending a
 * Run deletes its receipts (finalizeRunOutcome owns that); the Run keeps its last statement's
 * digest so a replay to it can still be proven.
 */
async function recordReceipt(
  tx: Tx,
  mutation: PersonalMutation,
  receipt: Receipt,
  unlessFinishing: boolean,
) {
  const advanced = await tx
    .updateTable("runs")
    .set({ nextRunnerOrdinal: receipt.ordinal + 1, lastRunnerDigest: receipt.reportedDigest })
    .where("id", "=", receipt.runId)
    .where("nextRunnerOrdinal", "=", receipt.ordinal)
    .$if(unlessFinishing, (query) => query.where("finishIntent", "is", null))
    .returning("status")
    .executeTakeFirst();
  if (!advanced) return false;
  if (isTerminal(advanced.status)) return true;
  mutation.receipt(async (committedHead) => {
    await tx
      .insertInto("runnerEventReceipts")
      .values({ ...receipt, committedHead })
      .execute();
  });
  return true;
}

/** Called when a Run becomes terminal; its Runner binding retires in the same commit. */
export function deleteTerminalRunReceipts(tx: Tx, mutation: PersonalMutation, runId: RunId) {
  mutation.receipt(async () => {
    await tx.deleteFrom("runnerEventReceipts").where("runId", "=", runId).execute();
  });
}

function matchFinish(intent: FinishIntent, statement: RunnerStatement, digest: Buffer) {
  const pending = intent.statement;
  if (
    !pending ||
    pending.ordinal !== statement.ordinal ||
    pending.digest !== digest.toString("hex") ||
    pending.runnerId !== statement.runnerId ||
    pending.runnerBootId !== statement.runnerBootId ||
    intent.bindingGeneration !== statement.bindingGeneration
  )
    throw new OpensteerError({
      code: "conflict",
      message: "The Run is finishing",
      retryable: true,
    });
}

export async function acceptPersonalRunnerStatement<Statement extends RunnerStatement>(
  tx: Tx,
  mutation: PersonalMutation,
  input: Statement,
  apply: (
    digest: Buffer,
    statement: Statement,
    authority: Authority,
    context: RunnerStatementContext,
  ) => Promise<Exclude<Disposition, "terminal-noop">>,
  options?: { readonly now: number; readonly allowExpiredLease: boolean },
): Promise<
  { readonly throughOrdinal: number; readonly replayed: boolean } | { readonly finishing: true }
> {
  const statement = storableJson(input);
  const loaded = await tx
    .selectFrom("runs")
    .leftJoin("runnerEventReceipts as receipt", (join) =>
      join.onRef("receipt.runId", "=", "runs.id").on("receipt.ordinal", "=", statement.ordinal),
    )
    .selectAll("runs")
    .select([
      "receipt.runnerId as receiptRunnerId",
      "receipt.runnerBootId as receiptRunnerBootId",
      "receipt.bindingGeneration as receiptBindingGeneration",
      "receipt.reportedDigest as receiptDigest",
    ])
    .where("runs.id", "=", statement.runId)
    .forNoKeyUpdate("runs")
    .executeTakeFirst();
  if (
    !loaded ||
    loaded.threadId !== statement.threadId ||
    loaded.environmentId !== statement.environmentId
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner statement does not belong to that Run",
    });
  const { receiptRunnerId, receiptRunnerBootId, receiptBindingGeneration, receiptDigest, ...run } =
    loaded;
  const digest = reportedDigest(statement);
  if (receiptDigest) {
    if (
      receiptRunnerId !== statement.runnerId ||
      receiptRunnerBootId !== statement.runnerBootId ||
      receiptBindingGeneration !== statement.bindingGeneration ||
      !receiptDigest.equals(digest)
    )
      throw new OpensteerError({
        code: "conflict",
        message: "Runner ordinal was already used by another statement",
      });
    return { throughOrdinal: run.nextRunnerOrdinal - 1, replayed: true };
  }
  const terminal = isTerminal(run.status);
  // A terminal Run's receipts are gone; only its last statement's digest remains. That proves a
  // replay of the last statement (the digest covers Runner, boot and binding). Nothing proves an
  // earlier one, so it is refused; refusing an ended Run changes nothing but its Runner's copy.
  if (terminal && statement.ordinal < run.nextRunnerOrdinal) {
    if (statement.ordinal !== run.nextRunnerOrdinal - 1 || !run.lastRunnerDigest?.equals(digest))
      throw new OpensteerError({
        code: "conflict",
        message: "Runner ordinal was already used by another statement",
      });
    return { throughOrdinal: run.nextRunnerOrdinal - 1, replayed: true };
  }
  if (run.nextRunnerOrdinal !== statement.ordinal)
    throw new OpensteerError({
      code: "conflict",
      message: `Expected Runner ordinal ${run.nextRunnerOrdinal}`,
    });
  if (run.finishIntent) {
    matchFinish(run.finishIntent, statement, digest);
    return { finishing: true };
  }

  // The attempt, the Run's provider session and the authority facts behind them; nothing locks.
  const bound = await tx
    .selectFrom("runAttempts")
    .leftJoin("providerSessions as session", (join) =>
      join.on("session.id", "=", run.providerSessionId),
    )
    .leftJoin("runners as sessionRunner", "sessionRunner.id", "session.runnerId")
    .selectAll("runAttempts")
    .select((eb) => [
      "session.id as sessionId",
      "session.active as sessionActive",
      "session.leaseExpiresAt as sessionLeaseExpiresAt",
      "session.runnerId as sessionRunnerId",
      "session.runnerBootId as sessionRunnerBootId",
      "session.bindingGeneration as sessionBindingGeneration",
      "session.harnessInstanceId as sessionHarnessInstanceId",
      "session.status as sessionStatus",
      "sessionRunner.id as sessionRunnerRowId",
      "sessionRunner.revokedAt as sessionRunnerRevokedAt",
      eb
        .selectFrom("personalSettings")
        .select("agentHomeComputerId")
        .where("ownerId", "=", run.requestedBy)
        .as("agentHomeComputerId"),
      eb
        .exists(
          eb
            .selectFrom("threads")
            .innerJoin("executionEnvironments", "executionEnvironments.id", "threads.environmentId")
            .innerJoin(
              "personalSettings",
              "personalSettings.agentHomeComputerId",
              "executionEnvironments.runnerId",
            )
            .innerJoin("users", "users.id", "personalSettings.ownerId")
            .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
            .select(sql.lit(1).as("admitted"))
            .where("threads.id", "=", run.threadId)
            .where("personalSettings.singletonKey", "=", "personal")
            .where("personalSettings.ownerId", "=", run.requestedBy)
            .where("users.disabledAt", "is", null)
            .where("runners.revokedAt", "is", null),
        )
        .as("threadAdmitted"),
      eb
        .exists(
          eb
            .selectFrom("threadInputs")
            .select(sql.lit(1).as("held"))
            .where("threadInputs.threadId", "=", run.threadId)
            .where("threadInputs.state", "in", ["pending", "claimed", "unknown"])
            .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "channel-ingress"),
        )
        .as("channelInputs"),
    ])
    .where("runAttempts.runId", "=", run.id)
    .where("runAttempts.bindingGeneration", "=", statement.bindingGeneration)
    .where("runAttempts.runnerId", "=", statement.runnerId)
    .where("runAttempts.runnerBootId", "=", statement.runnerBootId)
    .orderBy("runAttempts.ordinal", "desc")
    .limit(1)
    .executeTakeFirst();
  const session =
    bound?.sessionId &&
    bound.sessionRunnerId === statement.runnerId &&
    bound.sessionRunnerBootId === statement.runnerBootId &&
    bound.sessionBindingGeneration === statement.bindingGeneration
      ? { active: bound.sessionActive!, leaseExpiresAt: bound.sessionLeaseExpiresAt }
      : undefined;
  if (
    !bound ||
    !session ||
    run.bindingGeneration !== statement.bindingGeneration ||
    (!terminal &&
      (!session.active ||
        !session.leaseExpiresAt ||
        (!options?.allowExpiredLease &&
          session.leaseExpiresAt.getTime() <= (options?.now ?? mutation.state.now.getTime())) ||
        (bound.status === "current" && bound.endedAt !== null)))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner statement binding is no longer current",
    });
  const {
    sessionId: _sessionId,
    sessionActive,
    sessionLeaseExpiresAt,
    sessionRunnerId,
    sessionRunnerBootId,
    sessionBindingGeneration,
    sessionHarnessInstanceId,
    sessionStatus,
    sessionRunnerRowId,
    sessionRunnerRevokedAt,
    agentHomeComputerId,
    threadAdmitted,
    channelInputs,
    ...attempt
  } = bound;
  const context: RunnerStatementContext = {
    run,
    attempt,
    binding:
      sessionActive && agentHomeComputerId && sessionRunnerRowId
        ? {
            environmentId: run.environmentId,
            finishIntent: run.finishIntent,
            runHarnessInstanceId: run.harnessInstanceId,
            requestedBy: run.requestedBy,
            runStatus: run.status,
            runBindingGeneration: run.bindingGeneration,
            threadId: run.threadId,
            agentHomeComputerId,
            bindingGeneration: sessionBindingGeneration,
            providerSessionHarnessInstanceId: sessionHarnessInstanceId!,
            leaseExpiresAt: sessionLeaseExpiresAt,
            runnerBootId: sessionRunnerBootId,
            runnerId: sessionRunnerId,
            providerSessionStatus: sessionStatus!,
            revokedAt: sessionRunnerRevokedAt,
          }
        : undefined,
    threadAdmitted: Boolean(threadAdmitted),
    channelInputs: Boolean(channelInputs),
  };

  const disposition = terminal
    ? "terminal-noop"
    : await apply(digest, statement, { kind: attempt.status, attemptId: attempt.id }, context);
  const receipt: Receipt = {
    runId: run.id,
    ordinal: statement.ordinal,
    runnerId: statement.runnerId,
    runnerBootId: statement.runnerBootId,
    bindingGeneration: statement.bindingGeneration,
    reportedDigest: digest,
    disposition,
  };
  if (!(await recordReceipt(tx, mutation, receipt, true))) {
    const { finishIntent } = await tx
      .selectFrom("runs")
      .select("finishIntent")
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    if (!finishIntent) throw new Error("Runner ordinal changed before receipt");
    matchFinish(finishIntent, statement, digest);
    return { finishing: true };
  }
  return { throughOrdinal: statement.ordinal, replayed: false };
}

/** Called only after the finish owner proved that its current-child sets are empty. */
export async function recordFinishedRunnerStatement(
  tx: Tx,
  mutation: PersonalMutation,
  runId: RunId,
  intent: FinishIntent,
) {
  if (!intent.statement) return;
  const run = await tx
    .selectFrom("runs")
    .select(["status", "finishIntent"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  if (
    run.status !==
      (intent.mode === "recovery" || intent.mode === "steer" ? "queued" : intent.outcome) ||
    run.finishIntent?.statement?.digest !== intent.statement.digest ||
    intent.bindingGeneration === null
  )
    throw new Error("Runner finish receipt requires the frozen terminal Run");
  const { ordinal, runnerId, runnerBootId, digest } = intent.statement;
  const recorded = await recordReceipt(
    tx,
    mutation,
    {
      runId,
      ordinal,
      runnerId,
      runnerBootId,
      bindingGeneration: intent.bindingGeneration,
      reportedDigest: Buffer.from(digest, "hex"),
      disposition: "applied",
    },
    false,
  );
  if (!recorded) throw new Error("Runner ordinal changed before receipt");
}
