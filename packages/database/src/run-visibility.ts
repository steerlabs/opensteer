import { sql, type Transaction } from "kysely";
import type { RunId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";

/** Unknown seed authors cannot prove that a turn is quiet. Used by migration and finalization. */
export const quietRunPredicate = sql<boolean>`(
  exists (select 1 from messages seed where seed.id = runs.seed_input_id
    and seed.author->>'kind' <> 'human')
  and not runs.person_waited
  and not exists (select 1 from messages reply where reply.run_id = runs.id
    and reply.kind in ('assistant', 'run-result'))
  and not exists (select 1 from delegations child where child.parent_run_id = runs.id)
  and not exists (select 1 from requests request where request.originating_run_id = runs.id)
)`;

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
