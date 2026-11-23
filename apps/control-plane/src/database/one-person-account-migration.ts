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
 * Drops organizations, seats, work assignments and their audit. It never destroys a computer or a
 * subscription it cannot settle: while any organization, organization checkout, work assignment
 * or organization-paid Cloud Computer exists, it refuses, names them, and changes nothing, so an
 * operator decides what becomes of them. No released account can hold one. On a database without
 * them, it drops empty tables and columns only.
 */
async function removeOrganizations(database: Parameters<Migration["up"]>[0]): Promise<void> {
  await sql`
    do $remove$ declare held text; begin
      if to_regclass('public.organizations') is not null then
        select string_agg(name, ', ') into held from (
          select 'organization ' || id as name from public.organizations
          union all select 'organization checkout ' || organization_id || '/' || request_id
            from public.organization_checkouts
          union all select 'work assignment ' || id || ' (Cloud Computer ' || cloud_computer_id || ')'
            from public.work_assignments
          union all select 'Cloud Computer ' || id from public.cloud_computers
            where work_assignment_id is not null
        ) rows;
        if held is not null then
          raise exception 'Organizations cannot be removed while these exist; an operator must decide what becomes of them first: %', held;
        end if;
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
