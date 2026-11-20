import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const agentGrantsMigrationName = "0042_agent_grants";

/**
 * Connections carry one grant; everything that can execute later carries its connection. Existing
 * connections keep exactly what they could already do (`everything` at consent version 1). Lineage
 * applies to work created from now on: existing tasks, Runs and automations stay the person's. The
 * only backfill is a queued input whose own immutable source names a connection, and a Run still
 * queued from such an input, which takes its seed's connection.
 */
export async function applyAgentGrants(database: Kysely<DatabaseSchema>) {
  await sql`
    alter table agent_connections
      add column "grant" jsonb not null default '{"scope":"everything"}'::jsonb,
      add column grant_revision integer not null default 1 check (grant_revision >= 1),
      add column consent_version integer not null default 1 check (consent_version >= 1),
      add column client_fingerprint text,
      add column redirect_uri text,
      add column last_action_uncertain_at timestamptz,
      add column last_action_uncertain jsonb,
      add column acknowledged_uncertainty_at timestamptz,
      add column cleanup_reason text check (cleanup_reason in ('revoked', 'expired', 'narrowed')),
      add column cleanup_requested_at timestamptz,
      add column cleanup_minimum_grant_revision integer check (cleanup_minimum_grant_revision >= 1),
      add column cleanup_maximum_mode text,
      add column cleanup_completed_at timestamptz,
      add column cleanup_claim_token uuid,
      add column cleanup_claim_expires_at timestamptz,
      add column removed_at timestamptz,
      add constraint agent_connections_cleanup check (
        (cleanup_reason is null) = (cleanup_requested_at is null)
        and (cleanup_completed_at is null or cleanup_requested_at is not null)
        and ((cleanup_claim_token is null) = (cleanup_claim_expires_at is null))
        and (removed_at is null or cleanup_completed_at is not null));
    create index agent_connections_token_hash on agent_connections(token_hash)
      where token_hash is not null;
    create index agent_connections_cleanup_open on agent_connections(cleanup_requested_at)
      where cleanup_requested_at is not null and cleanup_completed_at is null;
    alter table threads add column origin_connection_id text;
    alter table runs
      add column connection_id text,
      add column admitted_grant_revision integer,
      add column admitted_access_mode text;
    alter table run_attempts
      add column connection_id text,
      add column admitted_grant_revision integer,
      add column admitted_access_mode text,
      add column terminal_evidence_at timestamptz,
      add column contact_lost_at timestamptz;
    alter table trigger_occurrences
      add column connection_id text,
      add column admitted_grant_revision integer,
      add column admitted_access_mode text,
      add column terminal_evidence_at timestamptz,
      add column contact_lost_at timestamptz;
    alter table trigger_watch_activations
      add column connection_id text,
      add column admitted_grant_revision integer,
      add column admitted_access_mode text,
      add column terminal_evidence_at timestamptz,
      add column contact_lost_at timestamptz;
    alter table plugin_executions
      add column connection_id text,
      add column admitted_grant_revision integer,
      add column admitted_access_mode text,
      add column terminal_evidence_at timestamptz,
      add column contact_lost_at timestamptz;
    create index plugin_executions_connection on plugin_executions(connection_id)
      where connection_id is not null;
    alter table browser_sessions add column standard_cdp_attempts jsonb not null default '{}';
    create index browser_sessions_standard_cdp_attempts on browser_sessions(id)
      where standard_cdp_attempts <> '{}';
    alter table thread_inputs add column connection_id text;
    alter table triggers add column origin_connection_id text;
    create or replace view thread_work_inputs as
      select * from thread_inputs where policy in ('queue','steer');
    create index threads_origin_connection on threads(origin_connection_id)
      where origin_connection_id is not null;
    create index runs_connection on runs(connection_id) where connection_id is not null;
    create index run_attempts_connection on run_attempts(connection_id)
      where connection_id is not null;
    create index trigger_occurrences_connection on trigger_occurrences(connection_id)
      where connection_id is not null;
    create index trigger_watch_activations_connection on trigger_watch_activations(connection_id)
      where connection_id is not null;
    create index thread_inputs_connection on thread_inputs(connection_id)
      where connection_id is not null;
    create index triggers_origin_connection on triggers(origin_connection_id)
      where origin_connection_id is not null;
    update thread_inputs set connection_id = authority_source->>'connectionId'
      where state in ('pending', 'awaiting-approval')
        and authority_source->>'kind' = 'connection'
        and authority_source->>'connectionId' in (select id from agent_connections);
    update runs set connection_id = thread_inputs.connection_id
      from thread_inputs
      where runs.status = 'queued' and runs.connection_id is null
        and thread_inputs.message_id = runs.seed_input_id
        and thread_inputs.connection_id is not null;
  `.execute(database);
}
