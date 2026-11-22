import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const automationScriptsMigrationName = "0055_automation_scripts";

/**
 * Expand-only storage for script-based automations, first-class unknown firing outcomes,
 * who-paused provenance, wake/watch fuses, and per-automation write-only sealed secrets.
 *
 * Previous-release compatibility (Y8):
 * - `trigger_revisions` and `trigger_watch_activations` keep their exact column set because
 *   previous-release readers pass `selectAll()` rows into `z.strictObject` schemas; script
 *   payloads live in `trigger_revision_scripts` alongside a non-v5 stub in `program`, and
 *   watch crash notification state lives on `triggers` (whose reader picks columns explicitly).
 * - `trigger_occurrences.status` stays inside its 5 legacy values while `outcome` holds the
 *   6th value (`unknown`).
 * - Pausing legacy v5 programs lands only when the old runtime is removed (Y16).
 */
export async function applyAutomationScripts(database: Kysely<DatabaseSchema>): Promise<void> {
  await sql`
    alter table triggers
      add column paused_by text check (paused_by in ('person', 'agent', 'system')),
      add column paused_by_thread_id text,
      add column paused_at timestamptz,
      add column failing_since timestamptz,
      add column failure_notified_at timestamptz,
      add column overrun_notified_at timestamptz,
      add column watch_crash_notified_at timestamptz,
      add column wake_limit_per_hour integer check (wake_limit_per_hour >= 1),
      add column encrypted_secrets bytea,
      add column secrets_key_version integer check (secrets_key_version >= 1),
      add constraint triggers_secrets_envelope check (
        (encrypted_secrets is null) = (secrets_key_version is null)
      );

    create table trigger_revision_scripts (
      revision_id text primary key references trigger_revisions(id) on delete cascade,
      script jsonb not null
    );

    alter table trigger_occurrences
      add column outcome text check (
        outcome in ('pending', 'running', 'succeeded', 'failed', 'canceled', 'unknown')
      ),
      add column output_pruned_at timestamptz,
      add column webhook_body bytea;

    create table automation_wakes (
      id text primary key,
      trigger_id text not null references triggers(id) on delete cascade,
      occurrence_id text references trigger_occurrences(id) on delete set null,
      activation_id text references trigger_watch_activations(id) on delete set null,
      tool_name text not null,
      request_id text,
      created_at timestamptz not null default now()
    );
    create index automation_wakes_trigger_created
      on automation_wakes(trigger_id, created_at desc);

    alter table automation_failure_notices
      drop constraint if exists automation_failure_notices_reason_check;
    alter table automation_failure_notices
      add constraint automation_failure_notices_reason_check check (
        reason in (
          'final-occurrence-failed',
          'final-occurrence-interrupted',
          'paused',
          'started-failing',
          'overran-schedule',
          'watch-crash-loop',
          'wake-limit-reached',
          'outcome-unknown'
        )
      );

    alter table execution_environments
      add column max_active_watches integer check (max_active_watches >= 0);

    alter table commands
      add column frame_sent_at timestamptz;
  `.execute(database);
}
