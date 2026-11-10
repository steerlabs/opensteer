import type { KnowledgeTopicId } from "@opensteer/core";
import { sql, type ColumnType, type Generated, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema, JsonColumn, Timestamp } from "./schema.js";

export type KnowledgeWriterKind = "person" | "project";

export interface KnowledgeTables {
  "knowledge.topics": {
    id: KnowledgeTopicId;
    name: string;
    createdAt: Generated<Timestamp>;
    createdByKind: KnowledgeWriterKind;
    createdById: string;
    archivedAt: Generated<Date | null>;
  };
  "knowledge.operations": {
    id: string;
    writerKind: KnowledgeWriterKind;
    writerId: string;
    inputHash: string;
    rowCount: Generated<number>;
    receipt: JsonColumn<unknown> | null;
    createdAt: Generated<Timestamp>;
  };
  "knowledge.factLog": {
    id: ColumnType<string, never, never>;
    topic: KnowledgeTopicId;
    thing: string;
    property: string;
    value: JsonColumn<unknown>;
    writerKind: KnowledgeWriterKind;
    writerId: string;
    initiatorId: string | null;
    agentId: string;
    taskId: string | null;
    runId: string | null;
    writtenAt: Generated<Timestamp>;
    replacesId: string | null;
    seenFactId: string | null;
    operationId: string;
    operationRow: number;
  };
}

export const knowledgeOwnerRole = "opensteer_knowledge_owner";

/** One LOGIN role per database: its password is the only thing that admits a session as it. */
export async function knowledgeExecutorRole(database: Kysely<DatabaseSchema>): Promise<string> {
  const { rows } = await sql<{ oid: string }>`
    select oid::text as oid from pg_catalog.pg_database where datname = current_database()
  `.execute(database);
  const oid = rows[0]?.oid;
  if (!oid || !/^\d+$/u.test(oid)) throw new Error("Cannot identify the Host database");
  return `opensteer_knowledge_executor_${oid}`;
}

/**
 * Creates the restricted role if this database has none yet (a clone or a
 * restore), and makes its attributes, grants and password exactly these.
 */
async function ensureKnowledgeExecutor(
  database: Transaction<DatabaseSchema>,
  passwordVerifier: string,
): Promise<string> {
  const role = await knowledgeExecutorRole(database);
  if (
    !/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u.test(
      passwordVerifier,
    )
  )
    throw new Error("Refusing a malformed knowledge executor verifier");
  const name = `"${role}"`;
  await sql
    .raw(
      `do $$ begin
        create role ${name} nologin;
      exception when duplicate_object or unique_violation then null;
      end $$;
      alter role ${name} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
        password '${passwordVerifier}';
      alter role ${name} set search_path = pg_catalog, knowledge, pg_temp;
      alter role ${name} set standard_conforming_strings = on;
      alter role ${name} set backslash_quote = safe_encoding;
      alter role ${name} set temp_file_limit = '32MB';
      alter role ${name} set work_mem = '4MB';
      alter role ${name} set log_min_messages = 'fatal';
      grant usage on schema knowledge to ${name};
      grant select on knowledge.fact_log, knowledge.facts, knowledge.fact_history to ${name};
      grant insert (topic, thing, property, value, seen_fact_id) on knowledge.facts to ${name};
      grant execute on function knowledge.begin_operation(text), knowledge.complete_operation(),
        knowledge.result_row_too_large(), knowledge.result_too_large() to ${name};`,
    )
    .execute(database);
  const { rows } = await sql<{ count: string }>`
    select count(*)::text as count from pg_catalog.pg_auth_members
    where member = (select oid from pg_catalog.pg_roles where rolname = ${role})
  `.execute(database);
  if (rows[0]?.count !== "0") throw new Error("The knowledge executor must belong to no role");
  return role;
}

const scope = (setting: string) =>
  `coalesce(nullif((select current_setting('knowledge.${setting}', true)), '')::text[], '{}')`;

const factColumns = `id, topic, thing, property, value, value #>> '{}' as text,
  writer_kind, writer_id, initiator_id, agent_id, task_id, run_id, written_at,
  replaces_id, seen_fact_id, operation_id, operation_row`;

