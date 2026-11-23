import { sql, type Kysely } from "kysely";
import { migrateToLatest, migrationProvider } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * Runs the migrations from `from` through `through` once more, and only those, through the
 * ordinary migrator: their ledger rows are set aside, the migrator sees the list cut after
 * `through`, and the rows of the later migrations are put back.
 *
 * A test seeds a database that is already at the latest schema and then replays the migration it
 * is about. `through` is the last migration that changes what that test seeds and reads; a
 * migration after it is never run a second time, so nothing it made has to be undone first.
 */
export async function replayMigrations(
  database: Kysely<DatabaseSchema>,
  from: string,
  through: string = from,
): Promise<void> {
  const later = await sql<{ name: string; timestamp: string }>`
    select name, timestamp from kysely_migration where name > ${through}`.execute(database);
  await sql`delete from kysely_migration where name >= ${from}`.execute(database);
  const all = await migrationProvider().getMigrations();
  const throughLast = Object.fromEntries(Object.entries(all).filter(([name]) => name <= through));
  await migrateToLatest(database, { getMigrations: async () => throughLast });
  for (const row of later.rows)
    await sql`insert into kysely_migration (name, timestamp) values (${row.name}, ${row.timestamp})`.execute(
      database,
    );
}
