import { sql, type Kysely } from "kysely";

export const browserPoolMigrationName = "0050_browser_pool";

export async function applyBrowserPool(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table browser_pool_slots (
      runner_id text primary key,
      runtime_id text not null,
      slot_id text not null unique,
      term integer not null check (term > 0),
      instance_id uuid not null,
      epoch integer not null check (epoch > 0),
      intent_sequence integer not null check (intent_sequence > 0),
      intent_id uuid not null,
      phase text not null check (phase in ('running', 'preparing', 'parked', 'waking')),
      retained jsonb
    )
  `.execute(database);
}
