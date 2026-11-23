import { randomUUID } from "node:crypto";
import type { UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";

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

/**
 * Records the attempt, in one transaction with the last admission (`readmit`, G3): nothing
 * outside the database is touched before both commit, and a refusal records nothing.
 */
export async function beginCommandAttempt(
  database: Kysely<DatabaseSchema>,
  input: CommandAttemptInput,
  readmit?: (transaction: Kysely<DatabaseSchema>) => Promise<void>,
): Promise<string> {
  return withDatabaseTransaction(database, async (transaction) => {
    await readmit?.(transaction);
    const id = `cat_${randomUUID()}`;
    await transaction
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
      .execute();
    return id;
  });
}

/** Settles a running attempt as what is known of its effect; a settled one is left as it is. */
export async function settleCommandAttempt(
  database: Kysely<DatabaseSchema>,
  id: string,
  state: "done" | "failed" | "unknown",
): Promise<void> {
  await database
    .updateTable("commandAttempts")
    .set({ state, settledAt: new Date() })
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
