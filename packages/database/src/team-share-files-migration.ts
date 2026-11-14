import { sql, type Kysely } from "kysely";

export async function migrateTeamShareFiles(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table team_blobs
      add column public_id uuid not null default gen_random_uuid(),
      add column remote_share_id uuid references team_shares(id),
      add column preview_sha256 text;
    create unique index team_blobs_public_id on team_blobs(channel_id, public_id);
    alter table team_blobs drop constraint team_blobs_storage_key_key;
    alter table team_share_relays add column attachment_public_ids uuid[] not null default '{}';
  `.execute(database);
}
