import { sql, type Kysely } from "kysely";

export const bridgeConnectionsMigrationName = "0051_bridge_connections";

/**
 * A messaging bridge is a connection: one `agent_connections` row reached through a chat instead
 * of over MCP. It never holds a token, so the previous image (which requires one) reads it as a
 * connection with no authority. Everything a bridge needs beyond the row lives in new tables,
 * which the previous image never reads; the channel tables it does read are left as they are.
 */
export async function applyBridgeConnections(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table agent_connections
      add column bridge_account_id text references channel_accounts(id),
      add column bridge_conversation_id text,
      add column bridge_senders text check (bridge_senders in ('owner', 'anyone')),
      add column bridge_from_binding_id text,
      add column bridge_notice text check (bridge_notice in ('converted', 'converted-without-channels')),
      add constraint agent_connections_bridge check (
        (bridge_account_id is null) = (bridge_senders is null)
        and (bridge_account_id is not null or (bridge_conversation_id is null
          and bridge_from_binding_id is null and bridge_notice is null))
        and (bridge_account_id is null or token_hash is null)
        and (bridge_account_id is null or "grant"->>'scope' = 'everything'
          or ("grant"->>'tasks')::boolean)
        -- Anyone in one named conversation, never in direct messages, and only tasks and plugins.
        and (bridge_senders is distinct from 'anyone' or (bridge_conversation_id is not null
          and "grant"->>'scope' = 'selected'
          and not jsonb_path_exists("grant", '$.resources[*] ? (@.kind != "plugin")'))));
    create unique index agent_connections_bridge_cover
      on agent_connections(bridge_account_id, coalesce(bridge_conversation_id, ''))
      where bridge_account_id is not null and revoked_at is null;
    create unique index agent_connections_bridge_conversion
      on agent_connections(bridge_from_binding_id, coalesce(bridge_conversation_id, ''))
      where bridge_from_binding_id is not null;

    create table bridge_conversations (
      id text primary key,
      bridge_id text not null references agent_connections(id),
      account_id text not null references channel_accounts(id),
      external_scope_id text,
      external_conversation_id text not null,
      external_thread_id text,
      conversation_type text not null check (conversation_type in ('dm', 'group', 'channel')),
      display_name text,
      thread_id text references threads(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index bridge_conversations_external on bridge_conversations
      (bridge_id, external_scope_id, external_conversation_id, external_thread_id) nulls not distinct;
    create index bridge_conversations_task on bridge_conversations(thread_id)
      where thread_id is not null;

    create table bridge_deliveries (
      id text primary key,
      bridge_id text not null references agent_connections(id),
      account_id text not null references channel_accounts(id),
      conversation_id text not null references bridge_conversations(id),
      message_id text references messages(id),
      kind text not null check (kind in ('reply', 'status')),
      part integer not null default 0,
      part_count integer not null default 1,
      content jsonb not null,
      status text not null check (status in ('pending', 'leased', 'attempt-started', 'sent',
        'retryable-failed', 'unknown', 'dead', 'cancelled')),
      attempts integer not null default 0,
      claim_token_hash text,
      claim_owner text,
      claim_expires_at timestamptz,
      next_attempt_at timestamptz not null default now(),
      last_error text,
      receipt jsonb,
      sent_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index bridge_deliveries_reply on bridge_deliveries(message_id, part)
      where kind = 'reply' and message_id is not null;
    create index bridge_deliveries_claimable on bridge_deliveries(conversation_id, created_at, part)
      where status in ('pending', 'leased', 'attempt-started', 'retryable-failed');
    create index bridge_deliveries_open on bridge_deliveries(bridge_id)
      where status in ('pending', 'leased', 'attempt-started', 'retryable-failed', 'unknown');
    create index bridge_deliveries_retention on bridge_deliveries(updated_at)
      where status in ('sent', 'dead', 'cancelled');

    create table bridge_link_codes (
      id text primary key,
      account_id text not null references channel_accounts(id),
      user_id text not null references users(id),
      code_hash text not null unique,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      identity_id text references channel_identities(id),
      created_at timestamptz not null default now()
    );
    create index bridge_link_codes_account on bridge_link_codes(account_id, expires_at)
      where consumed_at is null;
  `.execute(database);
}
