import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const cloudComputerLifecycleMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.cloud_computers
        add column revision integer not null default 1,
        add column boot_completed_at timestamptz,
        add column completed_boot_digest text,
        add column ever_ready boolean not null default false,
        add column create_attempted boolean not null default false,
        add column previous_provider_server_id text,
        add column restore_snapshot text,
        add column ipv6_enabled boolean not null default false,
        add column deletion_requested_at timestamptz
    `.execute(database);
    await sql`
      update public.cloud_computers set ever_ready = true
      where deployment_id is not null or phase = 'ready' or bootstrap_receipt_at is not null
    `.execute(database);
    await sql`
      create function public.cloud_computer_advance_revision() returns trigger
      language plpgsql as $$
      begin
        if new.state is distinct from old.state or new.generation is distinct from old.generation
           or new.bootstrap_digest is distinct from old.bootstrap_digest
           or new.deletion_requested_at is distinct from old.deletion_requested_at
           or new.boot_completed_at is distinct from old.boot_completed_at
        then new.revision := old.revision + 1;
        end if;
        if old.account_id is not null and new.account_id is null and old.state <> 'deleted' then
          new.deletion_requested_at := coalesce(old.deletion_requested_at, now());
          new.state := 'suspended';
          new.phase := 'suspended';
          new.deleted_at := old.deleted_at;
          new.revision := old.revision + 1;
        end if;
        return new;
      end
      $$
    `.execute(database);
    await sql`
      create trigger zz_cloud_computer_revision
      before update on public.cloud_computers for each row
      execute function public.cloud_computer_advance_revision()
    `.execute(database);
    await sql`
      create table public.cloud_computer_provisioner_lease (
        singleton boolean primary key check (singleton),
        holder uuid not null,
        expires_at timestamptz not null
      )
    `.execute(database);
    await sql`
      alter table public.cloud_computer_egress_endpoints
        add column needs_rotation boolean not null default true
    `.execute(database);
    await sql`
      create table public.cloud_computer_backup_targets (
        id uuid primary key,
        endpoint text not null,
        bucket text not null,
        prefix text not null,
        sealed_credentials text not null,
        principal_fingerprint text not null unique,
        computer_id text unique references public.cloud_computers(id),
        checkout_key text unique,
        needs_rotation boolean not null default false,
        unique (endpoint, bucket, prefix),
        check (computer_id is null or checkout_key is null)
      )
    `.execute(database);
    await sql`
      alter table public.cloud_computer_checkouts
        add column created_at timestamptz not null default now(),
        add column last_stripe_attempt_at timestamptz,
        add column target_computer_id text
    `.execute(database);
    await sql`
      update public.cloud_computer_checkouts set created_at = expires_at - interval '2 hours'
    `.execute(database);
    await sql`
      alter table public.cloud_computer_stripe_events add column deferred_checkout jsonb
    `.execute(database);
    await sql`
      create function public.cloud_computer_keep_checkout_after_account_delete() returns trigger
      language plpgsql as $$
      begin
        insert into public.cloud_computer_stripe_events (id,type,received_at,deferred_checkout)
        values (
          'orphan_checkout:' || old.account_id || '/' || old.request_id,
          'account.checkout.orphaned', now(),
          jsonb_build_object('accountId', old.account_id, 'requestId', old.request_id,
            'sessionId', old.stripe_session_id, 'createdAt', old.created_at,
            'lastAttemptAt', coalesce(old.last_stripe_attempt_at, old.created_at))
        ) on conflict (id) do nothing;
        return old;
      end
      $$
    `.execute(database);
    await sql`
      create trigger cloud_computer_keep_checkout_after_account_delete
      before delete on public.cloud_computer_checkouts for each row
      when (old.status = 'open')
      execute function public.cloud_computer_keep_checkout_after_account_delete()
    `.execute(database);
  },
};
