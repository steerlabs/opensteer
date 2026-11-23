import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The organizations migration as it was before organizations were removed: a database at that shape. */
export const organizationsMigrationBeforeRemoval: Migration = {
  async up(database) {
    await sql`
      create table public.organizations (
        id text primary key,
        name text not null,
        stripe_customer_id text not null,
        stripe_subscription_id text not null unique,
        stripe_price_id text not null,
        billing_currency text not null,
        billing_status text not null,
        paid_seats integer not null check (paid_seats >= 0),
        billing_refreshed_at timestamptz,
        closing_at timestamptz,
        closed_at timestamptz,
        pending_seats integer,
        pending_seat_request_id uuid,
        pending_seat_since timestamptz,
        policy jsonb not null,
        policy_revision integer not null default 1,
        created_at timestamptz not null default now()
      );
      create table public.organization_members (
        organization_id text not null references public.organizations(id),
        account_id text not null references public.users(id) on delete cascade,
        role text not null check (role in ('admin', 'member')),
        created_at timestamptz not null default now(),
        primary key (organization_id, account_id)
      );
      create index organization_members_account on public.organization_members(account_id);
      create table public.organization_invitations (
        id text primary key,
        organization_id text not null references public.organizations(id),
        email text not null,
        role text not null check (role in ('admin', 'member')),
        created_at timestamptz not null default now(),
        accepted_at timestamptz
      );
      create unique index organization_invitation_open on public.organization_invitations(organization_id,email)
        where accepted_at is null;
      create table public.organization_checkouts (
        organization_id text not null,
        previous_subscription_id text,
        close_requested_at timestamptz,
        return_url text,
        founder_account_id text references public.users(id) on delete set null,
        request_id uuid not null,
        name text not null,
        seats integer not null check (seats between 1 and 1000),
        stripe_price_id text not null,
        currency text not null,
        created_at timestamptz not null default now(),
        session_id text unique,
        url text,
        sent_at timestamptz,
        expires_at timestamptz not null,
        paid_at timestamptz,
        status text not null check (status in ('open','completed','expired','refunded')),
        unique (founder_account_id, request_id),
        primary key (organization_id, request_id)
      );
      create unique index organization_checkout_open on public.organization_checkouts(organization_id)
        where status = 'open';
      create table public.organization_seat_changes (
        organization_id text not null references public.organizations(id),
        request_id uuid not null,
        subscription_id text not null,
        item_id text not null,
        previous_invoice_id text,
        quantity integer not null check (quantity between 1 and 1000),
        increase boolean not null,
        created_at timestamptz not null,
        invoice_id text,
        invoice_url text,
        expires_at timestamptz,
        abandon_requested_at timestamptz,
        status text not null check (status in ('pending','applied','abandoned','expired')),
        primary key (organization_id, request_id)
      );
      create table public.work_assignments (
        id text primary key,
        organization_id text not null references public.organizations(id),
        assignee_account_id text references public.users(id) on delete set null,
        cloud_computer_id text not null unique references public.cloud_computers(id) deferrable initially deferred,
        request_id uuid not null,
        state text not null check (state in ('active','offboarding','ended')),
        created_at timestamptz not null default now(),
        sign_in_cut_at timestamptz,
        flush_until timestamptz,
        final_audit text check (final_audit in ('confirmed','unconfirmed')),
        retain_until timestamptz,
        retention_seconds integer not null default 0 check (retention_seconds >= 0),
        offboarding_checked_at timestamptz,
        suspended_at timestamptz,
        ended_at timestamptz,
        applied_revision integer not null default 0,
        audit_sequence integer not null default 0,
        audit_head_hash text not null default repeat('0',64),
        audit_received_at timestamptz,
        audit_gap_received integer,
        audit_gap_expected integer,
        audit_gap_through integer,
        unique (organization_id, request_id)
      );
      create index work_assignment_account on public.work_assignments(assignee_account_id);
      create unique index work_assignment_live_assignee
        on public.work_assignments(organization_id,assignee_account_id) where state <> 'ended';
      alter table public.cloud_computers add column work_assignment_id text unique references public.work_assignments(id);
      alter table public.cloud_computers add constraint cloud_computer_work_billing check (
        work_assignment_id is null or (
          account_id is null and stripe_subscription_id = 'work:' || work_assignment_id
          and stripe_checkout_id = 'work:' || work_assignment_id
        )
      );
      create table public.work_audit_records (
        assignment_id text not null references public.work_assignments(id),
        sequence integer not null check (sequence > 0),
        canonical_record text not null,
        hash text not null,
        received_at timestamptz not null,
        primary key (assignment_id, sequence)
      );
      create table public.work_audit_batches (
        assignment_id text not null references public.work_assignments(id),
        from_sequence integer not null,
        last_sequence integer not null,
        head_hash text not null,
        signature text not null,
        primary key (assignment_id, from_sequence)
      )
    `.execute(database);
  },
};
