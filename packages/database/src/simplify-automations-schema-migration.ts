import { sql, type Kysely } from "kysely";

/**
 * Withdraws the Y8 backwards-compatibility parallel database shape (AGENTS.md rule 6):
 * - Moves `script` directly onto `trigger_revisions` (plus nullable `legacy_source` for T14
 *   paused v5 revisions), drops `trigger_revision_scripts`, and drops `trigger_revisions.program`.
 * - Widens `trigger_occurrences.status` directly to allow `'unknown'`, migrates any
 *   `outcome = 'unknown'` rows into `status = 'unknown'`, and drops `trigger_occurrences.outcome`.
 */
export const simplifyAutomationsSchemaMigrationName = "0057_automations_schema_contract";

export async function applySimplifyAutomationsSchema(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table trigger_revisions add column if not exists script jsonb;
    alter table trigger_revisions add column if not exists legacy_source text;

    update trigger_revisions
    set script = trigger_revision_scripts.script
    from trigger_revision_scripts
    where trigger_revision_scripts.revision_id = trigger_revisions.id
      and trigger_revisions.script is null;

    update trigger_revisions
    set legacy_source = program->>'source'
    where script is null
      and legacy_source is null
      and program is not null
      and program ? 'source';

    drop table if exists trigger_revision_scripts;
    alter table trigger_revisions drop column if exists program;

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
      add constraint trigger_occurrences_status_check
      check (status in ('pending', 'running', 'succeeded', 'failed', 'canceled', 'unknown'));

    update trigger_occurrences
    set status = 'unknown'
    where outcome = 'unknown' and status <> 'unknown';

    alter table trigger_occurrences drop column if exists outcome;
  `.execute(database);
}