/** Each step moves the knowledge schema up one version. Add a step; never edit one that has shipped. */
const knowledgeSchemaSteps: readonly string[] = [
  `create schema knowledge authorization ${knowledgeOwnerRole};

    create table knowledge.topics (
      id text primary key check (octet_length(id) between 1 and 128),
      name text not null check (char_length(name) between 1 and 200),
      created_at timestamptz not null default now(),
      created_by_kind text not null check (created_by_kind in ('person', 'project')),
      created_by_id text not null check (created_by_id <> ''),
      archived_at timestamptz
    );

    create table knowledge.operations (
      id text primary key check (octet_length(id) between 1 and 128),
      writer_kind text not null check (writer_kind in ('person', 'project')),
      writer_id text not null check (writer_id <> ''),
      input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
      row_count smallint not null default 0,
      receipt jsonb,
      created_at timestamptz not null default now()
    );

    create table knowledge.fact_log (
      id bigint generated always as identity primary key,
      topic text not null references knowledge.topics(id),
      thing text not null constraint fact_log_thing_size check (octet_length(thing) between 1 and 256),
      property text not null
        constraint fact_log_property_size check (octet_length(property) between 1 and 128),
      value jsonb not null constraint fact_log_value_size check (octet_length(value::text) <= 65536)
        constraint fact_log_value_depth check (not jsonb_path_exists(value, 'strict $.**{64}')),
      writer_kind text not null check (writer_kind in ('person', 'project')),
      writer_id text not null,
      initiator_id text,
      agent_id text not null,
      task_id text,
      run_id text,
      written_at timestamptz not null default clock_timestamp(),
      replaces_id bigint,
      seen_fact_id bigint,
      operation_id text not null references knowledge.operations(id),
      operation_row smallint not null check (operation_row between 1 and 25),
      constraint fact_log_writer_present check (writer_id <> '' and agent_id <> ''),
      unique (operation_id, operation_row)
    );
    create index fact_log_key on knowledge.fact_log (topic, thing, property, id desc);
    create index fact_log_writer on knowledge.fact_log (writer_kind, writer_id, id desc);

    alter table knowledge.fact_log enable row level security;
    alter table knowledge.fact_log force row level security;
    create policy fact_log_read on knowledge.fact_log for select using (topic = any (${scope("read_topics")}));
    create policy fact_log_write on knowledge.fact_log for insert with check (topic = any (${scope("write_topics")}));

    create view knowledge.fact_history with (security_barrier = true, security_invoker = true) as
      select ${factColumns} from knowledge.fact_log;
    create view knowledge.facts with (security_barrier = true, security_invoker = true) as
      select distinct on (topic, thing, property) ${factColumns}
      from knowledge.fact_log order by topic, thing, property, id desc;

    create function knowledge.require_read_committed() returns void
    language plpgsql set search_path = pg_catalog, pg_temp as $fn$
    begin
      if current_setting('transaction_isolation') <> 'read committed' then
        raise exception using errcode = 'KB005', message = 'Knowledge runs at READ COMMITTED.';
      end if;
    end $fn$;

    create function knowledge.begin_operation(input_hash text) returns jsonb
    language plpgsql security definer set search_path = pg_catalog, knowledge, pg_temp as $fn$
    declare
      operation text := nullif(current_setting('knowledge.operation_id', true), '');
      kind text := nullif(current_setting('knowledge.writer_kind', true), '');
      writer text := nullif(current_setting('knowledge.writer_id', true), '');
      claimed text;
      existing knowledge.operations;
    begin
      perform knowledge.require_read_committed();
      if operation is null or kind is null or writer is null then
        raise exception using errcode = 'KB008', message = 'The write has no operation or writer.';
      end if;
      insert into knowledge.operations (id, writer_kind, writer_id, input_hash)
      values (operation, kind, writer, begin_operation.input_hash)
      on conflict (id) do nothing returning id into claimed;
      if claimed is not null then return null; end if;
      select * into existing from knowledge.operations where id = operation;
      if existing.writer_kind = kind and existing.writer_id = writer
         and existing.input_hash = begin_operation.input_hash and existing.receipt is not null then
        return existing.receipt;
      end if;
      raise exception using errcode = 'KB006', message = 'This operation key was used for a different write.';
    end $fn$;

    create function knowledge.append_fact() returns trigger
    language plpgsql security definer set search_path = pg_catalog, knowledge, pg_temp as $fn$
    declare
      operation text := nullif(current_setting('knowledge.operation_id', true), '');
      archived timestamptz;
      next_row integer;
      previous_id bigint;
      inserted knowledge.fact_log;
    begin
      perform knowledge.require_read_committed();
      if new.topic is null or not (new.topic = any (${scope("write_topics")}))
         or not (new.topic = any (${scope("read_topics")})) then
        raise exception using errcode = 'KB001', message = 'Topic is not writable.';
      end if;
      select topics.archived_at into archived from knowledge.topics where id = new.topic for share;
      if not found or archived is not null then
        raise exception using errcode = 'KB001', message = 'Topic is not writable.';
      end if;
      update knowledge.operations set row_count = row_count + 1
      where id = operation returning row_count into next_row;
      if next_row is null then
        raise exception using errcode = 'KB008', message = 'The write has no operation.';
      end if;
      if next_row > 25 then
        raise exception using errcode = 'KB004', message = 'One write appends at most 25 facts.';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(
        'knowledge:' || jsonb_build_array(new.topic, new.thing, new.property)::text, 0));
      select id into previous_id from knowledge.fact_log
      where topic = new.topic and thing = new.thing and property = new.property
      order by id desc limit 1;
      if new.seen_fact_id is not null and not exists (
        select from knowledge.fact_log where id = new.seen_fact_id
          and topic = new.topic and thing = new.thing and property = new.property) then
        raise exception using errcode = 'KB002', message = 'seen_fact_id is not a version of this fact.';
      end if;
      if current_setting('knowledge.only_if_unchanged', true) = 'true'
         and new.seen_fact_id is distinct from previous_id then
        raise exception using errcode = 'KB003', message = 'Fact changed.',
          detail = jsonb_build_object('topic', new.topic, 'thing', new.thing, 'property', new.property,
            'currentFactId', previous_id::text, 'seenFactId', new.seen_fact_id::text)::text;
      end if;
      insert into knowledge.fact_log (topic, thing, property, value, writer_kind, writer_id,
        initiator_id, agent_id, task_id, run_id, replaces_id, seen_fact_id, operation_id, operation_row)
      values (new.topic, new.thing, new.property, new.value,
        current_setting('knowledge.writer_kind', true), current_setting('knowledge.writer_id', true),
        nullif(current_setting('knowledge.initiator_id', true), ''),
        current_setting('knowledge.agent_id', true),
        nullif(current_setting('knowledge.task_id', true), ''),
        nullif(current_setting('knowledge.run_id', true), ''),
        previous_id, new.seen_fact_id, operation, next_row)
      returning * into inserted;
      new.id := inserted.id;
      new.value := inserted.value;
      new.text := inserted.value #>> '{}';
      new.writer_kind := inserted.writer_kind;
      new.writer_id := inserted.writer_id;
      new.initiator_id := inserted.initiator_id;
      new.agent_id := inserted.agent_id;
      new.task_id := inserted.task_id;
      new.run_id := inserted.run_id;
      new.written_at := inserted.written_at;
      new.replaces_id := inserted.replaces_id;
      new.operation_id := inserted.operation_id;
      new.operation_row := inserted.operation_row;
      return new;
    end $fn$;
    create trigger append_fact instead of insert on knowledge.facts
      for each row execute function knowledge.append_fact();

    create function knowledge.complete_operation() returns jsonb
    language plpgsql security definer set search_path = pg_catalog, knowledge, pg_temp as $fn$
    declare
      operation text := nullif(current_setting('knowledge.operation_id', true), '');
      conditional boolean := coalesce(current_setting('knowledge.only_if_unchanged', true) = 'true', false);
      built jsonb;
    begin
      perform knowledge.require_read_committed();
      select jsonb_build_object('operationId', operation, 'facts', coalesce(jsonb_agg(jsonb_build_object(
          'id', written.id::text, 'topic', written.topic, 'thing', written.thing,
          'property', written.property, 'replacesId', written.replaces_id::text,
          'seenFactId', written.seen_fact_id::text,
          'baseline', case when written.seen_fact_id is not null or conditional
            then 'observed' else 'unknown' end,
          'unseenCount', case when written.seen_fact_id is not null or conditional then (
            select count(*) from knowledge.fact_log missed
            where missed.topic = written.topic and missed.thing = written.thing
              and missed.property = written.property and missed.operation_id <> operation
              and missed.id > coalesce(written.seen_fact_id, 0) and missed.id <= written.replaces_id
          ) end,
          'unseen', case when written.seen_fact_id is not null or conditional then (
            select coalesce(jsonb_agg(jsonb_build_object('id', missed.id::text,
              'writerKind', missed.writer_kind, 'writerId', missed.writer_id,
              'agentId', missed.agent_id, 'taskId', missed.task_id,
              'writtenAt', missed.written_at) order by missed.id desc), '[]')
            from (select * from knowledge.fact_log missed
              where missed.topic = written.topic and missed.thing = written.thing
                and missed.property = written.property and missed.operation_id <> operation
                and missed.id > coalesce(written.seen_fact_id, 0) and missed.id <= written.replaces_id
              order by missed.id desc limit 20) missed
          ) end
        ) order by written.operation_row), '[]'::jsonb))
      into built
      from knowledge.fact_log written where written.operation_id = operation;
      update knowledge.operations set receipt = built where id = operation;
      if not found then
        raise exception using errcode = 'KB008', message = 'The write has no operation.';
      end if;
      return built;
    end $fn$;

    create function knowledge.result_row_too_large() returns boolean
    language plpgsql volatile set search_path = pg_catalog, pg_temp as $fn$
    begin
      raise exception using errcode = 'KB007', message = 'A result row is over 512 KB.';
    end $fn$;

    create function knowledge.result_too_large() returns boolean
    language plpgsql volatile set search_path = pg_catalog, pg_temp as $fn$
    begin
      raise exception using errcode = 'KB009', message = 'A result is over 1 MB.';
    end $fn$;

    alter table knowledge.topics owner to ${knowledgeOwnerRole};
    alter table knowledge.operations owner to ${knowledgeOwnerRole};
    alter table knowledge.fact_log owner to ${knowledgeOwnerRole};
    alter view knowledge.fact_history owner to ${knowledgeOwnerRole};
    alter view knowledge.facts owner to ${knowledgeOwnerRole};
    alter function knowledge.require_read_committed() owner to ${knowledgeOwnerRole};
    alter function knowledge.begin_operation(text) owner to ${knowledgeOwnerRole};
    alter function knowledge.append_fact() owner to ${knowledgeOwnerRole};
    alter function knowledge.complete_operation() owner to ${knowledgeOwnerRole};
    alter function knowledge.result_row_too_large() owner to ${knowledgeOwnerRole};
    alter function knowledge.result_too_large() owner to ${knowledgeOwnerRole};
    revoke all on function knowledge.require_read_committed(), knowledge.begin_operation(text),
      knowledge.append_fact(), knowledge.complete_operation(), knowledge.result_row_too_large(),
      knowledge.result_too_large() from public;`,
];

