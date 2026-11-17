import type { DatabaseSchema } from "./schema.js";
import { sql } from "kysely";
import { createDatabase } from "./connection.js";
import { createStoreFixture } from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

export async function createPersonalStateFixture(suffix: string) {
  const fixture = await createStoreFixture();
  try {
    const run = await fixture.startRunFixture(suffix);
    await sql`delete from client_changes; update client_sync_state set ready=true,pruned_through_sequence=sequence,retained_change_count=0`.execute(
      fixture.database,
    );
    const { database } = await ownTestDatabaseProducer(fixture.databaseUrl, async () => {
      const database = createDatabase<DatabaseSchema>({
        connectionString: fixture.databaseUrl,
      });
      return { database, close: () => database.destroy() };
    });
    const attempt = await database
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", run.runId)
      .where("status", "=", "current")
      .limit(1)
      .executeTakeFirstOrThrow();
    return { ...fixture, database, run, attemptId: attempt.id };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

// Runtime setup writes canonical rows using the current schema. Reset its
// projections to the state immediately after migration 0029's schema step.
export async function preparePersonalConversion(
  database: import("kysely").Kysely<DatabaseSchema>,
  sourceSequence = 0,
) {
  const { PERSONAL_TEAM_BASELINE_SQL } = await import("./baseline-schema.js");
  await database.transaction().execute(async (tx) => {
    for (const table of ["deployment_events", "thread_state_pending"]) {
      const ddl = PERSONAL_TEAM_BASELINE_SQL.match(
        new RegExp(`create table ${table} \\(.*?\\n\\);`, "s"),
      )?.[0];
      if (!ddl) throw new Error(`Missing frozen table DDL for ${table}`);
      await sql.raw(ddl).execute(tx);
    }
    await sql`
      create index deployment_events_run on deployment_events(run_id,sequence) where run_id is not null;
      alter table threads add column projected_input_queue_paused boolean not null default false;
      alter table client_sync_state add column upgrade_cursor jsonb;
      truncate client_changes, runner_event_receipts, transcript_items, tool_output_images,
        tool_calls, personal_attention;
      update threads set next_transcript_position=0, transcript_order_revision=0,
        latest_run_completed_at=null, last_reply_message_id=null, last_reply_preview=null,
        failure_preview=null, revision=0, input_queue_revision=0;
    `.execute(tx);
    await tx
      .updateTable("clientSyncState")
      .set({
        ready: false,
        sequence: sourceSequence.toString(),
        prunedThroughSequence: "0",
        retainedChangeCount: 0,
        pendingRequestCount: 0,
        pendingDeviceAccessRequestCount: 0,
        needsYouCount: 0,
        unreadTaskCount: 0,
      })
      .execute();
  });
}
