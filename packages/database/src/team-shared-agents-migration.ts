import { sql, type Kysely } from "kysely";

export async function migrateTeamSharedAgents(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table team_shares add column agents_enabled boolean not null default true;
    alter table team_share_relays
      add column agent_targets jsonb not null default '[]',
      add column publication boolean not null default false,
      add column admitted boolean not null default false;
    update team_share_relays set admitted=true;
    alter table team_agent_requests add column share_id uuid references team_shares(id);
    create table team_share_asks (
      id text primary key,
      share_id uuid not null references team_shares(id),
      channel_id text not null references team_channels(id),
      trigger_message_id bigint not null references team_messages(id),
      thread_root_id bigint not null references team_messages(id),
      target_principal_id text not null references team_principals(id),
      target_agent_handle text not null,
      local_request_id text references team_agent_requests(id),
      status jsonb,
      outcome text check(outcome in ('answered','declined','expired','cancelled','failed')),
      reply_message_id bigint references team_messages(id),
      created_at timestamptz not null default now(),
      change_seq bigint not null,
      unique(share_id,trigger_message_id,target_principal_id)
    );
    create index team_share_asks_pending on team_share_asks(share_id,created_at) where outcome is null;
    create view team_request_statuses as
      select r.target_agent_handle,r.kind,r.presentation,r.return_payload,r.consent_expires_at,r.id,
        r.owner_user_id,r.channel_id,r.thread_root_id,r.trigger_message_id,r.link_id,r.state,r.steps,r.created_at,
        r.accepted_at,r.expires_at,r.finished_at,r.reply_message_id,r.failure_code,r.change_seq,r.share_id,
        false as pending_remote,null::text as ask_refusal from team_agent_requests r where r.kind<>'return'
      union all
      select a.target_agent_handle,'ask',null::jsonb,null::jsonb,
        (a.status->>'consentExpiresAt')::timestamptz,a.id,a.target_principal_id,a.channel_id,a.thread_root_id,
        a.trigger_message_id,null,coalesce(a.status->>'state','queued'),'[]'::jsonb,a.created_at,
        (a.status->>'acceptedAt')::timestamptz,(a.status->>'expiresAt')::timestamptz,
        (a.status->>'finishedAt')::timestamptz,a.reply_message_id,a.status->>'failureCode',a.change_seq,
        a.share_id,a.status is null,a.status->>'refusal' from team_share_asks a where a.local_request_id is null;
  `.execute(database);
}
