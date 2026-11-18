export const PLUGIN_HOST_SQL = `
create table plugin_agent_settings (
  owner_user_id text not null references users(id),
  plugin_id text not null,
  access text not null default 'all' check (access in ('all', 'read-only', 'off')),
  author text not null check (author in ('catalog', 'agent')),
  version_authors jsonb not null default '{}'::jsonb,
  primary key (owner_user_id, plugin_id)
);
alter table requests add column originating_watch_activation_id text references trigger_watch_activations(id);
alter table requests drop constraint requests_origin_check;
alter table requests add constraint requests_origin_check check (
  num_nonnulls(originating_run_id, originating_occurrence_id, originating_watch_activation_id) = 1
  and (mode <> 'live' or originating_run_id is not null)
);
create unique index requests_watch_call_identity on requests(originating_watch_activation_id, call_id) where originating_watch_activation_id is not null;
create table plugin_executions (
  id text primary key,
  owner_user_id text not null references users(id),
  thread_id text not null references threads(id),
  run_id text references runs(id),
  occurrence_id text references trigger_occurrences(id),
  watch_activation_id text references trigger_watch_activations(id),
  caller text not null,
  mode text not null check (mode in ('ask', 'automatic')),
  state text not null check (state in ('running','waiting','answered','completed','cancelled','expired','interrupted','failed')),
  request_id text references requests(id),
  interaction_id text,
  handoff boolean not null default false,
  result jsonb,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(run_id, occurrence_id, watch_activation_id) = 1)
);
create index plugin_executions_unfinished on plugin_executions(state) where state in ('running','waiting','answered');
`;
