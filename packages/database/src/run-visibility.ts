import { sql, type Transaction } from "kysely";
import type { RunId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";

/** Capture before a refused steer can lose its current Run link. Never reset this fact. */
export async function recordPersonWaited(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<void> {
  await transaction
    .updateTable("runs")
    .set({ personWaited: true })
    .where("id", "=", runId)
    .where("personWaited", "=", false)
    .where(
      sql<boolean>`(exists (select 1 from messages input where
      input.id = runs.seed_input_id and input.author->>'kind' = 'human')
      or exists (select 1 from messages input where input.run_id = runs.id
        and input.kind = 'input' and input.author->>'kind' = 'human'))`,
    )
    .execute();
}
