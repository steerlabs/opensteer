import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export const agentGrantsMigrationName = "0042_agent_grants";

/**
 * Connections carry one grant; everything that can execute later carries its connection. Existing
 * connections keep exactly what they could already do (`everything` at consent version 1), and
 * only lineage the rows prove is backfilled: inputs a connection sent, Runs those inputs
 * activated, and tasks whose first input came from one.
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
      add column removed_at timestamptz;
    create index agent_connections_token_hash on agent_connections(token_hash)
      where token_hash is not null;
    alter table threads add column origin_connection_id text;
    alter table runs add column connection_id text;
    alter table thread_inputs add column connection_id text;
    alter table triggers add column origin_connection_id text;
    create index threads_origin_connection on threads(origin_connection_id)
      where origin_connection_id is not null;
    create index runs_connection on runs(connection_id) where connection_id is not null;
    create index thread_inputs_connection on thread_inputs(connection_id)
      where connection_id is not null;
    create index triggers_origin_connection on triggers(origin_connection_id)
      where origin_connection_id is not null;
    update thread_inputs set connection_id = authority_source->>'connectionId'
      where authority_source->>'kind' = 'connection'
        and authority_source->>'connectionId' in (select id from agent_connections);
    update threads set origin_connection_id = first_input.connection_id
      from (
        select distinct on (thread_id) thread_id, connection_id
        from thread_inputs
        order by thread_id, queue_rank asc, message_id asc
      ) first_input
      where first_input.thread_id = threads.id and first_input.connection_id is not null;
    update runs set connection_id = coalesce(threads.origin_connection_id, thread_inputs.connection_id)
      from threads, thread_inputs
      where threads.id = runs.thread_id
        and thread_inputs.message_id = runs.activation_input_id
        and coalesce(threads.origin_connection_id, thread_inputs.connection_id) is not null;
  `.execute(database);
}
