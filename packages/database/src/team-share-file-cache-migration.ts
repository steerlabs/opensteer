import { sql, type Kysely } from "kysely";

export async function migrateTeamShareFileCache(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table team_blobs
      add column cache_original_reserved boolean not null default false,
      add column cache_preview_reserved boolean not null default false;
  `.execute(database);
}
