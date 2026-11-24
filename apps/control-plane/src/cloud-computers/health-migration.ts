import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What the account keeps of problem reports, and nothing more: the latest health report each
 * Cloud Computer sent (replaced by the next), and how many reports from people's own Homes named
 * each problem code on each day. Expand-only.
 */
export const problemReportsMigration: Migration = {
  async up(database) {
    await sql`
      create table public.cloud_computer_health (
        computer_id text primary key references public.cloud_computers(id) on delete cascade,
        received_at timestamptz not null,
        report jsonb not null
      );
      create table public.problem_report_counts (
        day date not null,
        code text not null,
        reports integer not null default 0 check (reports >= 0),
        total integer not null default 0 check (total >= 0),
        primary key (day, code)
      );
    `.execute(database);
  },
};