const versionComment = "opensteer knowledge schema ";

/**
 * Creates or upgrades the knowledge schema, its owner and the restricted login,
 * in one transaction serialized against any other start. Nothing about
 * knowledge exists in a database until the trial first runs this.
 */
export async function ensureKnowledge(
  transaction: Transaction<DatabaseSchema>,
  passwordVerifier: string,
): Promise<string> {
  await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opensteer:knowledge-schema', 0))`.execute(
    transaction,
  );
  const { rows } = await sql<{ present: boolean; comment: string | null }>`
    select true as present, pg_catalog.obj_description(oid, 'pg_namespace') as comment
    from pg_catalog.pg_namespace where nspname = 'knowledge'
  `.execute(transaction);
  const found = rows[0];
  const version = !found
    ? 0
    : found.comment?.startsWith(versionComment)
      ? Number(found.comment.slice(versionComment.length))
      : Number.NaN;
  if (!Number.isInteger(version) || version > knowledgeSchemaSteps.length)
    throw new Error("A different Opensteer build prepared this database's knowledge schema");
  // The owner role is shared by every database in the cluster, which the advisory lock does not
  // span, so it is created at most once and altered only when wrong.
  await sql
    .raw(
      `do $$ begin
        create role ${knowledgeOwnerRole} nologin nosuperuser nocreatedb nocreaterole noinherit
          noreplication nobypassrls;
      exception when duplicate_object or unique_violation then null;
      end $$;
      do $$ begin
        if exists (select from pg_catalog.pg_roles where rolname = '${knowledgeOwnerRole}'
            and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit
              or rolreplication or rolbypassrls)) then
          alter role ${knowledgeOwnerRole} with nologin nosuperuser nocreatedb nocreaterole
            noinherit noreplication nobypassrls;
        end if;
      end $$;`,
    )
    .execute(transaction);
  for (const step of knowledgeSchemaSteps.slice(version)) await sql.raw(step).execute(transaction);
  if (version < knowledgeSchemaSteps.length)
    await sql
      .raw(`comment on schema knowledge is '${versionComment}${knowledgeSchemaSteps.length}'`)
      .execute(transaction);
  return ensureKnowledgeExecutor(transaction, passwordVerifier);
}
