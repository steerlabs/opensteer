import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What the account keeps of problem reports, and nothing more: the latest health report each
 * Cloud Computer sent, replaced by the next. Also the watch's own clocks beside the provisioner's
 * deadline clock (`readiness_started_at`): when a Cloud Computer last became ready, when its
 * current outage and its current run of outages began, and when it last left active, so one
 * restart does not page, a computer that keeps going down does, and time not active never counts
 * (`report`, `watch`, `transition`); and which Account the synthetic purchase's own sign-in made,
 * the only one it signs in. Expand-only, and a no-op when run again.
 *
 * The rows it finds were judged by the rules before it, so the first watch pass after it pages
 * nobody for time that passed under them. Evidence that a computer was ready before is the old
 * schema's `ever_ready`. A computer ready now has been ready since no later than its last report
 * (its last change when it never reported). An active computer that was ready before and is not
 * now is in an outage from this migration on: its outage, its run and its attempt start now, and
 * a readiness-deadline failure of it, judged by the old rules against an attempt before this
 * outage, is booting again (the provisioner fails it after ten real minutes if it is truly down).
 * A never-ready attempt past its limit and a terminal failure still page.
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
      alter table public.cloud_computers add column if not exists inactive_since timestamptz;
      alter table public.users add column if not exists synthetic_at timestamptz;
      update public.cloud_computers set ready_at = coalesce(reported_at, updated_at)
        where phase = 'ready' and ready_at is null;
      update public.cloud_computers set
          phase = case when phase = 'failed'
              and last_error = 'The Cloud Computer did not become ready before its deadline.'
            then 'booting' else phase end,
          last_error = case when phase = 'failed'
              and last_error = 'The Cloud Computer did not become ready before its deadline.'
            then null else last_error end,
          ready_at = updated_at,
          down_at = now(),
          unstable_since = now(),
          readiness_started_at = greatest(now(), readiness_started_at)
        where state = 'active' and ever_ready and phase <> 'ready' and down_at is null;
    `.execute(database);
  },
};
