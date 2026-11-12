import { sql, type Kysely } from "kysely";
import { Migrator, type MigrationProvider, type MigrationResultSet } from "kysely/migration";
import { PERSONAL_TEAM_BASELINE_SQL } from "./baseline-schema.js";
import type { DatabaseSchema } from "./schema.js";

/**
 * One current reusable invite per team, with unlimited (`null`) or capped uses. Its verifier is
 * also sealed so managers can show the same link again; earlier single-use rows stay valid.
 */
const TEAM_REUSABLE_INVITES_SQL = `
alter table team_invites alter column max_uses drop not null;
alter table team_invites drop constraint team_invites_check;
alter table team_invites add constraint team_invites_uses check ((max_uses is null or max_uses between 1 and 1000) and used_count >= 0 and (max_uses is null or used_count <= max_uses));
alter table team_invites add column sealed_verifier bytea;
create unique index team_invites_current on team_invites((true)) where sealed_verifier is not null and revoked_at is null;
`;

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
        "0003_team_reusable_invites": {
          async up(database) {
            await sql.raw(TEAM_REUSABLE_INVITES_SQL).execute(database);
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
