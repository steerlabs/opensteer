import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What the account keeps of problem reports, and nothing more: the latest health report each
 * Cloud Computer sent, replaced by the next. Also the watch's own clocks beside the provisioner's
 * deadline clock (`readiness_started_at`): when a Cloud Computer last became ready, when its
 * current outage began and when its current run of outages began, so one restart does not page
 * and a computer that keeps going down does (`report`, `watch`); and which Account the synthetic
 * purchase's own sign-in made, the only one it signs in. Expand-only.
 *
 * A computer that is ready as this runs has been ready: its `ready_at` is the last time it was
 * seen so, its last report (or its last change when it never reported), never earlier, so no
 * outage of it is read as its first set-up and none is given a longer history than was seen.
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
      alter table public.cloud_computers add column if not exists unstable_since timestamptz;
      alter table public.users add column if not exists synthetic_at timestamptz;
      update public.cloud_computers set ready_at = coalesce(reported_at, updated_at)
        where phase = 'ready' and ready_at is null;
    `.execute(database);
  },
};
