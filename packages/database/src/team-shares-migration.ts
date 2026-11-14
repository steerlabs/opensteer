import { sql, type Kysely } from "kysely";

export async function migrateTeamChannelShares(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table team_messages add column public_id uuid not null default gen_random_uuid(),
      add column created_seq bigint not null default 0,
      add column owner_change_seq bigint;
    update team_messages m set created_seq=n.seq from
      (select id,row_number() over(partition by channel_id order by id) as seq from team_messages) n
      where n.id=m.id;
    create unique index team_messages_public_id on team_messages(channel_id,public_id);
    create function opensteer_team_message_ordinal() returns trigger language plpgsql as $$
    begin
      if new.created_seq=0 then
        select coalesce(max(created_seq),0)+1 into new.created_seq from team_messages where channel_id=new.channel_id;
      end if;
      return new;
    end $$;
    create trigger team_message_ordinal before insert on team_messages for each row execute function opensteer_team_message_ordinal();
    create unique index team_messages_creation_seq on team_messages(channel_id,created_seq);
    create table team_shares (
      id uuid primary key,
      channel_id text references team_channels(id),
      history_from_share_id uuid references team_shares(id),
      partner_link_id uuid not null references team_partner_links(id),
      role text not null check(role in ('owner','follower')),
      state text not null check(state in ('offered','active','ended')),
      generation integer not null default 1 check(generation>0),
      name text not null,
      people_only boolean not null,
      offered_by text references team_members(user_id),
      accepted_by text references team_members(user_id),
      local_approved boolean not null,
      cursor bigint not null default 0,
      creation_cursor bigint not null default 0,
      cursor_public_id text not null default '',
      ready boolean not null default false,
      sync_error text check(sync_error in ('update-required')),
      stored_rows integer not null default 0,
      stored_bytes bigint not null default 0,
      created_at timestamptz not null default now(),
      ended_at timestamptz
    );
    create unique index team_shares_live_channel on team_shares(channel_id)
      where state <> 'ended';
    create unique index team_shares_follower_channel on team_shares(channel_id) where role='follower';
    create table team_share_participants (
      share_id uuid not null references team_shares(id),
      principal_id text not null references team_principals(id),
      blocked boolean not null default false,
      handle text not null,
      level text not null check(level in ('read','post')),
      state text not null check(state in ('active','removed')),
      primary key(share_id,principal_id),
      unique(share_id,handle) deferrable initially deferred
    );
    create table team_share_relays (
      share_id uuid not null references team_shares(id),
      author_user_id text not null references team_members(user_id),
      author_kind text not null check(author_kind in ('human','agent')),
      agent_link_id text references team_links(id),
      personal_deployment_id text,
      caller_run_id text,
      client_message_id uuid not null,
      body_markdown text not null,
      thread_root_public_id uuid,
      public_id uuid,
      primary key(share_id,author_user_id,author_kind,client_message_id)
    );
  `.execute(database);
}
