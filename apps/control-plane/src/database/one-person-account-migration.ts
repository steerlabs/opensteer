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
 * subscription it cannot settle: while any organization, organization checkout, work assignment,
 * or unresolved Cloud Computer (with a work assignment, any `work:` placeholder Stripe id, or
 * alive with no owning account) exists, it refuses, names each blocking row, and changes nothing,
 * so an operator decides what becomes of them. No released account can hold one. On a database
 * without them, it drops empty tables and columns only.
 */
async function removeOrganizations(database: Parameters<Migration["up"]>[0]): Promise<void> {
  await sql`
    do $remove$ declare held text; begin
      -- Hold the guarded tables before checking them so a rolling-deploy instance cannot write
      -- a new organization or work row between the guard check and the drops below.
      if to_regclass('public.cloud_computers') is not null then
        lock table public.cloud_computers in access exclusive mode;
      end if;
      if to_regclass('public.organizations') is not null then
        lock table public.organizations, public.organization_checkouts, public.work_assignments
          in access exclusive mode;
      end if;
      if to_regclass('public.organizations') is not null then
        select string_agg(name, ', ') into held from (
          select 'organization ' || id as name from public.organizations
          union all select 'organization checkout ' || organization_id || '/' || request_id
            from public.organization_checkouts
          union all select 'work assignment ' || id || ' (Cloud Computer ' || cloud_computer_id || ')'
            from public.work_assignments
          union all select 'Cloud Computer ' || id || ' (work_assignment_id ' || work_assignment_id || ')'
            from public.cloud_computers
            where work_assignment_id is not null
        ) rows;
      end if;
      if to_regclass('public.cloud_computers') is not null then
        select nullif(concat_ws(', ', held, string_agg(name, ', ')), '') into held from (
          select 'Cloud Computer ' || id || ' (placeholder ' || concat_ws(', ',
              case when stripe_subscription_id like 'work:%' then 'stripe_subscription_id' end,
              case when stripe_customer_id like 'work:%' then 'stripe_customer_id' end,
              case when stripe_checkout_id like 'work:%' then 'stripe_checkout_id' end,
              case when stripe_price_id like 'work:%' then 'stripe_price_id' end
            ) || ')' as name
            from public.cloud_computers
            where stripe_subscription_id like 'work:%'
              or stripe_customer_id like 'work:%'
              or stripe_checkout_id like 'work:%'
              or stripe_price_id like 'work:%'
          union all select 'Cloud Computer ' || id || ' (no owning account)'
            from public.cloud_computers
            where account_id is null
              and state <> 'deleted'
              and deletion_requested_at is null
              and tombstoned_at is null
        ) rows;
      end if;
      if held is not null then
        raise exception 'Organizations cannot be removed while these exist; an operator must decide what becomes of them first: %', held;
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
