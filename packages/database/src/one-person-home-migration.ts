import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Organizations and work Homes were removed: a Home is one person's, and what a connected agent
 * may use is only what that person granted. The two migrations that remain of them live here.
 */

/** Once created a work Home's policy, audit outbox and gates; it creates nothing any more. */
export const workHomeMigrationName = "0049_work_home";
export const removeOrganizationsMigrationName = "0054_remove_organizations_contract";

/**
 * Drops what a work Home had: its policy, its audit outbox and its gates. A Home that was a work
 * Home becomes an ordinary Home of its one person, and every connection keeps the grant and mode
 * stored on its row, with nothing above them. A work Home its organization was closing keeps what
 * the closing ended: each connection still open is revoked, as Disconnect revokes it, so the
 * Disconnect worker stops its work. A chat that ended for a reason that no longer exists keeps no
 * reason and reads as ended. On a database that never had a work Home, only the columns, the
 * functions and the chat reasons are touched, and none of them hold anything.
 */
export async function applyRemoveOrganizations(database: Kysely<unknown>): Promise<void> {
  await sql`
    do $remove$ begin
      if to_regclass('public.work_home_policy') is not null then
        with closing as (
          select 1 from work_home_policy where singleton and state <> 'active'
        ), ended as (
          update agent_connections set revoked_at = now(), token_hash = null,
            grant_revision = grant_revision + 1, cleanup_reason = 'revoked',
            cleanup_requested_at = now(), cleanup_completed_at = null, bridge_ended_by = null
          where revoked_at is null and exists (select 1 from closing)
          returning bridge_from_binding_id
        )
        update channel_bindings set status = 'revoked', updated_at = now()
        where id in (select bridge_from_binding_id from ended) and status <> 'revoked';
      end if;
    end $remove$;

    drop trigger if exists work_audit_capture on agent_connections;
    drop trigger if exists work_audit_capture on agent_sessions;
    drop trigger if exists work_audit_capture on agent_operations;
    drop trigger if exists work_audit_capture on requests;
    drop trigger if exists work_audit_capture on devices;
    drop trigger if exists work_audit_capture on auth_sessions;
    drop trigger if exists work_audit_capture on commands;
    drop trigger if exists work_device_enrollment on devices;
    drop trigger if exists work_sign_in on auth_sessions;
    drop trigger if exists work_operation_policy on agent_operations;
    drop table if exists work_home_policy, work_audit_outbox, work_audit_head;
    drop function if exists work_audit_capture();
    drop function if exists work_home_gate();
    drop function if exists work_audit_append(jsonb, timestamptz);
    alter table agent_operations drop column if exists work_policy_revision;
    alter table commands drop column if exists work_owner_stop;
    alter table runner_enrollments drop column if exists work_enrollment_previewed_at;

    update agent_connections set bridge_ended_by = null
    where bridge_ended_by in ('organization', 'work-home');
    alter table agent_connections
      drop constraint if exists agent_connections_bridge_ended_by_check,
      add constraint agent_connections_bridge_ended_by_check
        check (bridge_ended_by in ('you', 'account', 'computer'));
  `.execute(database);
}

/** By name, each in its place in the order: the first applies nothing, the second contracts. */
export const onePersonHomeFirstMigration: Readonly<Record<string, Migration>> = {
  [workHomeMigrationName]: { async up() {} },
};
export const onePersonHomeContractMigration: Readonly<Record<string, Migration>> = {
  [removeOrganizationsMigrationName]: { up: applyRemoveOrganizations },
};
