import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const agentSessionsMigrationName = "0043_agent_sessions";

/**
 * An external agent's direct work: a session anchored one-to-one to a listed task whose worker is
 * that agent, the durable receipt of every mediated operation, and Requests that originate from a
 * session. A session task keeps the ordinary placement columns: it is placed on the hosting
 * environment with a reserved, disabled engine (see `agent-session-store.ts`), so every thread
 * still has a placement and no native path can start a Run for it. The engine sign-in profile is
 * marked so no grant can name it, and a connection keeps who the person was shown at consent.
 */
export async function applyAgentSessions(database: Kysely<DatabaseSchema>) {
  await sql`
    alter table threads add column worker text not null default 'native'
      check (worker in ('native', 'external'));
    alter table threads add constraint threads_external_worker_lineage
      check (worker = 'native' or origin_connection_id is not null);
    create table agent_sessions (
      id text primary key,
      connection_id text not null references agent_connections(id),
      user_id text not null references users(id),
      thread_id text not null unique references threads(id),
      status text not null check (status in ('active', 'ended')),
      started_at timestamptz not null default now(),
      last_active_at timestamptz not null default now(),
      ended_at timestamptz,
      end_reason text check (end_reason in ('stopped', 'revoked', 'expired', 'narrowed', 'idle')),
      stop_notice_delivered_at timestamptz,
      check ((status = 'ended') = (ended_at is not null and end_reason is not null))
    );
    create unique index agent_sessions_one_active on agent_sessions(connection_id)
      where status = 'active';
    create index agent_sessions_connection on agent_sessions(connection_id, started_at desc, id desc);
    create index agent_sessions_active_idle on agent_sessions(last_active_at) where status = 'active';
    create table agent_operations (
      id text primary key,
      session_id text not null references agent_sessions(id),
      connection_id text not null references agent_connections(id),
      user_id text not null references users(id),
      operation_key text not null,
      tool text not null,
      argument_digest text not null,
      target jsonb not null,
      target_generation text,
      grant_revision integer not null,
      mode text not null,
      effect text not null check (effect in ('read', 'write')),
      state text not null check (state in
        ('admitted', 'pending', 'approved', 'refused', 'handed-off', 'completed', 'failed', 'unknown')),
      decision jsonb,
      request_id text unique references requests(id),
      calls text not null,
      agent_reason text,
      handed_off_at timestamptz,
      completed_at timestamptz,
      terminal_evidence_at timestamptz,
      contact_lost_at timestamptz,
      outcome text check (outcome in ('completed', 'failed', 'refused', 'unknown')),
      result_summary jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (session_id, operation_key),
      check ((outcome is null) = (completed_at is null))
    );
    create index agent_operations_connection on agent_operations(connection_id, created_at desc, id desc);
    create index agent_operations_unsettled on agent_operations(connection_id) where outcome is null;
    alter table requests add column originating_agent_session_id text references agent_sessions(id);
    alter table requests add column agent_operation jsonb;
    alter table requests drop constraint requests_origin_check;
    alter table requests add constraint requests_origin_check check (
      num_nonnulls(originating_run_id, originating_occurrence_id, originating_watch_activation_id,
        originating_agent_session_id) = 1
      and (mode <> 'live' or originating_run_id is not null)
    );
    create unique index requests_agent_session_call_identity on requests(originating_agent_session_id, call_id)
      where originating_agent_session_id is not null;
    create unique index harness_instances_external_agent on harness_instances(environment_id)
      where driver_kind = 'external-agent';
    alter table browser_profiles add column purpose text not null default 'person'
      check (purpose in ('person', 'engine-sign-in'));
    alter table agent_connections add column identity_at_consent jsonb;
    alter table plugin_executions add column agent_session_id text references agent_sessions(id);
    alter table plugin_executions drop constraint plugin_executions_check;
    alter table plugin_executions add constraint plugin_executions_origin_check
      check (num_nonnulls(run_id, occurrence_id, watch_activation_id, agent_session_id) = 1);
  `.execute(database);
}
