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
        add column generation_ready boolean not null default false,
        add column dns_quarantined boolean not null default false,
        add column create_attempted boolean not null default false,
        add column previous_provider_server_id text,
        add column restore_snapshot text,
        add column ipv6_enabled boolean not null default false,
        add column deletion_requested_at timestamptz,
        add column vm_destroyed_at timestamptz,
        add column backups_unreadable_at timestamptz,
        add column backup_objects_removed_at timestamptz,
        add column backup_cleanup_attempted_at timestamptz,
        add column owner_access_at timestamptz,
        add column pending_provider_writes jsonb not null default '[]'::jsonb
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
        add column needs_rotation boolean not null default true,
        add column retired boolean not null default false,
        add check (not retired or (needs_rotation and computer_id is null))
    `.execute(database);
    await sql`
      create table public.cloud_computer_backup_targets (
        id uuid primary key,
        endpoint text not null,
        bucket text not null,
        prefix text not null,
        region text not null default 'us-east-1',
        sealed_credentials text not null,
        principal_fingerprint text not null unique,
        computer_id text unique references public.cloud_computers(id),
        checkout_key text unique,
        purge_computer_id text references public.cloud_computers(id),
        needs_rotation boolean not null default false,
        unique (endpoint, bucket, prefix),
        check (computer_id is null or checkout_key is null),
        check (purge_computer_id is null or (computer_id is null and checkout_key is null and needs_rotation))
      )
    `.execute(database);
    await sql`
      create table public.cloud_computer_backup_namespaces (
        endpoint text not null,
        bucket text not null,
        prefix text not null,
        principal_fingerprint text not null unique,
        primary key (endpoint, bucket, prefix)
      )
    `.execute(database);
    await sql`
      alter table public.cloud_computer_checkouts
        add column created_at timestamptz not null default now(),
        add column last_stripe_attempt_at timestamptz,
        add column target_computer_id text,
        add column paid_at timestamptz,
        add column return_url text
    `.execute(database);
    await sql`
      alter table public.cloud_computer_stripe_events add column deferred_checkout jsonb
    `.execute(database);
  },
};
