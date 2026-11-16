export const deviceDriversMigrationName = "0028_device_drivers";

// Legacy target keys and Runner policy columns remain until a separately planned contract step.
export const DEVICE_DRIVERS_SQL = `
alter table runners alter column access_policy set default '{"reach":"nobody","commands":false,"forwarding":false,"shares":[],"browser":false,"apps":false}'::jsonb;
alter table runners alter column access_policy_revision set default 1;
create table devices (
  id text primary key,
  deployment_id text not null references deployments(id) on delete restrict,
  owner_kind text not null check(owner_kind in ('deployment','user')),
  owner_user_id text references users(id) on delete restrict,
  name text not null,
  kind text not null check(kind in ('home','computer','phone','agent-phone','server','unknown')),
  platform text check(platform in ('macos','linux','windows','android','ios')),
  form text check(form in ('laptop','desktop','compact','server','phone')),
  access_policy jsonb not null,
  access_policy_revision integer not null default 1 check(access_policy_revision >= 0),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_kind='user') = (owner_user_id is not null))
);
create index devices_owner_live on devices(owner_user_id,id) where removed_at is null;
create index devices_deployment_live on devices(deployment_id,id) where removed_at is null;
create table device_drivers (
  device_id text not null references devices(id) on delete restrict,
  role text not null check(role in ('self','screen')),
  runner_id text not null references runners(id) on delete restrict,
  generation bigint not null default 1 check(generation > 0 and generation <= 9007199254740991),
  detached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(device_id,role)
);
create unique index device_drivers_self_live on device_drivers(runner_id) where role='self' and detached_at is null;
create index device_drivers_runner_live on device_drivers(runner_id,device_id,role) where detached_at is null;
insert into devices(id,deployment_id,owner_kind,owner_user_id,name,kind,platform,form,access_policy,access_policy_revision,removed_at,created_at,updated_at)
select r.id,d.id,r.owner_kind,r.owner_user_id,r.name,
case when r.kind='main' and r.owner_kind='deployment' then 'home'
  when r.allowed_modules @> '["browser","integrations"]'::jsonb and jsonb_array_length(r.allowed_modules)=2 and r.device->>'form'='phone'
    then case when r.device->>'app'='opensteer' then 'phone' when r.device->>'platform'='android' then 'agent-phone' else 'unknown' end
  when r.device->>'app'='opensteer' then 'computer'
  when r.device->>'form'='server' then 'server' else 'unknown' end,
case when r.device->>'platform' in ('macos','linux','windows','android','ios') then r.device->>'platform' end,
case when r.device->>'form' in ('laptop','desktop','compact','server','phone') then r.device->>'form' end,
r.access_policy,r.access_policy_revision,r.revoked_at,r.created_at,r.updated_at
from runners r cross join deployments d
where d.singleton_key='primary' and d.deployment_shape->>'kind'='personal'
  and not(r.owner_kind='deployment' and not(r.allowed_modules ? 'agents'));
insert into device_drivers(device_id,role,runner_id,generation,detached_at,created_at,updated_at)
select id,'self',id,1,removed_at,created_at,updated_at from devices;
do $$
declare invalid_count bigint;
begin
  select count(*) into invalid_count from (
    select runner_id as id from integration_connections where connection_kind='computer'
    union all select runner_id from computer_use_policies
    union all select runner_id from computer_use_stops
    union all select runner_id from computer_app_setup_requests
    union all select computer_id from personal_tabs
    union all select device_id from auth_sessions where device_id is not null
  ) targets left join devices d on d.id=targets.id where d.id is null;
  if invalid_count > 0 then raise exception 'Device migration: % unresolved retained control targets',invalid_count; end if;
end $$;
alter table integration_connections add column device_id text references devices(id) on delete restrict;
update integration_connections set device_id=runner_id where connection_kind='computer';
alter table integration_connections add constraint integration_connections_device_target check(
 (connection_kind='computer' and (device_id is not null or runner_id is not null) and
   (device_id is null or runner_id is null or device_id=runner_id)) or
 (connection_kind<>'computer' and device_id is null));
create unique index integration_connections_device_live_unique on integration_connections(integration_definition_id,coalesce(device_id,runner_id),coalesce(computer_app_key,'')) where connection_kind='computer' and status<>'revoked';
alter table computer_use_policies add foreign key(deployment_id) references deployments(id) on delete restrict;
alter table computer_use_policies add foreign key(owner_user_id) references users(id) on delete restrict;
alter table computer_use_stops add foreign key(run_id) references runs(id) on delete cascade;
create index computer_use_stops_device on computer_use_stops(runner_id,run_id);
alter table computer_app_setup_requests add foreign key(deployment_id) references deployments(id) on delete restrict;
alter table computer_app_setup_requests add foreign key(owner_user_id) references users(id) on delete restrict;
create index computer_app_setup_requests_device_expiry on computer_app_setup_requests(runner_id,expires_at);
create index computer_app_setup_requests_owner_expiry on computer_app_setup_requests(owner_user_id,expires_at);
`;
