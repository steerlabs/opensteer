/**
 * Several team Host processes may serve one team database. Durable changes notify every process
 * from triggers on the rows that record them, so a notification fires only at commit and no write
 * path can forget one. Payloads carry ids only; listeners re-read state from the database.
 */
export const teamCopiesMigrationName = "0025_team_copies";
export const teamBusChannel = "opensteer_team";

export const TEAM_COPIES_SQL = `
create table team_access_changes (
  revision bigint primary key,
  effects jsonb not null,
  created_at timestamptz not null default now()
);

create table team_presence (
  connection_id text primary key,
  process_id text not null,
  user_id text not null,
  visible boolean not null,
  channel_ids text[] not null default '{}',
  seen_at timestamptz not null
);
create index team_presence_user on team_presence(user_id);
create index team_presence_process on team_presence(process_id);

alter table team_links add column connection_epoch bigint not null default 0;
create table team_link_connections (
  link_id text not null references team_links(id) on delete cascade,
  epoch bigint not null,
  process_id text not null,
  seen_at timestamptz not null,
  primary key (link_id, epoch)
);
create index team_link_connections_process on team_link_connections(process_id);

alter table team_partner_links add column sealed_offer bytea;
create table team_partner_calls (
  id uuid primary key,
  link_id uuid not null references team_partner_links(id) on delete cascade,
  operation jsonb not null,
  state text not null check (state in ('queued', 'claimed', 'done', 'failed')),
  claimed_by text,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((state = 'queued') = (claimed_by is null))
);
create index team_partner_calls_queued on team_partner_calls(link_id, created_at) where state = 'queued';
create index team_partner_calls_created on team_partner_calls(created_at);

create table team_installation (
  singleton_key text primary key check (singleton_key = 'team'),
  sealed_account_bundle bytea not null,
  updated_at timestamptz not null default now()
);

alter table team_blobs
  add column generation bigint,
  add column preview_generation bigint,
  add column upload_lease text,
  add column upload_lease_expires_at timestamptz,
  add constraint team_blobs_upload_lease check ((upload_lease is null) = (upload_lease_expires_at is null));

create function team_bus_notify(payload jsonb) returns void language sql as $$
  select pg_notify('${teamBusChannel}', payload::text)
$$;

create function team_bus_channel() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'channel', 'channelId', new.id));
  return null;
end $$;
create trigger team_bus_channel_insert after insert on team_channels
  for each row execute function team_bus_channel();
create trigger team_bus_channel_update after update of change_seq, archived_at on team_channels
  for each row when (new.change_seq is distinct from old.change_seq or new.archived_at is distinct from old.archived_at)
  execute function team_bus_channel();

create function team_bus_access() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'access', 'revision', new.revision::text));
  return null;
end $$;
create trigger team_bus_access after insert on team_access_changes
  for each row execute function team_bus_access();

create function team_bus_request() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'request', 'linkId', new.link_id));
  return null;
end $$;
create trigger team_bus_request_insert after insert on team_agent_requests
  for each row execute function team_bus_request();
create trigger team_bus_request_update after update of change_seq, state on team_agent_requests
  for each row when (new.change_seq is distinct from old.change_seq or new.state is distinct from old.state)
  execute function team_bus_request();

create function team_bus_member() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'member', 'userId', new.id));
  return null;
end $$;
create trigger team_bus_member after update of display_name, image, name_revision on users
  for each row when (new.display_name is distinct from old.display_name or new.image is distinct from old.image
    or new.name_revision is distinct from old.name_revision)
  execute function team_bus_member();

create function team_bus_link() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'link', 'linkId', new.id, 'epoch', new.connection_epoch::text));
  return null;
end $$;
create trigger team_bus_link after update of connection_epoch on team_links
  for each row when (new.connection_epoch is distinct from old.connection_epoch)
  execute function team_bus_link();

create function team_bus_link_presence() returns trigger language plpgsql as $$
declare
  owner text;
begin
  select owner_user_id into owner from team_links where id = coalesce(new.link_id, old.link_id);
  if owner is not null then
    perform team_bus_notify(jsonb_build_object('kind', 'linkPresence', 'userId', owner));
  end if;
  return null;
end $$;
create trigger team_bus_link_presence after insert or delete on team_link_connections
  for each row execute function team_bus_link_presence();

create function team_bus_presence() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'presence', 'userId', coalesce(new.user_id, old.user_id)));
  return null;
end $$;
create trigger team_bus_presence_change after insert or delete on team_presence
  for each row execute function team_bus_presence();
create trigger team_bus_presence_update after update of visible, channel_ids on team_presence
  for each row when (new.visible is distinct from old.visible or new.channel_ids is distinct from old.channel_ids)
  execute function team_bus_presence();

create function team_bus_partner_link() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'partnerLink', 'linkId', new.id));
  return null;
end $$;
create trigger team_bus_partner_link_insert after insert on team_partner_links
  for each row execute function team_bus_partner_link();
create trigger team_bus_partner_link_update after update of state, local_approved, partner_approved on team_partner_links
  for each row when (new.state is distinct from old.state or new.local_approved is distinct from old.local_approved
    or new.partner_approved is distinct from old.partner_approved)
  execute function team_bus_partner_link();

create function team_bus_partner_call() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform team_bus_notify(jsonb_build_object('kind', 'partnerCall', 'linkId', new.link_id));
  elsif new.state in ('done', 'failed') and new.state is distinct from old.state then
    perform team_bus_notify(jsonb_build_object('kind', 'partnerResult', 'callId', new.id));
  end if;
  return null;
end $$;
create trigger team_bus_partner_call after insert or update of state on team_partner_calls
  for each row execute function team_bus_partner_call();

create function team_bus_account() returns trigger language plpgsql as $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'account'));
  return null;
end $$;
create trigger team_bus_account after insert or update on team_installation
  for each row execute function team_bus_account();
`;
