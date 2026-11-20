import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const agentDirectoryMigration: Migration = {
  async up(database) {
    await sql`
      create table public.agent_directory_state (
        id integer primary key check (id = 1),
        revision integer not null default 1 check (revision >= 1),
        updated_at timestamptz not null default now()
      );
      insert into public.agent_directory_state (id, revision) values (1, 1);
      create table public.agent_directory_entries (
        id text primary key check (id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
        display_name text not null check (char_length(display_name) between 1 and 100),
        origins jsonb not null,
        keys jsonb,
        embeds_via jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(database);
  },
};
