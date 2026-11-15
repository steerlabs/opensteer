import {
  createId,
  type GrantId,
  type ModelSelection,
  type RunId,
  type RunnerId,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import { currentRunAttempt, recordAttemptDispatch } from "./run-attempts.js";
import type { DatabaseSchema, GrantTable } from "./schema.js";

/**
 * A grant a transaction revoked. Every token names its grant by Run and binding
 * generation (grant ids came later), so that pair is how whatever a token
 * admitted is found again.
 */
export interface RevokedRunGrant {
  readonly bindingGeneration: number;
  readonly grantId: GrantId;
  readonly reason: NonNullable<GrantTable["revokedReason"]>;
  readonly runId: RunId;
}

/**
 * A grant is revoked only when tool authority ends while its Run lives on. A
 * Run's end, a revoked Runner, a lost membership or a Workspace being deleted
 * already fail assertActiveGrant through the Run and binding it names.
 *
 * Grants and attempts rank last in ./lock-order.ts: each writer already holds
 * the Run and writes them as its final lock.
 */
export async function issueRunGrant(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly bindingGeneration: number;
    readonly modelSelection: ModelSelection;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
): Promise<{ readonly grantId: GrantId; readonly revokedGrants: readonly RevokedRunGrant[] }> {
  const attemptId = (await currentRunAttempt(transaction, input.runId)).id;
  await recordAttemptDispatch(transaction, { ...input, attemptId });
  // A rebinding keeps the attempt; the previous binding's tokens stop working.
  const revokedGrants = await revokeRunGrants(transaction, [input.runId], "binding-replaced");
  const grant = await transaction
    .insertInto("grants")
    .values({
      attemptId,
      bindingGeneration: input.bindingGeneration,
      id: createId("grant"),
      runId: input.runId,
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { grantId: grant.id, revokedGrants };
}

/**
 * Revokes the Runs' active grants and says which they were. A token check
 * stops admitting work the moment this commits; connections already admitted
 * end only when the caller hands the result to OpensteerStore, which announces
 * it after commit.
 */
export async function revokeRunGrants(
  transaction: Transaction<DatabaseSchema>,
  runIds: readonly RunId[],
  reason: NonNullable<GrantTable["revokedReason"]>,
): Promise<readonly RevokedRunGrant[]> {
  if (runIds.length === 0) return [];
  const active = await transaction
    .selectFrom("grants")
    .select(["bindingGeneration", "id", "runId"])
    .where("runId", "in", [...runIds])
    .where("status", "=", "active")
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (active.length === 0) return [];
  await transaction
    .updateTable("grants")
    .set({ revokedAt: new Date(), revokedReason: reason, status: "revoked" })
    .where(
      "id",
      "in",
      active.map(({ id }) => id),
    )
    .execute();
  return active.map((grant) => ({
    bindingGeneration: grant.bindingGeneration,
    grantId: grant.id,
    reason,
    runId: grant.runId,
  }));
}

/** Whether the Run's grant still stands; the caller holds the Run. */
export async function runHasActiveGrant(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  return (
    (await transaction
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", runId)
      .where("status", "=", "active")
      .executeTakeFirst()) !== undefined
  );
}

/** Whether someone asked this Run to stop: the person, or a cancelled Assignment. */
export async function runWasStopped(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  return (
    (await transaction
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.interrupt")
      .limit(1)
      .executeTakeFirst()) !== undefined
  );
}
