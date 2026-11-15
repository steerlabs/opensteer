import { type Kysely } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { type RunId, type RunnerId, nonTerminalRunStatuses } from "@opensteer/core";

/**
 * Records a person's Stop for a Run on one computer, durably and idempotently.
 *
 * A Run or computer that no longer exists can never act again, so its Stop
 * is already in effect: nothing is written and the Stop is settled all the
 * same. A computer that reports a Stop after its Run was deleted is told it
 * is recorded, rather than retried forever against the ledger's foreign keys.
 */
export async function recordComputerUseStop(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly runnerId: RunnerId;
  },
): Promise<void> {
  await database
    .insertInto("computerUseStops")
    .columns(["runId", "runnerId"])
    .expression(
      database
        .selectFrom("runs")
        .innerJoin("runners", (join) => join.onTrue())
        .select(["runs.id as runId", "runners.id as runnerId"])
        .where("runs.id", "=", input.runId)
        .where("runners.id", "=", input.runnerId),
    )
    .onConflict((conflict) => conflict.columns(["runId", "runnerId"]).doNothing())
    .execute();
}

/** The Stops that still bind a Run: those of Runs that have not ended. */
export async function activeComputerUseStops(
  database: Kysely<DatabaseSchema>,
): Promise<readonly { readonly runId: RunId; readonly runnerId: RunnerId }[]> {
  return database
    .selectFrom("computerUseStops")
    .innerJoin("runs", "runs.id", "computerUseStops.runId")
    .select(["computerUseStops.runId", "computerUseStops.runnerId"])
    .where("runs.status", "in", nonTerminalRunStatuses)
    .execute();
}

/** A Run that ended needs none of its Stops any more. */
export async function clearComputerUseStops(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<void> {
  await database.deleteFrom("computerUseStops").where("runId", "=", runId).execute();
}
