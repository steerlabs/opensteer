/**
 * Team knowledge: topics with access lists, and notes whose every version is kept.
 * It replaces the restricted SQL schema, whose objects and login this drops; the
 * cluster-wide owner role goes only when no other database in the cluster still uses it.
 */
export const TEAM_KNOWLEDGE_NOTES_SQL = `
drop table if exists team_channel_topics;
drop table if exists team_topic_grants;
drop schema if exists knowledge cascade;
do $$ declare executor text := 'opensteer_knowledge_executor_' || (
  select oid::text from pg_catalog.pg_database where datname = current_database());
begin
  if exists (select from pg_catalog.pg_roles where rolname = executor) then
    execute format('drop role %I', executor);
  end if;
  if exists (select from pg_catalog.pg_roles where rolname = 'opensteer_knowledge_owner') then
    begin
      drop role opensteer_knowledge_owner;
    exception when dependent_objects_still_exist then null;
    end;
  end if;
end $$;

create table team_topics (
  "id" text primary key,
  "name" text not null check (char_length(name) between 1 and 160),
  "description" text not null default '' check (char_length(description) <= 500),
  "created_by" text references team_members(user_id),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "archived_at" timestamptz,
  "access_revision" bigint not null default 0 check (access_revision >= 0)
);
create index team_topics_name on team_topics(lower(name), id);

create table team_topic_grants (
  "topic_id" text not null references team_topics(id),
  "subject_kind" text not null check (subject_kind in ('person', 'group', 'everyone')),
  "subject_id" text not null,
  "level" text not null check (level in ('read', 'write', 'manage')),
  "added_by" text references team_members(user_id),
  "added_at" timestamptz not null default now(),
  primary key ("topic_id", "subject_kind", "subject_id"),
  check (subject_kind <> 'everyone' or (subject_id = 'team' and level <> 'manage'))
);
create index team_topic_grants_subject on team_topic_grants(subject_kind, subject_id, topic_id);

create table team_notes (
  "id" text primary key,
  "topic_id" text not null references team_topics(id),
  "version" integer not null check (version >= 1),
  "title" text not null check (char_length(title) between 1 and 200),
  "body" text not null check (octet_length(body) <= 65536),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz,
  "search" tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig, title), 'A') ||
    setweight(to_tsvector('simple'::regconfig, body), 'B')) stored not null
);
create index team_notes_recent on team_notes(topic_id, updated_at desc, id desc) where deleted_at is null;
create index team_notes_search on team_notes using gin(search);

create table team_note_versions (
  "note_id" text not null references team_notes(id),
  "version" integer not null check (version >= 1),
  "title" text not null check (char_length(title) between 1 and 200),
  "body" text not null check (octet_length(body) <= 65536),
  "deleted" boolean not null,
  "writer_kind" text not null check (writer_kind in ('human', 'agent')),
  "writer_user_id" text not null references team_members(user_id),
  "link_id" text references team_links(id),
  "request_id" text references team_agent_requests(id),
  "written_at" timestamptz not null default clock_timestamp(),
  primary key ("note_id", "version"),
  check (writer_kind = 'agent' or (link_id is null and request_id is null))
);
create index team_note_versions_writer on team_note_versions(writer_user_id, written_at desc);
`;
