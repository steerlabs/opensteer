import { sql, type Kysely } from "kysely";

/**
 * Pool bookkeeping lives only in these tables. Ordinary rows are referenced by id without a
 * constraint, so an ordinary Home's writes never check them; pool code cleans them up.
 */
export const browserPoolMigrationName = "0050_browser_pool";

/**
 * A restart's keys on its Start, and when the slot held that Start's guest (P1). A migration of
 * its own, expand-only: builds made from a branch that carried 0050 before these columns may
 * have run it.
 */
export const browserPoolCallKeysMigrationName = "0050_browser_pool_call_keys";

export async function applyBrowserPoolCallKeys(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table browser_pool_controller_calls
      add column if not exists restart_keys jsonb,
      add column if not exists installed_at timestamptz
  `.execute(database);
}

export async function applyBrowserPool(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table browser_pool_slots (
      runner_id text primary key,
      runtime_id text not null,
      slot_id text not null unique,
      term integer not null check (term > 0),
      instance_id uuid not null,
      epoch integer not null check (epoch > 0),
      intent_sequence integer not null check (intent_sequence >= 0),
      intent_id uuid,
      attachment_generation integer not null check (attachment_generation > 0),
      phase text not null check (phase in ('running', 'preparing', 'parked', 'waking', 'releasing')),
      retained jsonb,
      saved_state jsonb,
      outcome jsonb,
      phase_since timestamptz not null default now(),
      last_start jsonb,
      failed_starts integer not null default 0,
      restart_keys jsonb not null default '[]'::jsonb,
      restart_wanted jsonb not null default '[]'::jsonb
    )
  `.execute(database);
  await sql`
    create table browser_pool_controller_calls (
      id uuid primary key,
      runner_id text not null,
      slot_id text not null,
      term integer not null,
      intent_id uuid,
      kind text not null,
      request jsonb not null,
      result jsonb,
      created_at timestamptz not null default now(),
      settled_at timestamptz
    )
  `.execute(database);
  await sql`
    create index browser_pool_controller_calls_open
      on browser_pool_controller_calls (runner_id, created_at) where settled_at is null
  `.execute(database);
  await sql`
    create table browser_pool_document_losses (
      intent_id uuid not null,
      runner_id text not null,
      owner_id text not null,
      session_id text not null,
      surface_id text not null,
      document_id text,
      reason text not null,
      typed boolean,
      lost_at timestamptz not null default now(),
      noticed_at timestamptz,
      primary key (intent_id, surface_id)
    )
  `.execute(database);
  await sql`
    create index browser_pool_document_losses_owner_tab
      on browser_pool_document_losses (owner_id, surface_id) where noticed_at is null
  `.execute(database);
  await sql`
    create table browser_pool_relays (
      id uuid primary key,
      runner_id text not null,
      runtime_id text not null,
      slot_id text not null,
      term integer not null,
      instance_id uuid not null,
      epoch integer not null,
      created_at timestamptz not null default now()
    )
  `.execute(database);
}
