export const tabsAndAppsMigrationName = "0026_tabs_and_apps";
export const TABS_AND_APPS_SQL = `
drop table browser_tab_group_members;
drop table browser_tab_groups;
drop table browser_tab_layouts;
drop table personal_tabs;
alter table runners drop column tab_opened_at;
alter table apps drop column tab_opened_at;

alter table apps add column owner_id text references users(id),
  add column computer_id text,
  add column creation_key text,
  add column deleting boolean not null default false;
update apps app set owner_id = settings.owner_id from personal_settings settings;
update apps app set computer_id = coalesce(
  (select nullif(version.server->'folder'->>'computerId','') from app_versions version where version.app_id=app.id and version.version=app.latest_version),
  (select coalesce((select attempt.runner_id from run_attempts attempt where attempt.run_id=publisher.id and attempt.runner_id is not null order by ordinal desc limit 1), environment.runner_id) from app_versions version join runs publisher on publisher.id=version.created_by_run join execution_environments environment on environment.id=publisher.environment_id where version.app_id=app.id and version.version=app.latest_version),
  (select coalesce((select attempt.runner_id from run_attempts attempt where attempt.run_id=publisher.id and attempt.runner_id is not null order by ordinal desc limit 1), environment.runner_id) from runs publisher join execution_environments environment on environment.id=publisher.environment_id where publisher.id=app.run_id)
);
delete from apps where owner_id is null or computer_id is null;
alter table apps rename column title to name;
alter table apps alter column owner_id set not null,
  alter column computer_id set not null,
  alter column thread_id drop not null,
  alter column run_id drop not null,
  alter column latest_version set default 0,
  add constraint apps_latest_version check (latest_version >= 0),
  add constraint apps_id_computer unique(id, computer_id),
  add constraint apps_owner_creation unique(owner_id, creation_key);
alter table apps drop constraint apps_thread_id_fkey, drop constraint apps_run_id_fkey;
alter table apps add foreign key(thread_id) references threads(id) on delete set null,
  add foreign key(run_id) references runs(id) on delete set null;
create table app_servers (
  app_id text primary key,
  computer_id text not null,
  port integer not null check (port between 49152 and 65535),
  desired_state text not null check (desired_state in ('running','stopped')),
  generation bigint not null default 1 check (generation > 0),
  last_error text,
  foreign key(app_id,computer_id) references apps(id,computer_id) on delete cascade,
  unique(computer_id,port)
);
do $$
declare app record; candidate integer; occupied integer;
begin
  for app in select a.id, a.computer_id from apps a join app_versions v
    on v.app_id=a.id and v.version=a.latest_version where v.server is not null order by a.id
  loop
    candidate := 49152 + ((('x' || substr(md5(app.id),1,8))::bit(32)::bigint % 16384)::integer);
    occupied := 0;
    while exists(select 1 from app_servers where computer_id=app.computer_id and port=candidate) loop
      occupied := occupied + 1;
      if occupied >= 16384 then raise exception 'No fixed app ports remain on computer %', app.computer_id; end if;
      candidate := 49152 + ((candidate - 49152 + 1) % 16384);
    end loop;
    insert into app_servers(app_id,computer_id,port,desired_state) values(app.id,app.computer_id,candidate,'running');
  end loop;
end $$;

create table personal_tabs (
  id text primary key,
  owner_id text not null references users(id),
  kind text not null check (kind in ('page','window','phone','app')),
  computer_id text not null,
  title text not null,
  url text,
  profile_id text,
  profile_name text,
  app_id text,
  window_id text,
  window_app jsonb,
  page_binding jsonb,
  favicon text,
  icon_ref text,
  opener_tab_id text,
  opened_by jsonb not null,
  generation bigint not null default 1 check (generation > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_position jsonb,
  check (
    (kind='page' and url is not null and app_id is null and window_id is null and window_app is null
      and ((profile_id is null) = (profile_name is null)))
    or (kind='window' and window_id is not null and window_app is not null and url is null
      and profile_id is null and profile_name is null and app_id is null and page_binding is null)
    or (kind='phone' and url is null and profile_id is null and profile_name is null
      and app_id is null and window_id is null and window_app is null and page_binding is null)
    or (kind='app' and app_id is not null and url is null and profile_id is null and profile_name is null
      and window_id is null and window_app is null and page_binding is null)
  )
);
create unique index personal_tabs_phone on personal_tabs(owner_id,computer_id) where kind='phone';
create unique index personal_tabs_app on personal_tabs(owner_id,app_id) where kind='app';
create unique index personal_tabs_window on personal_tabs(owner_id,computer_id,window_id) where kind='window';
create index personal_tabs_open on personal_tabs(owner_id,created_at,id) where closed_at is null;
create index personal_tabs_closed on personal_tabs(owner_id,closed_at desc,id) where closed_at is not null;
create table tab_layouts (
  owner_id text primary key references users(id),
  revision bigint not null default 0 check (revision >= 0),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items)='array')
);
`;
