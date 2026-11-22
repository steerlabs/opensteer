import { sql, type Kysely } from "kysely";

export const bridgeSenderAuditMigrationName = "0053_bridge_sender_audit";

/**
 * Who may command a bridge is what an organization audits: a change of a bridge's sender rule
 * is recorded as the connection's grant change, like a change of its grant or mode. Only the
 * connection branch's condition of the audit function changes; the rest is the function as the
 * Home has it, read back from the database, so the previous image's writes behave as before.
 */
export async function applyBridgeSenderAudit(database: Kysely<unknown>): Promise<void> {
  await sql`
    do $migration$
    declare
      definition text := pg_get_functiondef('work_audit_capture()'::regprocedure);
      condition constant text :=
        'elsif new."grant" is distinct from old."grant" or new.access_mode is distinct from old.access_mode then';
      replacement constant text :=
        'elsif new."grant" is distinct from old."grant" or new.access_mode is distinct from old.access_mode or new.bridge_senders is distinct from old.bridge_senders then';
    begin
      if position(condition in definition) = 0 then
        raise exception 'work_audit_capture is not the function this migration expects';
      end if;
      execute replace(definition, condition, replacement);
    end
    $migration$;
  `.execute(database);
}
