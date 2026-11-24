import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What the account keeps of problem reports, and nothing more: the latest health report each
 * Cloud Computer sent, replaced by the next. Also when a Cloud Computer last became ready and when
 * its current outage began, so a computer that keeps going down is not given a fresh clock each
 * time and a single restart does not page (`report`, `watch`), and which
 * Account the synthetic purchase's own sign-in made, the only one it signs in. Expand-only.
 */
export const problemReportsMigration: Migration = {
  async up(database) {
    await sql`
      create table if not exists public.cloud_computer_health (
        computer_id text primary key references public.cloud_computers(id) on delete cascade,
        received_at timestamptz not null,
        report jsonb not null
      );
      alter table public.cloud_computers add column if not exists ready_at timestamptz;
      alter table public.cloud_computers add column if not exists down_at timestamptz;
      alter table public.users add column if not exists synthetic_at timestamptz;
    `.execute(database);
  },
};
