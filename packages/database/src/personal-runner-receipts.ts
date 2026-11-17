import { createHash } from "node:crypto";
import {
  OpensteerError,
  nonTerminalRunStatuses,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import type { FinishIntent, RunnerEventReceiptTable } from "./personal-state-schema.js";
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

async function recordReceipt(tx: Tx, mutation: PersonalMutation, receipt: Receipt) {
  const advanced = await tx
    .updateTable("runs")
    .set({ nextRunnerOrdinal: receipt.ordinal + 1 })
    .where("id", "=", receipt.runId)
    .where("nextRunnerOrdinal", "=", receipt.ordinal)
    .executeTakeFirst();
  if (advanced.numUpdatedRows !== 1n) throw new Error("Runner ordinal changed before receipt");
  mutation.receipt(async (committedHead) => {
    await tx
      .insertInto("runnerEventReceipts")
      .values({ ...receipt, committedHead })
      .execute();
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
  ) => Promise<Exclude<Disposition, "terminal-noop">>,
): Promise<
  { readonly throughOrdinal: number; readonly replayed: boolean } | { readonly finishing: true }
> {
  const statement = storableJson(input);
  const run = await tx
    .selectFrom("runs")
    .select([
      "id",
      "threadId",
      "environmentId",
      "nextRunnerOrdinal",
      "finishIntent",
      "status",
      "providerSessionId",
      "bindingGeneration",
    ])
    .where("id", "=", statement.runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run || run.threadId !== statement.threadId || run.environmentId !== statement.environmentId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner statement does not belong to that Run",
    });
  const digest = reportedDigest(statement);
  const receipt = await tx
    .selectFrom("runnerEventReceipts")
    .select(["runnerId", "runnerBootId", "bindingGeneration", "reportedDigest"])
    .where("runId", "=", run.id)
    .where("ordinal", "=", statement.ordinal)
    .executeTakeFirst();
  if (receipt) {
    if (
      receipt.runnerId !== statement.runnerId ||
      receipt.runnerBootId !== statement.runnerBootId ||
      receipt.bindingGeneration !== statement.bindingGeneration ||
      !receipt.reportedDigest.equals(digest)
    )
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

  const attempt = await tx
    .selectFrom("runAttempts")
    .select(["id", "status", "endedAt"])
    .where("runId", "=", run.id)
    .where("bindingGeneration", "=", statement.bindingGeneration)
    .where("runnerId", "=", statement.runnerId)
    .where("runnerBootId", "=", statement.runnerBootId)
    .orderBy("ordinal", "desc")
    .limit(1)
    .executeTakeFirst();
  const terminal = !nonTerminalRunStatuses.some((status) => status === run.status);
  const session = await tx
    .selectFrom("providerSessions")
    .select(["leaseExpiresAt", "active"])
    .where("id", "=", run.providerSessionId)
    .where("runnerId", "=", statement.runnerId)
    .where("runnerBootId", "=", statement.runnerBootId)
    .where("bindingGeneration", "=", statement.bindingGeneration)
    .executeTakeFirst();
  if (
    !attempt ||
    !session ||
    run.bindingGeneration !== statement.bindingGeneration ||
    (!terminal &&
      (!session.active ||
        !session.leaseExpiresAt ||
        session.leaseExpiresAt <= mutation.state.now ||
        (attempt.status === "current" && attempt.endedAt !== null)))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner statement binding is no longer current",
    });

  const disposition = terminal
    ? "terminal-noop"
    : await apply(digest, statement, { kind: attempt.status, attemptId: attempt.id });
  const { finishIntent } = await tx
    .selectFrom("runs")
    .select("finishIntent")
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  if (finishIntent) {
    matchFinish(finishIntent, statement, digest);
    return { finishing: true };
  }
  await recordReceipt(tx, mutation, {
    runId: run.id,
    ordinal: statement.ordinal,
    runnerId: statement.runnerId,
    runnerBootId: statement.runnerBootId,
    bindingGeneration: statement.bindingGeneration,
    reportedDigest: digest,
    disposition,
  });
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
    run.status !== intent.outcome ||
    run.finishIntent?.statement?.digest !== intent.statement.digest ||
    intent.bindingGeneration === null
  )
    throw new Error("Runner finish receipt requires the frozen terminal Run");
  const { ordinal, runnerId, runnerBootId, digest } = intent.statement;
  await recordReceipt(tx, mutation, {
    runId,
    ordinal,
    runnerId,
    runnerBootId,
    bindingGeneration: intent.bindingGeneration,
    reportedDigest: Buffer.from(digest, "hex"),
    disposition: "applied",
  });
}
