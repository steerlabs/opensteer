import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const agentGrantsMigrationName = "0100_agent_grants";

/**
 * Connections carry one grant; everything that can execute later carries its connection. Existing
 * connections keep exactly what they could already do (`everything` at consent version 1).
 *
 * What a connected agent wrote before the update keeps its writer: main stored it only in the
 * input's own authority source, and the lineage walk reads `thread_inputs.connection_id`. Every
 * input the walk counts (anything but one cancelled before it reached a Run) whose stored source
 * is a connection gets that connection when the connection is the task owner's and the source
 * names the owner; otherwise (the connection is gone, or is someone else's) it gets one ended,
 * hidden connection of the owner's, as 0109 does for chats, so the task is never the person's own
 * again and nothing is given to a connection it did not hold. Unfinished Runs seeded by such an
 * input, and their attempts, carry the same connection so Disconnect finds them. Tasks and
 * automations gain no origin: main recorded none, and their lineage reaches these inputs.
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
        and (removed_at is null or cleanup_requested_at is not null));
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
    create table trigger_occurrence_attempts (
      occurrence_id text not null references trigger_occurrences(id),
      execution_generation integer not null,
      connection_id text not null,
      runner_id text not null,
      runner_boot_id text not null,
      admitted_grant_revision integer,
      admitted_access_mode text,
      terminal_evidence_at timestamptz,
      contact_lost_at timestamptz,
      primary key (occurrence_id, execution_generation)
    );
    create index trigger_occurrence_attempts_connection on trigger_occurrence_attempts(connection_id);
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
      add column contact_lost_at timestamptz,
      add column engine_process jsonb,
      add column engine_unsent boolean;
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
    -- Who wrote each input the lineage walk counts, from what main stored with it.
    create temporary table legacy_connection_inputs on commit drop as
      select i.message_id, t.created_by as owner_id,
        case when c.user_id = t.created_by and i.requested_by = t.created_by
          and i.authority_source->>'userId' = t.created_by then c.id end as connection_id
      from thread_inputs i
      join threads t on t.id = i.thread_id
      left join agent_connections c on c.id = i.authority_source->>'connectionId'
      where i.authority_source->>'kind' = 'connection'
        and (i.state <> 'cancelled' or i.run_id is not null
          or i.steer_command_id is not null or i.delivered_at is not null);
    -- A writer that is gone, or not the owner's, is carried by one ended, hidden, supervised,
    -- tasks-only connection of the owner's. Its cleanup stays open, so the Home's ordinary
    -- Disconnect ends whatever of that work is still running.
    create temporary table legacy_connection_carriers on commit drop as
      select owner_id as user_id, 'mcn_' || gen_random_uuid() as id
      from (select distinct owner_id from legacy_connection_inputs where connection_id is null) owner;
    insert into agent_connections (
      id, user_id, label, client_name, access_mode, resource, token_hash, created_at,
      expires_at, revoked_at, removed_at, "grant", grant_revision, consent_version,
      cleanup_reason, cleanup_requested_at, cleanup_completed_at)
    select carrier.id, carrier.user_id, 'Connected agents from before the update', 'Connected agent',
      'approval-required', 'opensteer:before-update', null, now(), now(), now(), now(),
      '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(), null
    from legacy_connection_carriers carrier;
    update thread_inputs i set connection_id = coalesce(legacy.connection_id, carrier.id)
      from legacy_connection_inputs legacy
      left join legacy_connection_carriers carrier on carrier.user_id = legacy.owner_id
      where i.message_id = legacy.message_id;
    update runs set connection_id = thread_inputs.connection_id
      from thread_inputs
      where runs.status in ('queued', 'starting', 'running', 'waiting')
        and runs.connection_id is null
        and thread_inputs.message_id = runs.seed_input_id
        and thread_inputs.connection_id is not null;
    update run_attempts a set connection_id = r.connection_id
      from runs r
      where a.run_id = r.id and a.connection_id is null and a.terminal_evidence_at is null
        and r.status in ('queued', 'starting', 'running', 'waiting')
        and r.connection_id is not null;
    update plugin_executions p set connection_id = c.id,
      admitted_grant_revision = r.admitted_grant_revision,
      admitted_access_mode = coalesce(r.admitted_access_mode, r.access_mode)
      from runs r
      left join thread_inputs i on i.message_id = r.seed_input_id
      join agent_connections c on c.user_id = r.requested_by and c.id = coalesce(
        r.connection_id,
        case when r.authority_source->>'kind' = 'connection' then r.authority_source->>'connectionId' end,
        case when i.authority_source->>'kind' = 'connection' then i.authority_source->>'connectionId' end)
      where p.run_id = r.id and p.owner_user_id = c.user_id and p.connection_id is null;
  `.execute(database);
}
