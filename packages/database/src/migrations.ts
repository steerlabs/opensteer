import { sql, type Kysely } from "kysely";
import { Migrator, type MigrationProvider, type MigrationResultSet } from "kysely/migration";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import type { DatabaseSchema } from "./schema.js";

export const personalTeamBaselineName = "0002_personal_team_baseline";
export const threadVisitsMigrationName = "0004_thread_visits";
export function migrationProvider(): MigrationProvider {
  return {
    async getMigrations() {
      return {
        [personalTeamBaselineName]: {
          async up(database) {
            await sql.raw(PERSONAL_TEAM_BASELINE_SQL).execute(database);
          },
        },
        "0003_browser_source_binding": {
          /** The destination a source paired on; null until a source paired before this binds. */
          async up(database) {
            await sql`alter table browser_sources add column paired_origin text, add column paired_route_generation integer`.execute(
              database,
            );
          },
        },
        [threadVisitsMigrationName]: {
          async up(database) {
            await sql`update runs set completed_at = least(date_trunc('milliseconds', completed_at), date_trunc('milliseconds', now())) where completed_at is not null`.execute(
              database,
            );
            await sql`alter table messages alter column created_at set default date_trunc('milliseconds', clock_timestamp())`.execute(
              database,
            );
            await sql`create table thread_visits (
              thread_id text not null references threads(id) on delete cascade,
              user_id text not null references users(id) on delete cascade,
              last_visited_at timestamptz not null, updated_at timestamptz not null,
              primary key(thread_id, user_id))`.execute(database);
            await sql`insert into thread_visits(thread_id, user_id, last_visited_at, updated_at)
              select thread.id, settings.owner_id,
                case when latest.completed_at is not null and exists (
                  select 1 from messages message
                  left join thread_inputs inbox on inbox.message_id = message.id
                  where message.thread_id = thread.id and message.sequence > coalesce(marker.sequence, -1)
                    and date_trunc('milliseconds', message.created_at) <= latest.completed_at
                    and message.kind in ('input', 'assistant', 'run-result')
                    and (inbox.message_id is null or inbox.state = 'delivered' or (inbox.policy = 'report' and inbox.state <> 'cancelled'))
                    and (message.author->>'kind' <> 'human'
                      or coalesce(message.author->>'userId', inbox.requested_by) is distinct from settings.owner_id)
                    and (thread.purpose <> 'voice' or message.kind in ('assistant', 'run-result') or message.author->>'kind' = 'human')
                ) then latest.completed_at - interval '1 millisecond'
                  else coalesce(latest.completed_at, least(marker.updated_at, now()), now()) end,
                least(coalesce(marker.updated_at, thread.updated_at), now())
              from threads thread cross join personal_settings settings
              left join thread_read_markers marker on marker.thread_id = thread.id and marker.user_id = settings.owner_id
              left join lateral (select case when status in ('completed', 'failed', 'interrupted') then completed_at end as completed_at
                from runs where thread_id = thread.id order by run_ordinal desc limit 1) latest on true`.execute(
              database,
            );
            await sql`drop table thread_read_markers`.execute(database);
          },
        },
        "0005_thread_input_fresh_context": {
          async up(database) {
            await sql`alter table thread_inputs add column fresh_context boolean not null default false`.execute(
              database,
            );
            await sql`create or replace view thread_work_inputs as select * from thread_inputs where policy in ('queue','steer')`.execute(
              database,
            );
          },
        },
      };
    },
  };
}
export class MigrationLineageError extends Error {
  readonly unknownMigrations: readonly string[];
  constructor(unknownMigrations: readonly string[], options?: ErrorOptions) {
    super(
      `This database belongs to an earlier or unknown Opensteer lineage (${unknownMigrations.join(", ")}). Start with a fresh database.`,
      options,
    );
    this.name = "MigrationLineageError";
    this.unknownMigrations = unknownMigrations;
  }
}
export async function migrateToLatest(
  database: Kysely<DatabaseSchema>,
  provider: MigrationProvider = migrationProvider(),
): Promise<MigrationResultSet> {
  const ledger = await sql<{
    exists: boolean;
  }>`select to_regclass('public.kysely_migration') is not null as exists`.execute(database);
  let hasAppliedMigrations = false;
  if (ledger.rows[0]?.exists) {
    const known = new Set(Object.keys(await provider.getMigrations()));
    const applied = await sql<{
      name: string;
    }>`select name from public.kysely_migration order by name`.execute(database);
    hasAppliedMigrations = applied.rows.length > 0;
    const unknown = applied.rows.map((row) => row.name).filter((name) => !known.has(name));
    if (unknown.length) throw new MigrationLineageError(unknown);
  }
  if (!hasAppliedMigrations) {
    const existing = await sql<{
      name: string;
    }>`select tablename as name from pg_tables where schemaname='public' and tablename not in ('kysely_migration','kysely_migration_lock') order by tablename`.execute(
      database,
    );
    if (existing.rows.length) throw new MigrationLineageError(["unversioned-database"]);
  }
  const result = await new Migrator({ db: database, provider }).migrateToLatest();
  const failure = result.results?.find((entry) => entry.status === "Error");
  if (result.error || failure)
    throw new Error(`Database migration failed${failure ? ` at ${failure.migrationName}` : ""}`, {
      cause: result.error,
    });
  return result;
}
