import { sql, type Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

/**
 * Expand-only browser pool schema (S1, T4, T8, T9, T10):
 * - Existing Cloud Computers default to `browser_mode = 'local'` with zero behavioral change.
 * - One durable `browser_pool_slots` row per pooled Cloud Computer via plain `UNIQUE(computer_id)`.
 * - No port columns on host or slot tables.
 * - `cloud_computer_provisioner_lease.pool_configured` lets Account warn when pooling is on
 *   without a pool-configured provisioner.
 */
export async function upBrowserPoolMigration(
  db: Kysely<ControlPlaneDatabaseSchema>,
): Promise<void> {
  await sql`
    alter table cloud_computers
      add column if not exists browser_mode text not null default 'local'
        check (browser_mode in ('local', 'pool')),
      add column if not exists browser_slot_erased_at timestamptz
  `.execute(db);

  await sql`
    alter table cloud_computer_provisioner_lease
      add column if not exists pool_configured boolean
  `.execute(db);

  await sql`
    create table if not exists browser_pool_hosts (
      id text primary key,
      generation integer not null default 1 check (generation >= 1),
      revision integer not null default 1 check (revision >= 1),
      state text not null check (state in ('active', 'draining', 'deleted')),
      phase text not null check (phase in ('provisioning', 'booting', 'ready', 'deleting', 'deleted', 'failed')),
      machine_type text not null,
      slots_capacity integer not null check (slots_capacity >= 1),
      profile_disk_name text not null unique,
      profile_disk_size_gb integer not null check (profile_disk_size_gb >= 10),
      profile_disk_ref text,
      release jsonb not null,
      provider_server_ref text,
      previous_provider_server_ref text,
      internal_ip text,
      bootstrap_digest text,
      sealed_bootstrap_token text,
      bootstrap_expires_at timestamptz,
      completed_boot_digest text,
      enrolled_at timestamptz,
      ever_enrolled boolean not null default false,
      auto_replace_count integer not null default 0 check (auto_replace_count >= 0),
      host_public_key text,
      relay_public_key text,
      pending_provider_writes jsonb not null default '[]'::jsonb,
      readiness_started_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      tombstoned_at timestamptz
    )
  `.execute(db);

  await sql`
    create or replace function browser_pool_hosts_bump_revision()
    returns trigger
    language plpgsql
    as $$
    begin
      if (
        new.generation is distinct from old.generation
        or new.state is distinct from old.state
        or new.machine_type is distinct from old.machine_type
        or new.slots_capacity is distinct from old.slots_capacity
        or new.release is distinct from old.release
        or new.bootstrap_digest is distinct from old.bootstrap_digest
        or new.enrolled_at is distinct from old.enrolled_at
      ) then
        new.revision := old.revision + 1;
      end if;
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    drop trigger if exists browser_pool_hosts_bump_revision_trigger on browser_pool_hosts
  `.execute(db);
  await sql`
    create trigger browser_pool_hosts_bump_revision_trigger
      before update on browser_pool_hosts
      for each row
      execute function browser_pool_hosts_bump_revision()
  `.execute(db);

  await sql`
    create index if not exists browser_pool_hosts_active_idx
      on browser_pool_hosts (id)
      where tombstoned_at is null
  `.execute(db);

  await sql`
    create table if not exists browser_pool_slots (
      slot_id text primary key,
      computer_id text not null unique references cloud_computers(id) on delete restrict,
      host_id text references browser_pool_hosts(id) on delete restrict,
      term integer not null default 1 check (term >= 1),
      applied_term integer check (applied_term is null or applied_term >= 1),
      applied_host_generation integer check (applied_host_generation is null or applied_host_generation >= 1),
      revision integer not null default 1 check (revision >= 1),
      state text not null check (state in ('active', 'deleting', 'deleted')),
      phase text not null check (phase in ('preparing', 'ready', 'deleting', 'deleted', 'failed')),
      home_key text,
      relay_key text,
      ticket_key_id text,
      ticket_key_spki text,
      keys_registered_at timestamptz,
      keys_issued_at timestamptz,
      control_key text,
      guest_vcpus integer not null check (guest_vcpus >= 1),
      guest_memory_mib integer not null check (guest_memory_mib >= 256),
      profile_mib integer not null check (profile_mib >= 64),
      pending_agent_writes jsonb not null default '[]'::jsonb,
      slot_erased_at timestamptz,
      profile_erased_at timestamptz,
      credentials_erased_at timestamptz,
      failed_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      tombstoned_at timestamptz
    )
  `.execute(db);

  await sql`
    alter table browser_pool_slots
      add column if not exists failed_at timestamptz
  `.execute(db);

  await sql`
    create or replace function browser_pool_slots_bump_revision()
    returns trigger
    language plpgsql
    as $$
    begin
      if (
        new.host_id is distinct from old.host_id
        or new.term is distinct from old.term
        or new.state is distinct from old.state
        or new.home_key is distinct from old.home_key
        or new.relay_key is distinct from old.relay_key
        or new.ticket_key_id is distinct from old.ticket_key_id
        or new.ticket_key_spki is distinct from old.ticket_key_spki
        or new.guest_vcpus is distinct from old.guest_vcpus
        or new.guest_memory_mib is distinct from old.guest_memory_mib
        or new.profile_mib is distinct from old.profile_mib
      ) then
        new.revision := old.revision + 1;
      end if;
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    drop trigger if exists browser_pool_slots_bump_revision_trigger on browser_pool_slots
  `.execute(db);
  await sql`
    create trigger browser_pool_slots_bump_revision_trigger
      before update on browser_pool_slots
      for each row
      execute function browser_pool_slots_bump_revision()
  `.execute(db);

  await sql`
    create index if not exists browser_pool_slots_host_live_idx
      on browser_pool_slots (host_id, slot_id)
      where tombstoned_at is null
  `.execute(db);
}

export const browserPoolMigration = {
  up: upBrowserPoolMigration,
};

/**
 * A Cloud Computer's browser runs in the browser pool, always. A row made before that, with
 * `browser_mode = 'local'`, moves forward and is never dropped: a live one gets its pool slot
 * from the account at its next reconciliation, at the size the account is configured with (a
 * migration cannot know it); one already deleted or being deleted had no slot and has none to
 * erase. Its VM keeps its old in-VM browser
 * until it is replaced, whose boot answer then says browserPool. The provisioner's lease also
 * keeps the network its pool hosts live in, which each Home's boot answer carries for its firewall.
 */
export async function upBrowserAlwaysPooledMigration(
  db: Kysely<ControlPlaneDatabaseSchema>,
): Promise<void> {
  // One live slot per Cloud Computer, not one ever: a Home a fresh one replaces has its slot
  // erased, and the fresh Home gets its own once that one is tombstoned.
  await sql`
    alter table browser_pool_slots drop constraint if exists browser_pool_slots_computer_id_key
  `.execute(db);
  await sql`
    create unique index if not exists browser_pool_slots_one_live_per_computer
      on browser_pool_slots (computer_id) where tombstoned_at is null
  `.execute(db);
  await sql`
    update cloud_computers
      set browser_slot_erased_at = coalesce(browser_slot_erased_at, now())
      where browser_mode = 'local'
        and (state = 'deleted' or deletion_requested_at is not null or tombstoned_at is not null)
        and not exists (select 1 from browser_pool_slots where computer_id = cloud_computers.id)
  `.execute(db);
  await sql`update cloud_computers set browser_mode = 'pool' where browser_mode = 'local'`.execute(
    db,
  );
  await sql`
    alter table cloud_computers
      alter column browser_mode set default 'pool',
      drop constraint cloud_computers_browser_mode_check,
      add constraint cloud_computers_browser_mode_check check (browser_mode = 'pool')
  `.execute(db);
  // The provisioner no longer reports whether it has a pool key: it cannot start without one.
  await sql`
    alter table cloud_computer_provisioner_lease drop column if exists pool_configured
  `.execute(db);
  await sql`
    alter table cloud_computer_provisioner_lease
      add column if not exists pool_network cidr
        constraint cloud_computer_provisioner_lease_pool_network_check check (
          pool_network <<= '10.0.0.0/8'
          or pool_network <<= '172.16.0.0/12'
          or pool_network <<= '192.168.0.0/16'
        )
  `.execute(db);
}

export const browserAlwaysPooledMigration = {
  up: upBrowserAlwaysPooledMigration,
};
