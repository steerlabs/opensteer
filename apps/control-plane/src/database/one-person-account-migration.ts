import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Organizations were removed: a Cloud Computer is one person's, bought and paid by that person.
 * The two migrations that remain of them live here.
 */

/** Once created organizations, their seats, work assignments and audit; it creates nothing now. */
export const organizationsMigrationName = "0030_organizations";
export const removeOrganizationsMigrationName = "0037_remove_organizations";

/**
 * Drops organizations, seats, work assignments and their audit. A Cloud Computer an organization
 * paid for has no subscription of its own (its Stripe ids are the placeholder `work:<assignment>`)
 * and nobody left who pays for it, so it is deleted the way an organization's offboarding ended
 * one: the provisioner destroys it and its backups, and there is nothing to settle in Stripe.
 * Backup targets reserved for an organization go back to the shared pool. On a database that
 * never had an organization, only empty columns and tables are dropped.
 */
async function removeOrganizations(database: Parameters<Migration["up"]>[0]): Promise<void> {
  await sql`
    do $remove$ begin
      if exists (select 1 from information_schema.columns where table_schema = 'public'
          and table_name = 'cloud_computers' and column_name = 'work_assignment_id') then
        update public.cloud_computers set state = 'deleted', phase = 'deleting',
          deletion_requested_at = coalesce(deletion_requested_at, now()),
          deleted_at = coalesce(deleted_at, now()), billing_status = 'canceled',
          renews_at = null, billing_settled_at = coalesce(billing_settled_at, now()),
          updated_at = now(), bootstrap_digest = null, sealed_bootstrap_token = null,
          bootstrap_expires_at = null, setup_code_digest = null, sealed_setup_code = null,
          sealed_oidc_client_secret = null, sealed_host_credential = null
        where work_assignment_id is not null and state <> 'deleted';
        update public.cloud_computers set billing_settled_at = coalesce(billing_settled_at, now())
        where work_assignment_id is not null;
      end if;
    end $remove$;
    alter table public.cloud_computers drop constraint if exists cloud_computer_work_billing;
    alter table public.cloud_computers drop column if exists work_assignment_id;
    drop table if exists public.work_audit_batches, public.work_audit_records,
      public.work_assignments, public.organization_seat_changes, public.organization_checkouts,
      public.organization_invitations, public.organization_members, public.organizations;
    alter table public.cloud_computer_backup_targets
      drop column if exists organization_reservation_request_id,
      drop column if exists reserved_organization_id;
  `.execute(database);
}

/** Both, by name: the first applies nothing, the second contracts. */
export const onePersonAccountMigrations: Readonly<Record<string, Migration>> = {
  [organizationsMigrationName]: { async up() {} },
  [removeOrganizationsMigrationName]: { up: removeOrganizations },
};
