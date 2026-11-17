import { createHash } from "node:crypto";
import {
  OpensteerError,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import { sql } from "kysely";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import type { RunnerEventReceiptTable } from "./personal-state-schema.js";

interface RunnerStatement {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly runnerId: RunnerId;
  readonly runnerBootId: string;
  readonly bindingGeneration: number;
  readonly ordinal: number;
  readonly type: string;
  readonly data: unknown;
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

export function runnerStatementDigest(statement: RunnerStatement) {
  const { emittedAt, ...reported } = statement;
  return personalArgumentDigest(
    statement.type === "assistant.message"
      ? reported
      : { ...reported, emittedAt: new Date(emittedAt).toISOString() },
  );
}

type Disposition = RunnerEventReceiptTable["disposition"];

export async function acceptPersonalRunnerStatement(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  statement: RunnerStatement,
  apply: (digest: Buffer) => Promise<Disposition>,
): Promise<{ readonly throughOrdinal: number; readonly replayed: boolean }> {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "threadId", "environmentId", "nextRunnerOrdinal", "finishIntent"])
    .where("id", "=", statement.runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run || run.threadId !== statement.threadId || run.environmentId !== statement.environmentId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner statement does not belong to that Run",
    });
  const digest = runnerStatementDigest(statement);
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
  const pending = run.finishIntent?.statement;
  if (
    run.finishIntent &&
    (!pending ||
      pending.ordinal !== statement.ordinal ||
      pending.digest !== digest.toString("hex") ||
      pending.runnerId !== statement.runnerId ||
      pending.runnerBootId !== statement.runnerBootId ||
      run.finishIntent.bindingGeneration !== statement.bindingGeneration)
  )
    throw new OpensteerError({
      code: "conflict",
      message: "The Run is finishing",
      retryable: true,
    });
  const disposition = await apply(digest);
  await tx
    .updateTable("runs")
    .set({ nextRunnerOrdinal: sql<number>`next_runner_ordinal + 1` })
    .where("id", "=", run.id)
    .execute();
  mutation.receipt(async (committedHead) => {
    await tx
      .insertInto("runnerEventReceipts")
      .values({
        runId: run.id,
        ordinal: statement.ordinal,
        runnerId: statement.runnerId,
        runnerBootId: statement.runnerBootId,
        bindingGeneration: statement.bindingGeneration,
        reportedDigest: digest,
        disposition,
        committedHead,
      })
      .execute();
  });
  return { throughOrdinal: statement.ordinal, replayed: false };
}
