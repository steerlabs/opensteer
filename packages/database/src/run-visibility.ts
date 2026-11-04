import { sql, type Transaction } from "kysely";
import type { RunId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";

/** Record direct human participation. Machine fulfilment can set resolvedBy too,
 * so Requests require authenticated settlement provenance. Never reset this fact. */
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
        and input.kind = 'input' and input.author->>'kind' = 'human')
      or exists (select 1 from requests answered where
        answered.originating_run_id = runs.id and answered.mode = 'live'
        and answered.status in ('fulfilled', 'declined') and answered.resolved_by is not null and answered.settlement_provenance is not null)
      or exists (select 1 from messages input join requests answered
        on answered.id = input.author->>'referenceId'
        where input.id = runs.seed_input_id and input.author->>'kind' = 'platform'
        and input.author->>'cause' = 'request-resolved'
        and answered.originating_thread_id = runs.thread_id
        and answered.originating_run_id = runs.authority_source->>'sourceRunId'
        and answered.mode = 'durable' and answered.status in ('fulfilled', 'declined')
        and answered.resolved_by is not null and answered.settlement_provenance is not null))`,
    )
    .execute();
}
