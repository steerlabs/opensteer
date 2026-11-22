import { sql } from "kysely";

export const cloudComputerGoogleServerRefMigration: Migration = {
  async up(db) {
    await sql`
      alter table cloud_computers
        add column provider_server_ref text,
        add column previous_provider_server_ref text
    `.execute(db);
  },
};
import type { Migration } from "kysely/migration";

/**
 * When the billing pass finished settling a deleted Cloud Computer with Stripe (its subscription
 * cancelled, its Stripe customer deleted), and when cancelling it first failed. Add-only: a
 * previous release never reads them. A computer deleted before this release was settled the way
 * that release did it, and is marked so the pass never revisits it.
 */
export const cloudComputerBillingSettledMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.cloud_computers
        add column billing_settled_at timestamptz,
        add column cancel_failed_at timestamptz
    `.execute(database);
    await sql`
      update public.cloud_computers set billing_settled_at = coalesce(deleted_at, now())
      where state = 'deleted'
    `.execute(database);
  },
};

export const cloudComputersMigration: Migration = {
  async up(database) {
    await sql`
      create table public.cloud_computer_checkouts (
        account_id text not null,
        request_id uuid not null,
        expires_at timestamptz not null,
        stripe_session_id text unique,
        url text,
        stripe_price_id text not null,
        currency text not null,
        status text not null check (status in ('open', 'completed', 'expired', 'refunded')),
        primary key (account_id, request_id)
      )
    `.execute(database);
    await sql`
      create unique index cloud_computer_one_open_checkout
      on public.cloud_computer_checkouts (account_id) where status = 'open'
    `.execute(database);
    await sql`
      create table public.cloud_computers (
        id text primary key,
        account_id text references public.users(id) on delete set null,
        generation integer not null check (generation > 0),
        state text not null check (state in ('active', 'suspended', 'deleted')),
        hostname text not null unique,
        region text not null,
        server_type text not null,
        release jsonb not null,
        setup_code_digest text,
        sealed_setup_code text,
        bootstrap_digest text,
        sealed_bootstrap_token text,
        bootstrap_expires_at timestamptz,
        backup_key_project text,
        backup_key_version integer,
        bootstrap_receipt jsonb,
        bootstrap_receipt_at timestamptz,
        readiness_started_at timestamptz not null,
        phase text not null check (phase in ('provisioning','booting','ready','suspended','deleting','deleted','failed')),
        provider_server_id text,
        ipv4 text,
        ipv6 text,
        deployment_id text,
        host_key_fingerprint text,
        last_error text,
        operator_suspension text,
        owner_suspended boolean not null default false,
        egress_unavailable boolean not null default false,
        stripe_checkout_id text not null unique,
        stripe_customer_id text not null,
        stripe_subscription_id text not null unique,
        stripe_price_id text not null,
        billing_currency text not null,
        billing_status text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        reported_at timestamptz,
        deleted_at timestamptz,
        tombstoned_at timestamptz
      )
    `.execute(database);
    await sql`
      create unique index cloud_computer_one_live_per_account on public.cloud_computers (account_id)
      where tombstoned_at is null
    `.execute(database);
    await sql`
      create index cloud_computers_owner on public.cloud_computers (account_id, created_at desc)
    `.execute(database);
    await sql`
      create table public.cloud_computer_egress_endpoints (
        id uuid primary key,
        url text not null,
        username text not null,
        sealed_password text not null,
        computer_id text unique references public.cloud_computers(id),
        unique (url)
      )
    `.execute(database);
    await sql`
      create table public.cloud_computer_stripe_events (
        id text primary key,
        type text not null,
        received_at timestamptz not null
      )
    `.execute(database);
    await sql`
      create function public.cloud_computer_orphan_tombstone() returns trigger
      language plpgsql as $$
      begin
        new.state := 'deleted';
        new.phase := 'deleting';
        new.setup_code_digest := null;
        new.sealed_setup_code := null;
        new.sealed_bootstrap_token := null;
        new.bootstrap_digest := null;
        new.bootstrap_expires_at := null;
        new.deleted_at := now();
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger cloud_computer_orphan_tombstone
      before update of account_id on public.cloud_computers for each row
      when (old.account_id is not null and new.account_id is null and new.state <> 'deleted')
      execute function public.cloud_computer_orphan_tombstone()
    `.execute(database);
  },
};

/**
 * The Account-bound claim of a ready Home: the OIDC client and link credential
 * the boot exchange hands it, and the claim's retry state. Add-only: the
 * previous release never reads these columns.
 */
export const cloudComputerClaimMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.cloud_computers
        add column oidc_client_id text unique,
        add column sealed_oidc_client_secret text,
        add column sealed_host_credential text,
        add column claim_attempt integer not null default 0 check (claim_attempt >= 0),
        add column claim_next_at timestamptz,
        add column claim_error text check (char_length(claim_error) between 1 and 1000)
    `.execute(database);
    await sql`
      create index cloud_computers_claim_due on public.cloud_computers (claim_next_at)
      where phase = 'ready' and bootstrap_receipt_at is null and claim_error is null
        and tombstoned_at is null
    `.execute(database);
    await sql`
      create or replace function public.cloud_computer_orphan_tombstone() returns trigger
      language plpgsql as $$
      begin
        new.state := 'deleted';
        new.phase := 'deleting';
        new.setup_code_digest := null;
        new.sealed_setup_code := null;
        new.sealed_bootstrap_token := null;
        new.bootstrap_digest := null;
        new.bootstrap_expires_at := null;
        new.sealed_oidc_client_secret := null;
        new.sealed_host_credential := null;
        new.deleted_at := now();
        return new;
      end
      $$
    `.execute(database);
  },
};

export const cloudComputerBackupReportMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.cloud_computers
        add column last_backup_at timestamptz,
        add column last_backup_snapshot_id text
    `.execute(database);
  },
};
