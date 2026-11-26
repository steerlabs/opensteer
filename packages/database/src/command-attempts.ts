import { randomUUID } from "node:crypto";
import type { CommandRequestOutcome, UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { idempotencyConflict, jsonValue } from "./store-primitives.js";

/**
 * A command with an effect outside the database is recorded before it acts and settled after
 * (G4): in its connection's Disconnect set while it runs, so a Disconnect waits for its evidence,
 * and never sent again by the Home. One that a restart cut off is unknown.
 */
export interface CommandAttemptInput {
  readonly requestedBy: UserId;
  readonly callerKey: string;
  /** The connection whose Disconnect waits on it; null for the person and your own agents. */
  readonly connectionId: string | null;
  readonly type: string;
  readonly idempotencyKey: string;
}

/** The attempt begun, or the earlier one of the same caller and key that answers instead (K1). */
export type CommandAttemptBegin =
  | { readonly kind: "begun"; readonly id: string }
  | { readonly kind: "prior"; readonly state: "running" | "unknown" | "done" };

/**
 * Records the attempt, in one transaction with the last admission (`readmit`, G3): nothing
 * outside the database is touched before both commit, and a refusal records nothing. One key is
 * one attempt (K1): an earlier attempt of the same caller and key answers instead, running or
 * unknown (it may have happened: never sent again), or done (the handler's own lookup replays
 * it). Only one that failed, so nothing happened, lets the key be sent again. Two at once: the
 * index lets one in, and the other finds it.
 */
export async function beginCommandAttempt(
  database: Kysely<DatabaseSchema>,
  input: CommandAttemptInput,
  readmit?: (transaction: Kysely<DatabaseSchema>) => Promise<void>,
): Promise<CommandAttemptBegin> {
  return withDatabaseTransaction(database, async (transaction) => {
    await readmit?.(transaction);
    const id = `cat_${randomUUID()}`;
    const inserted = await transaction
      .insertInto("commandAttempts")
      .values({
        id,
        requestedBy: input.requestedBy,
        callerKey: input.callerKey,
        connectionId: input.connectionId,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        settledAt: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["requestedBy", "callerKey", "idempotencyKey"])
          .where("state", "<>", "failed")
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { kind: "begun", id };
    const prior = await transaction
      .selectFrom("commandAttempts")
      .select(["state", "type"])
      .where("requestedBy", "=", input.requestedBy)
      .where("callerKey", "=", input.callerKey)
      .where("idempotencyKey", "=", input.idempotencyKey)
      .where("state", "<>", "failed")
      .executeTakeFirstOrThrow();
    // The key was used for another command: this one did nothing.
    if (prior.type !== input.type) throw idempotencyConflict(input.idempotencyKey);
    return { kind: "prior", state: prior.state as "running" | "unknown" | "done" };
  });
}

/** Settles a running attempt as what is known of its effect; a settled one is left as it is. */
export async function settleCommandAttempt(
  database: Kysely<DatabaseSchema>,
  id: string,
  state: "done" | "failed" | "unknown",
  outcome?: CommandRequestOutcome,
): Promise<void> {
  await database
    .updateTable("commandAttempts")
    .set({ state, settledAt: new Date(), ...(outcome ? { outcome: jsonValue(outcome) } : {}) })
    .where("id", "=", id)
    .where("state", "=", "running")
    .execute();
}

/** At startup: what was running when the Home stopped may have happened, so it is unknown. */
export async function recoverCommandAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<{ readonly recovered: number }> {
  const result = await database
    .updateTable("commandAttempts")
    .set({ state: "unknown", settledAt: new Date() })
    .where("state", "=", "running")
    .executeTakeFirst();
  return { recovered: Number(result.numUpdatedRows) };
}
