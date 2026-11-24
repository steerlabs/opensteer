import { sql, type Kysely } from "kysely";

/**
 * Pool bookkeeping lives only in these tables. Ordinary rows are referenced by id without a
 * constraint, so an ordinary Home's writes never check them; pool code cleans them up.
 */
export const browserPoolMigrationName = "0106_browser_pool";

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
      settled_at timestamptz,
      restart_keys jsonb,
      installed_at timestamptz
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
    create table browser_pool_targets (
      cloud_computer_id text primary key,
      attempt_keys jsonb,
      attempt_issued_at timestamptz,
      registered_keys jsonb,
      status text not null default 'unregistered'
        check (status in ('unregistered', 'preparing', 'ready', 'failed')),
      target jsonb,
      updated_at timestamptz not null default now()
    )
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

/**
 * W1: a pooled session belongs to its target. Each pooled session is bound, when it is created, to
 * the slot and term it was admitted under; pool code reads and closes only its own target's
 * sessions. A replaced target is kept (W8) for as long as a Stop it held waits for its word. Pool bookkeeping, like the rest: no ordinary row changes. Expand-only: a pooled
 * session already open is bound to the slot its runner has now.
 */
export const browserPoolSessionsMigrationName = "0116_browser_pool_sessions";

export async function applyBrowserPoolSessions(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table browser_pool_sessions (
      session_id text primary key,
      runner_id text not null,
      slot_id text not null,
      term integer not null check (term > 0),
      dismissed_at timestamptz
    )
  `.execute(database);
  await sql`
    create index browser_pool_sessions_target on browser_pool_sessions (runner_id, slot_id, term)
  `.execute(database);
  // A target replaced while Stops it held were not yet ended: what the Home needs to go on
  // asking it (its fence, and its target as the Home's account gave it) until each has its end.
  await sql`
    create table browser_pool_retired_targets (
      slot_id text not null,
      term integer not null check (term > 0),
      runner_id text not null,
      runtime_id text not null,
      instance_id uuid not null,
      epoch integer not null check (epoch > 0),
      target jsonb not null,
      retired_at timestamptz not null default now(),
      primary key (slot_id, term)
    )
  `.execute(database);
  await sql`
    insert into browser_pool_sessions (session_id, runner_id, slot_id, term)
    select session.id, session.runner_id, slot.slot_id, slot.term
      from browser_sessions session
      join browser_pool_slots slot
        on slot.runner_id = session.runner_id and slot.runtime_id = session.runtime_id
     where session.state in ('starting', 'ready', 'closing')
  `.execute(database);
}
