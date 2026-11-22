import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Browser pool hosts and slots for Opensteer Cloud Computers (S1).
 *
 * Expand-only: existing `cloud_computers` rows default to `browser_mode = 'local'` and
 * `browser_slot_erased_at = null`. `browser_pool_slots.computer_id` carries a plain unique
 * constraint so one Cloud Computer owns at most one browser slot for its entire life.
 * Pool host ports (7310/7311/7312) are configuration, never columns.
 */
export const browserPoolMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.cloud_computers
        add column browser_mode text not null default 'local'
          check (browser_mode in ('local', 'pool')),
        add column browser_slot_erased_at timestamptz
    `.execute(database);

    await sql`
      create table public.browser_pool_hosts (
        id text primary key,
        generation integer not null check (generation > 0),
        revision integer not null default 1 check (revision > 0),
        state text not null check (state in ('active', 'draining', 'deleted')),
        phase text not null check (
          phase in ('provisioning', 'booting', 'ready', 'deleting', 'deleted', 'failed')
        ),
        region text not null,
        machine_type text not null,
        slots_capacity integer not null check (slots_capacity > 0),
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
        host_public_key text,
        relay_public_key text,
        pending_provider_writes jsonb not null default '[]'::jsonb,
        readiness_started_at timestamptz not null,
        last_error text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        reported_at timestamptz,
        deleted_at timestamptz,
        tombstoned_at timestamptz
      )
    `.execute(database);

    await sql`
      create index browser_pool_hosts_live
      on public.browser_pool_hosts (id)
      where tombstoned_at is null
    `.execute(database);

    await sql`
      create function public.browser_pool_host_advance_revision() returns trigger
      language plpgsql as $$
      begin
        if new.state is distinct from old.state
           or new.generation is distinct from old.generation
           or new.bootstrap_digest is distinct from old.bootstrap_digest
           or new.enrolled_at is distinct from old.enrolled_at
           or new.tombstoned_at is distinct from old.tombstoned_at
        then new.revision := old.revision + 1;
        end if;
        return new;
      end
      $$
    `.execute(database);

    await sql`
      create trigger zz_browser_pool_host_revision
      before update on public.browser_pool_hosts for each row
      execute function public.browser_pool_host_advance_revision()
    `.execute(database);

    await sql`
      create table public.browser_pool_slots (
        slot_id text primary key,
        computer_id text not null unique references public.cloud_computers(id),
        host_id text references public.browser_pool_hosts(id),
        term integer not null check (term > 0),
        applied_term integer check (applied_term is null or applied_term > 0),
        applied_host_generation integer check (
          applied_host_generation is null or applied_host_generation > 0
        ),
        revision integer not null default 1 check (revision > 0),
        state text not null check (state in ('active', 'deleting', 'deleted')),
        phase text not null check (
          phase in (
            'waiting_keys', 'waiting_host', 'provisioning', 'ready',
            'updating_keys', 'deleting', 'deleted', 'failed'
          )
        ),
        home_key text,
        relay_key text,
        ticket_key_id text,
        ticket_key_spki text,
        keys_registered_at timestamptz,
        control_key text,
        guest_vcpus integer not null check (guest_vcpus > 0),
        guest_memory_mib integer not null check (guest_memory_mib >= 256),
        profile_mib integer not null check (profile_mib between 64 and 1048576),
        pending_agent_writes jsonb not null default '[]'::jsonb,
        deletion_requested_at timestamptz,
        slot_erased_at timestamptz,
        profile_erased_at timestamptz,
        credentials_erased_at timestamptz,
        last_error text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        deleted_at timestamptz,
        tombstoned_at timestamptz
      )
    `.execute(database);

    await sql`
      create index browser_pool_slots_host_live
      on public.browser_pool_slots (host_id)
      where tombstoned_at is null
    `.execute(database);

    await sql`
      create index browser_pool_slots_live
      on public.browser_pool_slots (slot_id)
      where tombstoned_at is null
    `.execute(database);

    await sql`
      create function public.browser_pool_slot_advance_revision() returns trigger
      language plpgsql as $$
      begin
        if new.state is distinct from old.state
           or new.host_id is distinct from old.host_id
           or new.term is distinct from old.term
           or new.home_key is distinct from old.home_key
           or new.relay_key is distinct from old.relay_key
           or new.ticket_key_id is distinct from old.ticket_key_id
           or new.ticket_key_spki is distinct from old.ticket_key_spki
           or new.tombstoned_at is distinct from old.tombstoned_at
        then new.revision := old.revision + 1;
        end if;
        return new;
      end
      $$
    `.execute(database);

    await sql`
      create trigger zz_browser_pool_slot_revision
      before update on public.browser_pool_slots for each row
      execute function public.browser_pool_slot_advance_revision()
    `.execute(database);
  },
};
