import { type Kysely } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { type RunId, type DeviceId, nonTerminalRunStatuses } from "@opensteer/core";

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
    readonly deviceId: DeviceId;
  },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "=", input.runId)
      .where("status", "in", nonTerminalRunStatuses)
      .forKeyShare()
      .executeTakeFirst();
    if (!run) return;
    const device = await transaction
      .selectFrom("devices")
      .select("id")
      .where("id", "=", input.deviceId)
      .where("removedAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!device) return;
    await transaction
      .insertInto("computerUseStops")
      .values({ runId: input.runId, deviceId: input.deviceId })
      .onConflict((c) => c.columns(["runId", "deviceId"]).doNothing())
      .execute();
  });
}

/** The Stops that still bind a Run: those of Runs that have not ended. */
export async function activeComputerUseStops(
  database: Kysely<DatabaseSchema>,
): Promise<readonly { readonly runId: RunId; readonly deviceId: DeviceId }[]> {
  return database
    .selectFrom("computerUseStops")
    .innerJoin("runs", "runs.id", "computerUseStops.runId")
    .select(["computerUseStops.runId", "computerUseStops.deviceId"])
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
