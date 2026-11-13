import { sql, type Kysely } from "kysely";
import { Migrator, type MigrationProvider, type MigrationResultSet } from "kysely/migration";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import type { DatabaseSchema } from "./schema.js";

export const personalTeamBaselineName = "0002_personal_team_baseline";
export function migrationProvider(): MigrationProvider {
  return {
    async getMigrations() {
      return {
        [personalTeamBaselineName]: {
          async up(database) {
            await sql.raw(PERSONAL_TEAM_BASELINE_SQL).execute(database);
          },
        },
        "0003_devices": {
          async up(database) {
            await sql`
              update runners set access_policy =
                jsonb_build_object('browser', true, 'apps', true) || access_policy;
              alter table auth_sessions add column device_id text null references runners(id);
              create index auth_sessions_device_id_idx on auth_sessions(device_id);
              alter table runner_enrollments add column initial_access jsonb null;
              alter table runner_enrollments add column prepared_identity jsonb null;
            `.execute(database);
          },
        },
        "0004_device_access_requests": {
          async up(database) {
            await sql`
              alter table agent_control_requests drop constraint agent_control_requests_action_check;
              alter table agent_control_requests add constraint agent_control_requests_action_check check (action in ('device.access.request', 'assignment.cancel', 'machine.full-disk-access.request', 'browser.access.request', 'browser.profile.create', 'browser.profile.list', 'browser.sign-in', 'browser.session.close', 'browser.session.list', 'browser.session.open', 'browser.tab.read', 'browser.tab.write', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'person.message', 'person.show', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list'));
              alter table agent_control_requests drop constraint agent_control_requests_action_class_check;
              alter table agent_control_requests add constraint agent_control_requests_action_class_check check (action_class in ('device.access.request', 'person.show', 'assignment.cancel', 'machine.full-disk-access.request', 'browser.access.request', 'browser.profile.create', 'browser.profile.list', 'browser.sign-in', 'browser.session.close', 'browser.session.list', 'browser.session.open', 'browser.tab.read', 'browser.tab.write', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list'));
            `.execute(database);
          },
        },
        "0005_device_setup_retirement": {
          async up(database) {
            await sql`create table device_setup_retirements (
              runner_id text not null,
              public_key_pem text not null,
              primary key (runner_id, public_key_pem)
            )`.execute(database);
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
