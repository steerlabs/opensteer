import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const automationsContractMigrationName = "0055_automations_contract";

/**
 * Moves pre-script automations storage directly onto the script-automation contract
 * (AGENTS.md rule 6; T1–T14, Y1–Y16, AA3, AA6, AA7, AA9, AA13):
 * - Replaces `trigger_revisions.program` with `script` (jsonb) and `legacy_source` (text),
 *   pausing active user-authored legacy automations with "Needs an update: ask your agent"
 *   and stopping their active watches while preserving memory passes and archived rows.
 * - Widens `trigger_occurrences.status` to include `'unknown'` and adds `output_pruned_at`
 *   and `webhook_body`.
 * - Adds `paused_by` (`person`/`agent`/`connection`/`system`), `paused_by_connection_id`,
 *   `paused_by_thread_id`, `paused_at`, `failing_since`, `failure_notified_at`,
 *   `overrun_notified_at`, `watch_crash_notified_at`, and sealed secrets columns on `triggers`,
 *   and drops retired `webhook_secret_hash` and `consecutive_failures`.
 * - Drops the retired `watch_control_requests` ledger.
 * - Adds `commands.frame_sent_at` and backfills already-dispatched `trigger.execute` rows so
 *   in-flight firings settle to `unknown` after upgrade rather than rerunning.
 */
export async function applyAutomationsContract(database: Kysely<DatabaseSchema>): Promise<void> {
  await sql`
    alter table triggers
      add column paused_by text check (paused_by in ('person', 'agent', 'connection', 'system')),
      add column paused_by_connection_id text,
      add column paused_by_thread_id text,
      add column paused_at timestamptz,
      add column failing_since timestamptz,
      add column failure_notified_at timestamptz,
      add column overrun_notified_at timestamptz,
      add column watch_crash_notified_at timestamptz,
      add column encrypted_secrets bytea,
      add column secrets_key_version integer check (secrets_key_version >= 1),
      add constraint triggers_secrets_envelope check (
        (encrypted_secrets is null) = (secrets_key_version is null)
      ),
      drop column if exists webhook_secret_hash,
      drop column if exists consecutive_failures;

    alter table trigger_revisions
      add column script jsonb,
      add column legacy_source text;

    update trigger_revisions
    set legacy_source = coalesce(program->>'source', program::text)
    where script is null
      and legacy_source is null
      and program is not null;

    alter table trigger_revisions
      drop column if exists program,
      add constraint trigger_revisions_script_or_legacy_check check (
        (script is not null) <> (legacy_source is not null)
      );

    update triggers
    set
      status = 'paused',
      next_fire_at = null,
      pause_reason = 'Needs an update: ask your agent',
      paused_by = 'system',
      paused_by_connection_id = null,
      paused_by_thread_id = null,
      paused_at = now(),
      updated_at = now()
    where status = 'active'
      and system_role is null
      and exists (
        select 1 from trigger_revisions
        where trigger_revisions.id = triggers.current_revision_id
          and trigger_revisions.script is null
      );

    update trigger_watch_activations
    set
      desired = 'stopped',
      updated_at = now()
    where desired = 'active'
      and trigger_id in (
        select triggers.id from triggers
        join trigger_revisions on trigger_revisions.id = triggers.current_revision_id
        where triggers.system_role is null
          and trigger_revisions.script is null
      );

    do $$
    declare
      constraint_row record;
    begin
      for constraint_row in
        select con.conname
        from pg_constraint con
        join pg_class cls on cls.oid = con.conrelid
        join pg_namespace ns on ns.oid = cls.relnamespace
        where ns.nspname = current_schema()
          and cls.relname = 'trigger_occurrences'
          and con.contype = 'c'
          and pg_get_constraintdef(con.oid) like '%status%'
      loop
        execute format('alter table trigger_occurrences drop constraint %I', constraint_row.conname);
      end loop;
    end $$;

    alter table trigger_occurrences
      add column output_pruned_at timestamptz,
      add column webhook_body bytea,
      add constraint trigger_occurrences_status_check check (
        status in ('pending', 'running', 'succeeded', 'failed', 'canceled', 'unknown')
      );

    do $$
    declare
      constraint_row record;
    begin
      for constraint_row in
        select con.conname
        from pg_constraint con
        join pg_class cls on cls.oid = con.conrelid
        join pg_namespace ns on ns.oid = cls.relnamespace
        where ns.nspname = current_schema()
          and cls.relname = 'trigger_watch_activations'
          and con.contype = 'c'
          and pg_get_constraintdef(con.oid) like '%observed%'
      loop
        execute format('alter table trigger_watch_activations drop constraint %I', constraint_row.conname);
      end loop;
    end $$;

    alter table trigger_watch_activations
      add constraint trigger_watch_activations_observed_check check (
        observed in ('starting', 'running', 'backoff', 'halted', 'expired', 'stopped')
      );

    alter table automation_failure_notices
      drop constraint if exists automation_failure_notices_reason_check;
    alter table automation_failure_notices
      add constraint automation_failure_notices_reason_check check (
        reason in (
          'final-occurrence-failed',
          'final-occurrence-interrupted',
          'paused',
          'started-failing',
          'started-unknown',
          'overran-schedule',
          'watch-crash-loop',
          'watch-halted',
          'outcome-unknown'
        )
      );

    drop table if exists watch_control_requests;

    alter table commands
      add column frame_sent_at timestamptz;
    update commands
      set frame_sent_at = updated_at
      where type = 'trigger.execute'
        and status = 'dispatched'
        and frame_sent_at is null;
  `.execute(database);
}
