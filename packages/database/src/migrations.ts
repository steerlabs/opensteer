import { createHash } from "node:crypto";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  ContentPartSchema,
  markColors,
  markColorAllocationOrder,
  workspaceIconNames,
  harnessDriverLabel,
  isLoopbackHostname,
  normalizeToolOutput,
  ToolOutputSchema,
  type EventId,
} from "@opensteer/core";
import { type Kysely, sql } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from "kysely/migration";
import type {
  IntegrationToolMaterial,
  IntegrationConnectionId,
  IntegrationServerId,
} from "@opensteer/integration-core";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import { materializeToolCatalog } from "@opensteer/integration-core/tool-schemas";
import { BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

const machineFullDiskAccessMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const constraint = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'public.requests'::regclass AND conname = 'requests_kind_check'
    `.execute(database);
    // A fresh baseline already includes these values.
    if (constraint.rows[0]?.definition.includes("machine.full-disk-access")) return;
    await sql`
ALTER TABLE public.agent_control_requests DROP CONSTRAINT agent_control_requests_action_check;
ALTER TABLE public.agent_control_requests ADD CONSTRAINT agent_control_requests_action_check CHECK ((action = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text])));
ALTER TABLE public.agent_control_requests DROP CONSTRAINT agent_control_requests_action_class_check;
ALTER TABLE public.agent_control_requests ADD CONSTRAINT agent_control_requests_action_class_check CHECK ((action_class = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text])));
ALTER TABLE public.requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE public.requests ADD CONSTRAINT requests_kind_check CHECK ((kind = ANY (ARRAY['harness.approval'::text, 'harness.input'::text, 'machine.full-disk-access'::text, 'browser.access'::text, 'browser.profile.save'::text, 'integration.access'::text, 'integration.install'::text])));
ALTER TABLE public.requests DROP CONSTRAINT requests_kind_mode_check;
ALTER TABLE public.requests ADD CONSTRAINT requests_kind_mode_check CHECK ((((kind = ANY (ARRAY['harness.approval'::text, 'harness.input'::text])) AND (mode = 'live'::text)) OR ((kind = ANY (ARRAY['machine.full-disk-access'::text, 'browser.access'::text, 'browser.profile.save'::text, 'integration.access'::text, 'integration.install'::text])) AND (mode = 'durable'::text))));
ALTER TABLE public.trigger_control_requests DROP CONSTRAINT trigger_control_requests_action_check;
ALTER TABLE public.trigger_control_requests ADD CONSTRAINT trigger_control_requests_action_check CHECK ((action = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text])));
ALTER TABLE public.trigger_control_requests DROP CONSTRAINT trigger_control_requests_action_class_check;
ALTER TABLE public.trigger_control_requests ADD CONSTRAINT trigger_control_requests_action_class_check CHECK ((action_class = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text])));
    `.execute(database);
  },
};

export const computerAppSetupRequestsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table computer_app_setup_requests (
        id uuid primary key,
        deployment_id text not null references deployments(id) on delete cascade,
        owner_user_id text not null references users(id) on delete cascade,
        runner_id text not null references runners(id) on delete cascade,
        definition_id text not null,
        definition_digest text not null,
        access text not null check (access in ('read', 'read-write')),
        created_at timestamptz not null,
        expires_at timestamptz not null,
        unique (runner_id, definition_id)
      )
    `.execute(database);
    await sql`create index computer_app_setup_requests_owner on computer_app_setup_requests(owner_user_id)`.execute(
      database,
    );
  },
};

/** Sources are authenticated by their own revocable credential, never a Host session. */
export const browserSourcesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.browser_sources (
        id text primary key check (id ~ '^bsr_[0-9a-f-]{36}$'),
        owner_id text not null references public.users(id) on delete cascade,
        name text not null check (length(name) between 1 and 120),
        token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
        generation integer not null default 1 check (generation > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create index browser_sources_owner on public.browser_sources(owner_id) where revoked_at is null;

      create table public.browser_source_pairings (
        code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
        owner_id text not null references public.users(id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz,
        check (expires_at > created_at)
      );
      create index browser_source_pairings_expiry on public.browser_source_pairings(expires_at);

      create table public.browser_source_grants (
        id uuid primary key,
        source_id text not null references public.browser_sources(id) on delete cascade,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        site text not null check (length(site) between 1 and 2048),
        access text not null check (access in ('inspect', 'import')),
        created_by text not null references public.users(id) on delete cascade,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create unique index browser_source_grants_active on public.browser_source_grants(source_id, workspace_id, site)
        where revoked_at is null;
      create index browser_source_grants_workspace on public.browser_source_grants(workspace_id, created_by)
        where revoked_at is null;

      create table public.browser_source_imports (
        id uuid not null,
        source_id text not null references public.browser_sources(id),
        workspace_id text not null references public.workspaces(id),
        owner_id text not null references public.users(id),
        site text not null check (length(site) between 1 and 2048),
        profile_id text not null unique references public.browser_profiles(id),
        request_id text unique references public.requests(id),
        created_at timestamptz not null default now(),
        primary key (owner_id, id)
      );
      create index browser_source_imports_owner on public.browser_source_imports(owner_id, created_at);
    `.execute(database);
    for (const [table, names, oldValue, additions] of [
      [
        "agent_control_requests",
        ["agent_control_requests_action_check", "agent_control_requests_action_class_check"],
        "'browser.session.close'::text",
        ", 'browser.source.inspect'::text, 'browser.profile.import'::text",
      ],
      [
        "trigger_control_requests",
        ["trigger_control_requests_action_check", "trigger_control_requests_action_class_check"],
        "'browser.session.close'::text",
        ", 'browser.source.inspect'::text, 'browser.profile.import'::text",
      ],
      [
        "requests",
        ["requests_kind_check", "requests_kind_mode_check"],
        "'browser.profile.save'::text",
        ", 'browser.profile.import'::text",
      ],
    ] as const) {
      for (const name of names) {
        const result = await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = ${`public.${table}`}::regclass and conname = ${name}
        `.execute(database);
        const definition = result.rows[0]?.definition;
        if (!definition || !definition.includes(oldValue))
          throw new Error(`Cannot extend ${name} for browser sources`);
        const next = definition.replaceAll(oldValue, `${oldValue}${additions}`);
        await sql.raw(`alter table public.${table} drop constraint ${name}`).execute(database);
        await sql
          .raw(`alter table public.${table} add constraint ${name} ${next}`)
          .execute(database);
      }
    }
  },
};

/** Retires extension-backed cookie imports without touching the profiles they created. */
export const browserSourcesRetirementMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      declare
        retired record;
        retired_at timestamptz := now();
        origin_environment_id text;
        next_sequence bigint;
      begin
        for retired in
          select * from public.requests
          where kind = 'browser.profile.import' and status = 'pending'
          order by id
          for update
        loop
          if retired.response_command_id is not null then
            update public.commands
            set last_error = '{"message":"The Request was cancelled before its response completed"}'::jsonb,
                status = 'failed',
                updated_at = retired_at
            where id = retired.response_command_id
              and type = 'request.respond'
              and status in ('pending', 'dispatched', 'unknown');
          end if;

          update public.requests
          set status = 'cancelled',
              cancellation_reason = 'authority-revoked',
              resolved_at = retired_at,
              resolved_by = null,
              response_command_id = null
          where id = retired.id and status = 'pending';

          if retired.originating_run_id is not null then
            select environment_id into strict origin_environment_id
            from public.runs where id = retired.originating_run_id;
          else
            select environment_id into strict origin_environment_id
            from public.trigger_occurrences where id = retired.originating_occurrence_id;
          end if;

          update public.workspaces
          set event_sequence = event_sequence + 1, updated_at = retired_at
          where id = retired.originating_workspace_id
          returning event_sequence into strict next_sequence;

          insert into public.workspace_events(
            sequence, event_id, workspace_id, thread_id, run_id, environment_id,
            type, data, created_at
          ) values (
            next_sequence, 'evt_' || gen_random_uuid()::text,
            retired.originating_workspace_id, retired.originating_thread_id,
            retired.originating_run_id, origin_environment_id, 'request.cancelled',
            jsonb_build_object(
              'requestId', retired.id,
              'reason', 'authority-revoked'
            ),
            retired_at
          );
        end loop;
      end $$;

      delete from public.notification_outbox
      where request_id in (
        select id from public.requests
        where kind = 'browser.profile.import' and status = 'cancelled'
      ) and published_at is null;

      drop table public.browser_source_imports;
      drop table public.browser_source_grants;
      drop table public.browser_source_pairings;
      drop table public.browser_sources;
    `.execute(database);
  },
};

/** Re-enable the source tables after the released retirement migration. */
export const browserSourcesRestorationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.browser_sources (
        id text primary key check (id ~ '^bsr_[0-9a-f-]{36}$'),
        owner_id text not null references public.users(id) on delete cascade,
        name text not null check (length(name) between 1 and 120),
        token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
        generation integer not null default 1 check (generation > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create index browser_sources_owner on public.browser_sources(owner_id) where revoked_at is null;

      create table public.browser_source_pairings (
        code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
        owner_id text not null references public.users(id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz,
        canonical_origin text not null,
        remote_origin text,
        remote_generation integer,
        check ((remote_origin is null) = (remote_generation is null)),
        check (expires_at > created_at)
      );
      create index browser_source_pairings_expiry on public.browser_source_pairings(expires_at);

      create table public.browser_source_grants (
        id uuid primary key,
        source_id text not null references public.browser_sources(id) on delete cascade,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        site text not null check (length(site) between 1 and 2048),
        access text not null check (access in ('inspect', 'import')),
        created_by text not null references public.users(id) on delete cascade,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create unique index browser_source_grants_active on public.browser_source_grants(source_id, workspace_id, site)
        where revoked_at is null;
      create index browser_source_grants_workspace on public.browser_source_grants(workspace_id, created_by)
        where revoked_at is null;

      create table public.browser_source_imports (
        id uuid not null,
        source_id text not null references public.browser_sources(id),
        workspace_id text not null references public.workspaces(id),
        owner_id text not null references public.users(id),
        site text not null check (length(site) between 1 and 2048),
        profile_name text not null check (length(profile_name) between 1 and 120),
        remember boolean not null,
        profile_id text not null unique references public.browser_profiles(id),
        request_id text unique references public.requests(id),
        created_at timestamptz not null default now(),
        primary key (owner_id, id)
      );
      create index browser_source_imports_owner on public.browser_source_imports(owner_id, created_at);
    `.execute(database);
  },
};

/**
 * A Workspace's chosen icon. The name is validated by the Host against the
 * shared catalog rather than a database list, so adding artwork never needs a
 * migration; the column only bounds its size.
 */
export const workspaceIconMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.workspaces
        add column icon text check (icon is null or char_length(icon) between 1 and 64);
    `.execute(database);
  },
};

/**
 * Live browser sign-ins replace copying a Chrome login into a new profile.
 * v1 connections are revoked rather than converted: the v2 extension has a new
 * identity and storage, and a v1 grant named one source, so carrying it over
 * would widen what the person agreed to. Copied profiles stay ordinary profiles.
 */
export const browserSignInsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.browser_sources add column last_seen_at timestamptz;
      update public.browser_sources
      set revoked_at = now(), generation = generation + 1, updated_at = now()
      where revoked_at is null;
      delete from public.browser_source_pairings where consumed_at is null;
      drop table public.browser_source_grants;

      create table public.browser_site_grants (
        id uuid primary key,
        owner_id text not null references public.users(id) on delete cascade,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        site text not null check (length(site) <= 300 and site ~ '^https?://([a-z0-9_-]+(\\.[a-z0-9_-]+)*|\\[[0-9a-f:.]+\\])$'),
        preferred_source_id text references public.browser_sources(id) on delete set null,
        created_at timestamptz not null default now(),
        last_signed_in_at timestamptz,
        revoked_at timestamptz
      );
      create unique index browser_site_grants_active
        on public.browser_site_grants(owner_id, workspace_id, site) where revoked_at is null;

      create table public.browser_sign_ins (
        owner_id text not null references public.users(id) on delete cascade,
        id uuid not null,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        site text not null check (length(site) <= 300 and site ~ '^https?://([a-z0-9_-]+(\\.[a-z0-9_-]+)*|\\[[0-9a-f:.]+\\])$'),
        source_id text not null references public.browser_sources(id) on delete cascade,
        source_name text not null check (length(source_name) between 1 and 120),
        session_id text not null check (length(session_id) between 1 and 128),
        profile_name text check (length(profile_name) between 1 and 200),
        request_id text unique references public.requests(id) on delete cascade,
        actor text not null check (actor in ('agent', 'owner', 'request')),
        created_at timestamptz not null default now(),
        primary key (owner_id, id)
      );
      create index browser_sign_ins_owner on public.browser_sign_ins(owner_id, created_at);
    `.execute(database);
    for (const [table, names, anchor] of [
      [
        "agent_control_requests",
        ["agent_control_requests_action_check", "agent_control_requests_action_class_check"],
        "'browser.profile.import'::text",
      ],
      [
        "trigger_control_requests",
        ["trigger_control_requests_action_check", "trigger_control_requests_action_class_check"],
        "'browser.profile.import'::text",
      ],
      [
        "requests",
        ["requests_kind_check", "requests_kind_mode_check"],
        "'browser.profile.import'::text",
      ],
    ] as const) {
      for (const name of names) {
        const result = await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = ${`public.${table}`}::regclass and conname = ${name}
        `.execute(database);
        const definition = result.rows[0]?.definition;
        if (!definition?.includes(anchor)) throw new Error(`Cannot extend ${name} for sign-ins`);
        if (definition.includes("'browser.sign-in'::text")) continue;
        const next = definition.replaceAll(anchor, `${anchor}, 'browser.sign-in'::text`);
        await sql.raw(`alter table public.${table} drop constraint ${name}`).execute(database);
        await sql
          .raw(`alter table public.${table} add constraint ${name} ${next}`)
          .execute(database);
      }
    }
    // A pending copy Request can no longer be answered. It is declined for the
    // requester, so the Run that asked gets a continuation naming the new tool
    // instead of waiting forever on a card no client renders any more.
    await sql`
      do $$
      declare
        retired record;
        retired_at timestamptz := now();
        retired_iso text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        retired_response jsonb := '{"kind":"external","value":{"decision":"declined","replacedBy":"browser.sign-in"}}'::jsonb;
        origin_environment_id text;
        next_sequence bigint;
      begin
        for retired in
          select * from public.requests
          where kind = 'browser.profile.import' and status = 'pending'
          order by id
          for update
        loop
          if retired.response_command_id is not null then
            update public.commands
            set last_error = '{"message":"The Request was declined before its response completed"}'::jsonb,
                status = 'failed',
                updated_at = retired_at
            where id = retired.response_command_id
              and type = 'request.respond'
              and status in ('pending', 'dispatched', 'unknown');
          end if;

          update public.requests
          set status = 'declined',
              response = retired_response,
              resolved_at = retired_at,
              resolved_by = retired.requested_by,
              response_command_id = null
          where id = retired.id and status = 'pending';

          insert into public.request_continuations(request_id, status, created_at, updated_at)
          values (retired.id, 'waiting', retired_at, retired_at)
          on conflict (request_id) do nothing;

          if retired.originating_run_id is not null then
            select environment_id into strict origin_environment_id
            from public.runs where id = retired.originating_run_id;
          else
            select environment_id into strict origin_environment_id
            from public.trigger_occurrences where id = retired.originating_occurrence_id;
          end if;

          update public.workspaces
          set event_sequence = event_sequence + 1, updated_at = retired_at
          where id = retired.originating_workspace_id
          returning event_sequence into strict next_sequence;

          insert into public.workspace_events(
            sequence, event_id, workspace_id, thread_id, run_id, environment_id,
            type, data, created_at
          ) values (
            next_sequence, 'evt_' || gen_random_uuid()::text,
            retired.originating_workspace_id, retired.originating_thread_id,
            retired.originating_run_id, origin_environment_id, 'request.resolved',
            jsonb_build_object('request', jsonb_build_object(
              'callId', retired.call_id,
              'cancellationReason', null,
              'createdAt', to_char(retired.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'id', retired.id,
              'kind', retired.kind,
              'mode', retired.mode,
              'originatingOccurrenceId', retired.originating_occurrence_id,
              'originatingRunId', retired.originating_run_id,
              'originatingThreadId', retired.originating_thread_id,
              'originatingWorkspaceId', retired.originating_workspace_id,
              'payload', retired.payload,
              'presentation', retired.presentation,
              'requestedBy', retired.requested_by,
              'requiredActor', retired.required_actor,
              'resolvedAt', retired_iso,
              'resolvedBy', retired.requested_by,
              'response', retired_response,
              'status', 'declined',
              'targetWorkspaceId', retired.target_workspace_id
            )),
            retired_at
          );
        end loop;
      end $$;

      delete from public.notification_outbox
      where published_at is null and request_id in (
        select id from public.requests
        where kind = 'browser.profile.import' and response @> '{"value":{"replacedBy":"browser.sign-in"}}'::jsonb
      );
    `.execute(database);
  },
};

/**
 * A person can rearrange what waits in a Thread's queue, so the order work is
 * taken in stops being the order its Messages were written. Existing inputs
 * keep the order they were sent in. The work view is re-expanded so admission
 * reads the new column.
 */
export const threadInputQueueOrderMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.thread_inputs add column queue_rank bigint;
      update public.thread_inputs as input
        set queue_rank = message.sequence
        from public.messages as message
        where message.id = input.message_id;
      alter table public.thread_inputs alter column queue_rank set not null;
      create or replace view public.thread_work_inputs as
        select * from public.thread_inputs where policy = 'queue';
      create index thread_inputs_waiting_order
        on public.thread_inputs(thread_id, queue_rank)
        where policy = 'queue' and state = 'pending';
    `.execute(database);
  },
};

const baselineMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql.raw(BASELINE_SCHEMA_SQL).execute(database);
    await sql`
      insert into public.principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
    `.execute(database);
    await sql`
      insert into public.personal_remote_access(singleton_key, mode, generation, route_origin)
      values ('personal', 'off', 0, null)
    `.execute(database);
  },
};

/**
 * Tool identity became a provider-neutral pair in protocol v3. Historical
 * events are rewritten once so every durable replay has the same canonical
 * shape as a live event; runtime readers never carry a legacy parser.
 */
const canonicalToolIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.workspace_events
      set data = (data - 'name') || jsonb_build_object(
        'tool',
        case
          when left(data->>'name', length('mcp:opensteer/')) = 'mcp:opensteer/' then jsonb_build_object(
            'namespace', 'opensteer',
            'name', substring(data->>'name' from length('mcp:opensteer/') + 1)
          )
          when left(data->>'name', length('mcp:opensteer_integrations/')) = 'mcp:opensteer_integrations/' then jsonb_build_object(
            'namespace', 'opensteer.integrations',
            'name', substring(data->>'name' from length('mcp:opensteer_integrations/') + 1)
          )
          when left(data->>'name', length('dynamic:opensteer/')) = 'dynamic:opensteer/' then jsonb_build_object(
            'namespace', 'opensteer',
            'name', substring(data->>'name' from length('dynamic:opensteer/') + 1)
          )
          when left(data->>'name', length('dynamic:opensteer_integrations/')) = 'dynamic:opensteer_integrations/' then jsonb_build_object(
            'namespace', 'opensteer.integrations',
            'name', substring(data->>'name' from length('dynamic:opensteer_integrations/') + 1)
          )
          when left(data->>'name', length('mcp__opensteer__')) = 'mcp__opensteer__' then jsonb_build_object(
            'namespace', 'opensteer',
            'name', substring(data->>'name' from length('mcp__opensteer__') + 1)
          )
          when left(data->>'name', length('mcp__opensteer_integrations__')) = 'mcp__opensteer_integrations__' then jsonb_build_object(
            'namespace', 'opensteer.integrations',
            'name', substring(data->>'name' from length('mcp__opensteer_integrations__') + 1)
          )
          when left(data->>'name', length('mcp__')) = 'mcp__'
            and strpos(substring(data->>'name' from length('mcp__') + 1), '__') > 1
          then jsonb_build_object(
            'namespace', 'mcp:' || split_part(
              substring(data->>'name' from length('mcp__') + 1), '__', 1
            ),
            'name', substring(
              substring(data->>'name' from length('mcp__') + 1)
              from strpos(substring(data->>'name' from length('mcp__') + 1), '__') + 2
            )
          )
          when left(data->>'name', length('codex:')) = 'codex:' then jsonb_build_object(
            'namespace', 'codex.collaboration',
            'name', substring(data->>'name' from length('codex:') + 1)
          )
          when data->>'name' in ('shell', 'apply_patch', 'web_search', 'view_image') then
            jsonb_build_object('namespace', 'codex', 'name', data->>'name')
          when data->>'name' in (
            'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep',
            'NotebookEdit', 'Read', 'Skill', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write'
          ) then jsonb_build_object('namespace', 'claude', 'name', data->>'name')
          when left(data->>'name', length('mcp:')) = 'mcp:'
            and strpos(data->>'name', '/') > length('mcp:') + 1
          then jsonb_build_object(
            'namespace', split_part(data->>'name', '/', 1),
            'name', substring(data->>'name' from strpos(data->>'name', '/') + 1)
          )
          when left(data->>'name', length('dynamic:')) = 'dynamic:'
            and strpos(data->>'name', '/') > length('dynamic:') + 1
          then jsonb_build_object(
            'namespace', split_part(data->>'name', '/', 1),
            'name', substring(data->>'name' from strpos(data->>'name', '/') + 1)
          )
          when left(data->>'name', length('dynamic:')) = 'dynamic:' then jsonb_build_object(
            'namespace', 'codex.dynamic',
            'name', substring(data->>'name' from length('dynamic:') + 1)
          )
          else jsonb_build_object('namespace', 'legacy', 'name', data->>'name')
        end
      )
      where type = 'tool.started' and data ? 'name' and not (data ? 'tool')
    `.execute(database);
  },
};

/**
 * OAuth authority moved from mutable per-connection capabilities to the
 * immutable integration definition. Opensteer has no production integration
 * users yet, so retire the old provider connections instead of preserving a
 * second compatibility model. Catalog installations are reconciled normally;
 * the two bundled definitions that were replaced by per-service presets are
 * removed explicitly so they cannot survive as orphaned installations.
 */
const fixedIntegrationAuthorizationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create temporary table retired_integration_credentials on commit drop as
      select distinct credential_id as id
      from public.integration_connections
      where connection_kind = 'provider-account' and credential_id is not null
    `.execute(database);
    await sql`
      create temporary table retired_integration_installations on commit drop as
      select id
      from public.integration_installations
      where source_kind = 'built-in'
        and provenance ->> 'definitionId' in ('google', 'microsoft-graph')
    `.execute(database);

    await sql`
      delete from public.credential_access_audit
      where connection_id in (
        select id from public.integration_connections where connection_kind = 'provider-account'
      )
    `.execute(database);
    await sql`
      delete from public.integration_grants
      where connection_id in (
        select id from public.integration_connections where connection_kind = 'provider-account'
      )
      or installation_id in (select id from retired_integration_installations)
    `.execute(database);
    await sql`
      update public.integration_tools
      set connection_id = null
      where connection_id in (
        select id from public.integration_connections where connection_kind = 'provider-account'
      )
    `.execute(database);
    await sql`
      delete from public.integration_connections where connection_kind = 'provider-account'
    `.execute(database);
    await sql`
      delete from public.credentials
      where id in (select id from retired_integration_credentials)
        and not exists (
          select 1 from public.integration_connections
          where integration_connections.credential_id = credentials.id
        )
        and not exists (
          select 1 from public.credential_access_audit
          where credential_access_audit.credential_id = credentials.id
        )
    `.execute(database);

    // Request details reference an installation with ON DELETE RESTRICT, so
    // they have to go before the installations they name.
    await sql`
      delete from public.integration_request_details
      where installation_id in (select id from retired_integration_installations)
    `.execute(database);
    await sql`
      delete from public.integration_tools
      where server_id in (
        select id from public.integration_servers
        where installation_id in (select id from retired_integration_installations)
      )
    `.execute(database);
    await sql`
      delete from public.integration_skills
      where installation_id in (select id from retired_integration_installations)
    `.execute(database);
    await sql`
      delete from public.integration_servers
      where installation_id in (select id from retired_integration_installations)
    `.execute(database);
    await sql`
      delete from public.integration_installations
      where id in (select id from retired_integration_installations)
    `.execute(database);

    await sql`
      alter table public.integration_connections
      add column if not exists authorization_digest text
    `.execute(database);
    await sql`
      alter table public.integration_connections
      drop constraint if exists integration_connections_authorization_digest_check,
      add constraint integration_connections_authorization_digest_check check (
        connection_kind <> 'provider-account'
        or (
          authorization_digest is not null
          and octet_length(authorization_digest) = 43
          and authorization_digest ~ '^[A-Za-z0-9_-]{43}$'
        )
      )
    `.execute(database);
    await sql`
      alter table public.integration_tools drop column if exists required_capabilities
    `.execute(database);
  },
};

/**
 * Protocol v4 makes tool output a bounded, textual Opensteer value. Rewrite
 * history once so live events and replayed events have exactly one contract.
 */
const canonicalToolOutputMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const typedDatabase = database as Kysely<DatabaseSchema>;
    let cursor: EventId | undefined;
    for (;;) {
      let query = typedDatabase
        .selectFrom("workspaceEvents")
        .select(["eventId", "type", "data"])
        .where("type", "in", ["tool.completed", "tool.delta"])
        .orderBy("eventId")
        .limit(500);
      if (cursor) query = query.where("eventId", ">", cursor);
      const rows = await query.execute();
      if (rows.length === 0) break;

      for (const row of rows) {
        const data = isRecord(row.data) ? row.data : {};
        const canonicalData =
          row.type === "tool.completed"
            ? {
                ...data,
                output: ToolOutputSchema.safeParse(data.output).success
                  ? data.output
                  : normalizeToolOutput(legacyToolOutput(data.output)),
              }
            : {
                ...withoutKey(data, "delta"),
                text:
                  typeof data.text === "string"
                    ? normalizeToolOutput(data.text).text
                    : normalizeToolOutput(data.delta).text,
              };
        await typedDatabase
          .updateTable("workspaceEvents")
          .set({ data: jsonValue(canonicalData) })
          .where("eventId", "=", row.eventId)
          .execute();
      }
      cursor = rows.at(-1)!.eventId;
    }
  },
};

/**
 * Authorization is a durable handoff, so its terminal result must identify the
 * exact connection it created or refreshed. Consumers can then continue with
 * that account without guessing from a newly reordered account list.
 */
const authorizationResultConnectionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_auth_attempts
      add column if not exists result_connection_id text references public.integration_connections(id) on delete set null
    `.execute(database);
  },
};

/**
 * Harness instances became profiles of one logical execution environment. The
 * pre-launch global rows are expanded once so existing development Threads keep
 * their exact environment/profile pairing without carrying a compatibility
 * model into runtime code. Removal becomes a `removed_at` tombstone in the same
 * step, because archived Threads keep pointing at the profile that ran them.
 */
export const environmentHarnessInstancesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.harness_instances
        add column if not exists environment_id text,
        add column if not exists state_kind text,
        add column if not exists runtime_revision integer default 1,
        add column if not exists removed_at timestamptz
    `.execute(database);
    // A legacy instance was global, so its environment has to be recovered from
    // the work it actually did. Crossing every instance against every
    // environment would invent isolated cloud profiles nobody configured and —
    // where two legacy rows shared a driver — two ambient profiles on one
    // environment, which the unique index below would then refuse, aborting the
    // whole migration. Only observed pairings are carried over; the Host's
    // default-harness seeding supplies whatever an environment is missing on
    // its next boot.
    await sql`
      create temporary table harness_instance_environment_pair on commit drop as
      select distinct harness.id as old_id, used.environment_id
      from public.harness_instances harness
      join (
        select harness_instance_id, environment_id from public.threads
        union
        select harness_instance_id, environment_id from public.runs
        union
        select harness_instance_id, environment_id from public.harness_catalogs
        union
        select session.harness_instance_id, thread.environment_id
        from public.provider_sessions session
        join public.threads thread on thread.id = session.thread_id
      ) used on used.harness_instance_id = harness.id
      join public.execution_environments environment on environment.id = used.environment_id
      where harness.environment_id is null
    `.execute(database);
    // One environment admits at most one ambient profile per driver. Where a
    // driver has several legacy rows on the same environment, the oldest keeps
    // the machine's existing CLI and the rest become isolated profiles.
    await sql`
      create temporary table harness_instance_environment_map on commit drop as
      select
        pair.old_id,
        pair.environment_id,
        case
          when row_number() over (
            partition by pair.old_id order by harness.created_at, pair.environment_id
          ) = 1 then pair.old_id
          else 'hin_' || gen_random_uuid()::text
        end as new_id,
        case
          when environment.kind <> 'managed'
            and row_number() over (
              partition by pair.environment_id, harness.driver_kind
              order by harness.created_at, harness.id
            ) = 1
          then 'ambient'
          else 'isolated'
        end as state_kind
      from harness_instance_environment_pair pair
      join public.harness_instances harness on harness.id = pair.old_id
      join public.execution_environments environment on environment.id = pair.environment_id
    `.execute(database);
    await sql`
      insert into public.harness_instances(
        id, environment_id, driver_kind, name, config, state_kind,
        enabled, created_at, updated_at
      )
      select
        mapping.new_id, mapping.environment_id, harness.driver_kind, harness.name,
        harness.config, mapping.state_kind, harness.enabled,
        harness.created_at, harness.updated_at
      from harness_instance_environment_map mapping
      join public.harness_instances harness on harness.id = mapping.old_id
      where mapping.new_id <> mapping.old_id
    `.execute(database);
    await sql`
      update public.harness_instances harness
      set environment_id = mapping.environment_id,
          state_kind = mapping.state_kind
      from harness_instance_environment_map mapping
      where mapping.old_id = harness.id and mapping.new_id = mapping.old_id
    `.execute(database);
    await sql`
      update public.threads thread
      set harness_instance_id = mapping.new_id
      from harness_instance_environment_map mapping
      where mapping.old_id = thread.harness_instance_id
        and mapping.environment_id = thread.environment_id
    `.execute(database);
    await sql`
      update public.runs run
      set harness_instance_id = mapping.new_id
      from harness_instance_environment_map mapping
      where mapping.old_id = run.harness_instance_id
        and mapping.environment_id = run.environment_id
    `.execute(database);
    // A stopped session records which profile produced it, so it is remapped
    // through the same pairing as its Thread rather than rewritten to whatever
    // profile the Thread currently selects — otherwise history would claim the
    // Thread's newest engine ran everything it ever ran.
    await sql`
      update public.provider_sessions session
      set harness_instance_id = mapping.new_id
      from public.threads thread, harness_instance_environment_map mapping
      where thread.id = session.thread_id
        and mapping.old_id = session.harness_instance_id
        and mapping.environment_id = thread.environment_id
        and mapping.new_id <> mapping.old_id
    `.execute(database);
    await sql`
      update public.harness_catalogs catalog
      set harness_instance_id = mapping.new_id
      from harness_instance_environment_map mapping
      where mapping.old_id = catalog.harness_instance_id
        and mapping.environment_id = catalog.environment_id
    `.execute(database);
    // Anything still unpaired is a legacy row no Thread, Run, session, or
    // catalog ever used, and it has no environment to belong to. An older Host
    // eagerly created two pristine built-ins before it knew any environment;
    // those exact rows carry no user state and the new Host will seed their
    // environment-scoped replacements on Runner registration. Any other row in
    // an environment-less deployment may contain user configuration, so refuse
    // to guess at an owner or silently discard it.
    await sql`
      do $$ begin
        if not exists (select 1 from public.execution_environments)
           and exists (
             select 1
             from public.harness_instances
             where environment_id is null
               and not (
                 (
                   id = 'hin_00000000-0000-4000-8000-000000000001'
                   and driver_kind = 'codex'
                   and name = 'Codex'
                   and config = '{"model":"gpt-5.6-sol","modelProviderId":"openai"}'::jsonb
                   and enabled
                 )
                 or (
                   id = 'hin_00000000-0000-4000-8000-000000000002'
                   and driver_kind = 'claude'
                   and name = 'Claude Code'
                   and config = '{"model":"sonnet","modelProviderId":"anthropic"}'::jsonb
                   and enabled
                 )
               )
           ) then
          raise exception
            'cannot scope harness instances: the deployment has no execution environments';
        end if;
      end $$
    `.execute(database);
    await sql`
      delete from public.harness_instances harness
      where harness.environment_id is null
    `.execute(database);
    await sql`
      alter table public.harness_instances
        alter column environment_id set not null,
        alter column state_kind set not null,
        alter column runtime_revision set not null
    `.execute(database);
    await sql`
      do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'harness_instances_state_kind_check') then
          alter table public.harness_instances add constraint harness_instances_state_kind_check
            check (state_kind in ('ambient', 'isolated'));
        end if;
        if not exists (select 1 from pg_constraint where conname = 'harness_instances_runtime_revision_check') then
          alter table public.harness_instances add constraint harness_instances_runtime_revision_check
            check (runtime_revision >= 1);
        end if;
        if not exists (select 1 from pg_constraint where conname = 'harness_instances_removed_disabled_check') then
          alter table public.harness_instances add constraint harness_instances_removed_disabled_check
            check (removed_at is null or enabled = false);
        end if;
        if not exists (select 1 from pg_constraint where conname = 'harness_instances_environment_id_fkey') then
          alter table public.harness_instances add constraint harness_instances_environment_id_fkey
            foreign key (environment_id) references public.execution_environments(id) on delete restrict;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'harness_instances_id_environment_key') then
          alter table public.harness_instances add constraint harness_instances_id_environment_key
            unique (id, environment_id);
        end if;
      end $$
    `.execute(database);
    await sql`
      alter table public.harness_catalogs
        drop constraint if exists harness_catalogs_harness_instance_id_fkey,
        drop constraint if exists harness_catalogs_harness_instance_environment_fkey
    `.execute(database);
    await sql`
      alter table public.threads
        drop constraint if exists threads_harness_instance_id_fkey,
        drop constraint if exists threads_harness_instance_environment_fkey
    `.execute(database);
    await sql`
      alter table public.threads
        add constraint threads_harness_instance_environment_fkey
        foreign key (harness_instance_id, environment_id)
        references public.harness_instances(id, environment_id) on delete restrict
    `.execute(database);
    await sql`
      alter table public.runs
        drop constraint if exists runs_harness_instance_id_fkey,
        drop constraint if exists runs_harness_instance_environment_fkey
    `.execute(database);
    await sql`
      alter table public.runs
        add constraint runs_harness_instance_environment_fkey
        foreign key (harness_instance_id, environment_id)
        references public.harness_instances(id, environment_id) on delete restrict
    `.execute(database);
    await sql`
      alter table public.harness_catalogs
        add constraint harness_catalogs_harness_instance_environment_fkey
        foreign key (harness_instance_id, environment_id)
        references public.harness_instances(id, environment_id) on delete cascade
    `.execute(database);
    // A profile is retired by tombstone rather than deletion, so both indexes
    // are scoped to live rows: a removed ambient profile must not keep its
    // driver's ambient slot occupied on that environment.
    await sql`
      create unique index if not exists harness_instances_one_ambient_per_driver
      on public.harness_instances(environment_id, driver_kind)
      where state_kind = 'ambient' and removed_at is null
    `.execute(database);
    await sql`
      create index if not exists harness_instances_environment
      on public.harness_instances(environment_id, created_at) where removed_at is null
    `.execute(database);
    await sql`
      do $$ begin
        if not exists (
          select 1 from pg_constraint where conname = 'provider_sessions_harness_instance_id_fkey'
        ) then
          alter table public.provider_sessions
            add constraint provider_sessions_harness_instance_id_fkey
            foreign key (harness_instance_id) references public.harness_instances(id)
            on delete restrict;
        end if;
      end $$
    `.execute(database);
    await sql`
      create or replace function public.opensteer_prevent_harness_instance_identity_change()
      returns trigger language plpgsql as $$
      begin
        if new.environment_id is distinct from old.environment_id
           or new.driver_kind is distinct from old.driver_kind
           or new.state_kind is distinct from old.state_kind then
          raise exception 'harness instance environment, driver, and state kind are immutable';
        end if;
        if new.runtime_revision < old.runtime_revision then
          raise exception 'harness runtime revision cannot decrease';
        end if;
        if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
          raise exception 'a removed harness instance cannot be restored';
        end if;
        return new;
      end $$
    `.execute(database);
    await sql`drop trigger if exists harness_instances_immutable_identity on public.harness_instances`.execute(
      database,
    );
    await sql`
      create trigger harness_instances_immutable_identity
      before update of environment_id, driver_kind, state_kind, runtime_revision, removed_at
      on public.harness_instances for each row
      execute function public.opensteer_prevent_harness_instance_identity_change()
    `.execute(database);
  },
};

function legacyToolOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of [
    "formattedOutput",
    "aggregatedOutput",
    "aggregated_output",
    "output",
    "result",
    "contentItems",
    "stdout",
    "stderr",
    "message",
  ]) {
    if (value[key] !== undefined) return value[key];
  }
  return value;
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

/**
 * Desktop protocol v5 binds each native OAuth callback to the application's
 * owned bundle-id scheme. The managed client is derived configuration, not
 * user data, so retire the old client and its cascading grants once; Host
 * startup then recreates the exact configured authority. Arbitrary OAuth
 * clients are deliberately untouched.
 */
export const ownedNativeOAuthCallbackMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      delete from public.host_oauth_clients
      where reference_id = 'opensteer-native-client'
         or reference_id like 'opensteer-native-client:%'
    `.execute(database);
  },
};

/**
 * A Host owns a link before the Account directory activates it. The column has
 * no default: every writer knows which half of that two-phase link it is
 * committing, and a default would silently mint an active link for a row that
 * was never activated centrally.
 */
const personalAccountLinkActivationStateMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.personal_remote_account_link
      add column state text not null
    `.execute(database);
    await sql`
      alter table public.personal_remote_account_link
      add constraint personal_remote_account_link_state_check
      check (state in ('activating', 'active'))
    `.execute(database);
  },
};

/**
 * The released 0.1.15 ordinal. The regenerated baseline already declares the
 * column, so this only catches up a database created before it; it keeps its
 * released name because Kysely refuses to migrate a database that recorded a
 * migration the code no longer offers.
 */
const integrationAccountIdentifierMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_connections
      add column if not exists account_identifier text
    `.execute(database);
    await sql`
      alter table public.integration_connections
      drop constraint if exists integration_connections_account_identifier_check,
      add constraint integration_connections_account_identifier_check check (
        account_identifier is null
        or (
          octet_length(account_identifier) >= 1
          and octet_length(account_identifier) <= 1280
        )
      )
    `.execute(database);
  },
};

/** Deployment authority persists independent behavioral facts, not a preset name. */
const deploymentAxesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const legacyColumn = await sql<{ exists: boolean }>`
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'deployments'
          and column_name = 'workspace_profile'
      ) as exists
    `.execute(database);
    if (legacyColumn.rows[0]?.exists) {
      await sql`
        do $$ begin
          if exists (
            select 1 from public.deployments where workspace_profile->>'mode' = 'cloud'
          ) then
            raise exception 'Cloud deployment rows must be removed before deployment axis migration';
          end if;
        end $$
      `.execute(database);
      await sql`
        alter table public.deployments
        drop constraint deployments_workspace_profile_shape_check
      `.execute(database);
      await sql`
        alter table public.deployments rename column workspace_profile to deployment_shape
      `.execute(database);
      await sql`
        update public.deployments
        set deployment_shape = jsonb_build_object(
          'backing', deployment_shape->>'backing',
          'ownerEstablishment', case
            when deployment_shape->>'mode' in ('personal', 'development') then 'self-claim'
            else 'enrollment'
          end,
          'tenancy', case
            when deployment_shape->>'mode' = 'personal' then 'single-user'
            else 'multi-user'
          end
        )
      `.execute(database);
      await sql`
        alter table public.deployments
        add constraint deployments_shape_check check (
          jsonb_typeof(deployment_shape) = 'object'
          and deployment_shape ?& array['backing', 'ownerEstablishment', 'tenancy']
          and deployment_shape - array['backing', 'ownerEstablishment', 'tenancy'] = '{}'::jsonb
          and deployment_shape->>'backing' = any (array['local-directory', 'portablefs'])
          and deployment_shape->>'ownerEstablishment' = any (array['self-claim', 'enrollment'])
          and deployment_shape->>'tenancy' = any (array['single-user', 'multi-user'])
        )
      `.execute(database);
    }
    await sql`
      create or replace function public.opensteer_user_can_execute_environment(
        p_environment_id text,
        p_user_id text
      ) returns boolean
      language sql stable
      as $$
        select exists (
          select 1
          from execution_environments environment
          join runners runner on runner.id = environment.runner_id
          where environment.id = p_environment_id
            and runner.revoked_at is null
            and (
              runner.kind <> 'managed'
              or runner.owner_user_id is null
              or runner.owner_user_id = p_user_id
            )
            and (
              (
                runner.owner_kind = 'deployment'
                and (
                  exists (
                    select 1 from deployments deployment
                    where deployment.singleton_key = 'primary'
                      and deployment.deployment_shape->>'tenancy' <> 'single-user'
                  )
                  or (
                    exists (
                      select 1 from deployments deployment
                      where deployment.singleton_key = 'primary'
                        and deployment.deployment_shape->>'tenancy' = 'single-user'
                    )
                    and exists (
                      select 1 from users actor
                      where actor.id = p_user_id
                        and actor.instance_role = 'administrator'
                    )
                  )
                )
              )
              or (runner.owner_kind = 'user' and runner.owner_user_id = p_user_id)
            )
        )
      $$
    `.execute(database);
  },
};

/**
 * A Trigger Occurrence runs no Run, so a Request could not originate from one
 * while `originating_run_id` was mandatory. The origin becomes a nullable pair
 * with an exactly-one CHECK, and call identity becomes one partial unique index
 * per origin column — a single UNIQUE over both would let NULLs, which Postgres
 * treats as distinct, admit duplicate call identities on either side. A live
 * Request is answered back into the process that opened it, so it stays
 * Run-only.
 */
export const triggerOriginatedRequestsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.requests
        alter column originating_run_id drop not null,
        add column if not exists originating_occurrence_id text
    `.execute(database);
    await sql`
      alter table public.requests
      drop constraint if exists requests_originating_occurrence_id_fkey,
      add constraint requests_originating_occurrence_id_fkey
        foreign key (originating_occurrence_id)
        references public.trigger_occurrences(id) on delete restrict
    `.execute(database);
    await sql`
      alter table public.requests
      drop constraint if exists requests_origin_check,
      add constraint requests_origin_check check (
        num_nonnulls(originating_run_id, originating_occurrence_id) = 1
        and (mode <> 'live' or originating_run_id is not null)
      )
    `.execute(database);
    await sql`
      alter table public.requests drop constraint if exists requests_call_identity_unique
    `.execute(database);
    await sql`
      create unique index if not exists requests_run_call_identity_unique
      on public.requests(originating_run_id, call_id)
      where originating_run_id is not null
    `.execute(database);
    await sql`
      create unique index if not exists requests_occurrence_call_identity_unique
      on public.requests(originating_occurrence_id, call_id)
      where originating_occurrence_id is not null
    `.execute(database);
  },
};

/** Deployment kind replaces derivable tenancy/owner axes; Host identity has no generation. */
export const deploymentKindAndHostIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.deployments drop constraint if exists deployments_shape_check
    `.execute(database);
    await sql`
      update public.deployments
      set deployment_shape = jsonb_build_object(
        'backing', deployment_shape->>'backing',
        'kind', case
          when deployment_shape->>'tenancy' = 'single-user' then 'personal'
          else 'server'
        end
      )
    `.execute(database);
    await sql`
      alter table public.deployments
      add constraint deployments_shape_check check (
        jsonb_typeof(deployment_shape) = 'object'
        and deployment_shape ?& array['backing', 'kind']
        and deployment_shape - array['backing', 'kind'] = '{}'::jsonb
        and deployment_shape->>'backing' = any (array['local-directory', 'portablefs'])
        and deployment_shape->>'kind' = any (array['personal', 'server'])
      ),
      drop column authority_epoch
    `.execute(database);
    await sql`
      alter table public.host_account_adoption_proofs
      drop constraint if exists host_account_adoption_proofs_epoch_check,
      drop column authority_epoch
    `.execute(database);
    await sql`
      alter table public.auth_sessions
      drop constraint if exists auth_sessions_deployment_session_provenance_check,
      drop column grant_authority_epoch,
      add constraint auth_sessions_deployment_session_provenance_check check (
        (
          created_via is null
          and account_issuer is null
          and account_subject is null
          and grant_id is null
        )
        or (
          created_via = 'opensteer-deployment-session'
          and account_issuer is not null
          and account_subject is not null
          and grant_id is not null
        )
      )
    `.execute(database);
    await sql`
      create or replace function public.opensteer_user_can_execute_environment(
        p_environment_id text,
        p_user_id text
      ) returns boolean
      language sql stable
      as $$
        select exists (
          select 1
          from execution_environments environment
          join runners runner on runner.id = environment.runner_id
          where environment.id = p_environment_id
            and runner.revoked_at is null
            and (
              runner.kind <> 'managed'
              or runner.owner_user_id is null
              or runner.owner_user_id = p_user_id
            )
            and (
              (
                runner.owner_kind = 'deployment'
                and (
                  exists (
                    select 1 from deployments deployment
                    where deployment.singleton_key = 'primary'
                      and deployment.deployment_shape->>'kind' = 'server'
                  )
                  or (
                    exists (
                      select 1 from deployments deployment
                      where deployment.singleton_key = 'primary'
                        and deployment.deployment_shape->>'kind' = 'personal'
                    )
                    and exists (
                      select 1 from users actor
                      where actor.id = p_user_id
                        and actor.instance_role = 'administrator'
                    )
                  )
                )
              )
              or (runner.owner_kind = 'user' and runner.owner_user_id = p_user_id)
            )
        )
      $$
    `.execute(database);
  },
};

/** Integration consent follows derived operation effects instead of schema-bound selections. */
export const integrationAccessClassMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_grants add column access text not null default 'read';
      update public.integration_grants grant_row set access = 'read-write'
      where exists (
        select 1 from jsonb_array_elements(grant_row.granted_tools) binding
        join public.integration_tools tool on tool.id = binding->>'toolId'
        where coalesce((tool.annotations->>'readOnlyHint')::boolean, false) is not true
      );
      update public.integration_grants set status = 'active' where status = 'needs-reapproval'
    `.execute(database);
    await sql`
      alter table public.integration_grants
        drop constraint if exists integration_grants_components,
        drop constraint if exists integration_grants_status_check,
        drop column granted_tools,
        drop column granted_skills,
        alter column access drop default,
        add constraint integration_grants_access_check
          check (access = any (array['read'::text, 'read-write'::text])),
        add constraint integration_grants_status_check
          check (status = any (array['active'::text, 'revoked'::text]))
    `.execute(database);
    await sql`
      alter table public.integration_request_details add column access text;
      update public.integration_request_details detail set access = 'read'
      from public.requests request_row
      where request_row.id = detail.request_id and request_row.kind = 'integration.access';
      update public.integration_request_details detail set access = 'read-write'
      from public.requests request_row
      where request_row.id = detail.request_id
        and request_row.kind = 'integration.access'
        and exists (
          select 1 from jsonb_array_elements(detail.required_tools) binding
          join public.integration_tools tool on tool.id = binding->>'toolId'
          where coalesce((tool.annotations->>'readOnlyHint')::boolean, false) is not true
        );
      update public.requests request_row
      set payload = (request_row.payload - 'requiredTools' - 'requiredSkills')
        || jsonb_build_object('access', coalesce(detail.access, 'read'))
      from public.integration_request_details detail
      where detail.request_id = request_row.id and request_row.kind = 'integration.access'
    `.execute(database);
    await sql`
      with ranked as (
        select request_row.id, row_number() over (
          partition by request_row.target_workspace_id, request_row.requested_by,
            detail.installation_id, detail.access
          order by request_row.created_at asc, request_row.id asc
        ) as position
        from public.requests request_row
        join public.integration_request_details detail on detail.request_id = request_row.id
        where request_row.kind = 'integration.access' and request_row.status = 'pending'
      ),
      duplicates as (select id from ranked where position > 1),
      -- A duplicate may still carry an in-flight respond command; it fails the
      -- way cancelPending fails it, so the command never resolves a cancelled row.
      failed_commands as (
        update public.commands command_row
        set status = 'failed', updated_at = now(),
          last_error = jsonb_build_object(
            'message', 'The Request was cancelled before its response completed'
          )
        from public.requests request_row
        where request_row.id in (select id from duplicates)
          and command_row.id = request_row.response_command_id
          and command_row.type = 'request.respond'
          and command_row.status in ('pending', 'dispatched', 'unknown')
        returning command_row.id
      ),
      cancelled as (
        update public.requests request_row
        set status = 'cancelled', cancellation_reason = 'authority-revoked',
          resolved_at = now(), resolved_by = null, response = null, response_command_id = null
        where request_row.id in (select id from duplicates)
        returning request_row.id
      )
      delete from public.request_continuations continuation
      where continuation.request_id in (select id from cancelled)
    `.execute(database);
    // A pending ask that an active grant already covers is answered the way the
    // human would answer it, and its durable continuation is queued so the
    // originating thread learns the outcome exactly as it would at runtime.
    await sql`
      with covered as (
        update public.requests request_row
        set status = 'fulfilled', resolved_at = now(), resolved_by = grant_row.owner_user_id,
          response = jsonb_build_object(
            'kind', 'external',
            'value', jsonb_build_object(
              'access', grant_row.access, 'alias', grant_row.alias,
              'connectionId', grant_row.connection_id, 'decision', 'fulfilled',
              'isDefault', grant_row.is_default
            )
          )
        from public.integration_request_details detail, public.integration_grants grant_row
        where detail.request_id = request_row.id
          and request_row.kind = 'integration.access' and request_row.status = 'pending'
          and grant_row.workspace_id = request_row.target_workspace_id
          and grant_row.owner_user_id = request_row.requested_by
          and grant_row.installation_id = detail.installation_id
          and grant_row.status = 'active' and grant_row.revoked_at is null
          and (grant_row.access = 'read-write' or detail.access = 'read')
        returning request_row.id, request_row.mode
      )
      insert into public.request_continuations(request_id)
      select id from covered where mode = 'durable'
      on conflict (request_id) do nothing
    `.execute(database);
    await sql`
      alter table public.integration_request_details
        drop constraint if exists integration_request_details_components_check,
        drop column required_skills,
        drop column required_tools,
        add constraint integration_request_details_access_check
          check (access is null or access = any (array['read'::text, 'read-write'::text]));
      create index if not exists integration_request_details_access_lookup
        on public.integration_request_details(installation_id, access)
    `.execute(database);
  },
};

/** Administrators belong to the Deployment before its first Workspace exists. */
export const administratorDirectoryProjectionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create or replace function public.opensteer_refresh_account_directory_user(
        target_user_id text
      ) returns void
      language plpgsql
      as $$
        declare
          target_present boolean;
          account record;
        begin
          select exists (
            select 1 from users u
            where u.id = target_user_id
              and u.disabled_at is null
              and (
                u.instance_role = 'administrator'
                or exists (
                  select 1 from workspace_memberships membership
                  where membership.user_id = u.id and membership.state = 'active'
                )
              )
          ) into target_present;
          for account in
            select auth.provider_id, auth.account_id
            from auth_accounts auth
            inner join account_directory_provider provider
              on provider.singleton_key = 'opensteer-account'
             and provider.provider_id = auth.provider_id
            where auth.user_id = target_user_id and auth.password is null
          loop
            if target_present or exists (
              select 1 from account_directory_projections projection
              where projection.provider_id = account.provider_id
                and projection.account_id = account.account_id
            ) then
              perform opensteer_set_account_directory_projection(
                account.provider_id, account.account_id, target_user_id, target_present
              );
            end if;
          end loop;
        end
      $$;

      drop trigger users_account_directory_projection_update on public.users;
      create trigger users_account_directory_projection_update
      after update of disabled_at, instance_role on public.users
      for each row execute function public.opensteer_project_user_change();

      select public.opensteer_refresh_account_directory_user(id) from public.users
    `.execute(database);
  },
};

/**
 * A Thread's continuation identity stays immutable to every ordinary writer:
 * repointing it silently is how a Thread would lose the provider conversation
 * it already owns. One path is now allowed to retarget it, and only one — a
 * Runner reporting that the store behind an identity outlived the narrower
 * thing that identity used to name. That path announces itself with a
 * transaction-local setting, so the guarantee still holds for every statement
 * that does not.
 */
const continuationIdentityAdoptionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create or replace function public.opensteer_prevent_thread_binding_change()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.environment_id is distinct from old.environment_id
           or new.parent_thread_id is distinct from old.parent_thread_id
           or new.workspace_id is distinct from old.workspace_id
           or new.created_by is distinct from old.created_by then
          raise exception 'thread ownership, execution environment, and lineage are immutable';
        end if;
        if old.continuation_identity is not null
           and new.continuation_identity is distinct from old.continuation_identity
           and coalesce(current_setting('opensteer.continuation_adoption', true), '') <> 'on' then
          raise exception 'thread provider continuation identity is immutable once established';
        end if;
        return new;
      end;
      $$
    `.execute(database);
  },
};

/**
 * The Account directory projection no longer carries the Host's signed
 * discovery envelope — the Host publishes its identity to the Account directly
 * on every start. The hand-bumped revision existed only to requeue every
 * projection when that payload's contract changed, so it now guards nothing.
 */
const accountDirectoryProjectionRevisionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.account_directory_provider
        drop column if exists projection_revision
    `.execute(database);
  },
};

/** These joins must stay proportional to one occurrence rather than the whole Deployment. */
export const triggerDownstreamRunLookupMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create index if not exists runs_causal_chain_id_idx
        on public.runs(causal_chain_id);
      create index if not exists thread_inputs_causal_run_idx
        on public.thread_inputs(causal_chain_id, run_id)
        where run_id is not null
    `.execute(database);
  },
};

/** Enrollment retries belong to their creator rather than blocking another administrator. */
export const channelRuntimeEnrollmentIdempotencyMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingTable = await sql<{ exists: boolean }>`
      select to_regclass('public.channel_runtime_enrollments') is not null as exists
    `.execute(database);
    // 0022 retired the Channel Runtime as an identity of its own, so a fresh
    // baseline has no such table. A released database still holds one here and
    // needs the scoped uniqueness before it reaches that migration.
    if (!existingTable.rows[0]?.exists) return;

    await sql`
      alter table public.channel_runtime_enrollments
        drop constraint if exists channel_runtime_enrollments_idempotency_key_key,
        drop constraint if exists channel_runtime_enrollments_owner_idempotency_unique,
        add constraint channel_runtime_enrollments_owner_idempotency_unique
          unique (created_by, idempotency_key)
    `.execute(database);
  },
};

/** Pending computers need the same durable name they retain after connecting. */
export const runnerEnrollmentNameMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingName = await sql<{ exists: boolean }>`
      select exists (
        select 1 from pg_attribute
        where attrelid = 'public.runner_enrollments'::regclass
          and attname = 'name'
          and not attisdropped
      ) as exists
    `.execute(database);
    // Fresh databases receive the current shape from the baseline before
    // historical migrations run; released pre-name databases lack this column.
    if (existingName.rows[0]?.exists) return;

    await sql`
      alter table public.runner_enrollments add column name text;
      update public.runner_enrollments enrollment
      set name = runner.name
      from public.runners runner
      where runner.id = enrollment.runner_id;
      update public.runner_enrollments
      set name = case runner_kind
        when 'main' then 'Main computer'
        when 'managed' then 'Managed computer'
        else 'New computer'
      end
      where name is null;
      alter table public.runner_enrollments
        alter column name set not null,
        add constraint runner_enrollments_name_check
          check (char_length(btrim(name)) between 1 and 120)
    `.execute(database);
  },
};

/**
 * A Deployment's backing becomes the default for new Workspaces rather than the
 * only one it can hold, and a local directory gains the identity of the disk it
 * lives on. `owner_environment_id` is generated from the backing so the machine
 * a Workspace belongs to is a real reference the database enforces, instead of
 * a string buried in JSON.
 */
export const runnerOwnedLocalWorkspacesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    // The Deployment shape is restated on every database. 0001_baseline still
    // declares the pre-0012 shape and 0012 rewrites it, so a fresh database
    // arrives here holding `backing` however current the rest of it is.
    await sql`
      alter table public.deployments drop constraint if exists deployments_shape_check
    `.execute(database);
    await sql`
      update public.deployments
      set deployment_shape = jsonb_build_object(
        'defaultWorkspaceBacking', deployment_shape->>'backing',
        'kind', deployment_shape->>'kind'
      )
      where deployment_shape ? 'backing'
    `.execute(database);
    await sql`
      alter table public.deployments
      add constraint deployments_shape_check check (
        jsonb_typeof(deployment_shape) = 'object'
        and deployment_shape ?& array['defaultWorkspaceBacking', 'kind']
        and deployment_shape - array['defaultWorkspaceBacking', 'kind'] = '{}'::jsonb
        and deployment_shape->>'defaultWorkspaceBacking'
          = any (array['local-directory', 'portablefs'])
        and deployment_shape->>'kind' = any (array['personal', 'server'])
      )
    `.execute(database);

    const existingOwnerColumn = await sql<{ exists: boolean }>`
      select exists (
        select 1 from pg_attribute
        where attrelid = 'public.workspaces'::regclass
          and attname = 'owner_environment_id'
          and not attisdropped
      ) as exists
    `.execute(database);
    // 0001_baseline installs the current Workspace shape and nothing between it
    // and here touches that table, so a fresh database already holds everything
    // below. Only a released pre-authority database lacks this generated
    // column, and nothing else ever creates it.
    if (existingOwnerColumn.rows[0]?.exists) return;

    // The shape this replaces pins both the backing and issue to their old
    // value sets, so both have to go before legacy rows enter the explicit
    // unowned state.
    await sql`
      alter table public.workspaces
        drop constraint if exists workspaces_backing_shape_check,
        drop constraint if exists workspaces_storage_error_shape_check
    `.execute(database);
    // Pre-existing local directories have no machine-minted authority. Null is
    // intentionally not adoptable: the person must recreate the Workspace on
    // the computer whose disk still holds the old files.
    await sql`
      update public.workspaces
      set backing = backing || jsonb_build_object(
        'storageAuthorityId', null
      )
      where backing->>'kind' = 'local-directory'
        and not backing ? 'storageAuthorityId'
    `.execute(database);
    await sql`
      update public.workspaces
      set status = 'unavailable',
          storage_error_code = 'local-authority-mismatch',
          storage_error_message =
            'This Workspace predates machine-owned storage and must be recreated on the computer that holds its files.',
          storage_error_retryable = false,
          storage_error_at = now()
      where backing->>'kind' = 'local-directory'
        and backing->'storageAuthorityId' = 'null'::jsonb
        and status not in ('deleting', 'deleted')
    `.execute(database);
    await sql`
      alter table public.workspaces
        add constraint workspaces_backing_shape_check check (
          jsonb_typeof(backing) = 'object'
          and jsonb_typeof(backing -> 'generation') = 'number'
          and (backing ->> 'generation') ~ '^[0-9]+$'
          and (backing ->> 'generation')::numeric >= 1
          and (backing ->> 'generation')::numeric <= 9007199254740991::bigint::numeric
          and (
            (
              backing ->> 'kind' = 'portablefs'
              and backing ?& array['kind', 'serviceId', 'volumeId', 'generation']
              and backing = jsonb_build_object(
                'kind', backing -> 'kind',
                'serviceId', backing -> 'serviceId',
                'volumeId', backing -> 'volumeId',
                'generation', backing -> 'generation'
              )
              and length(backing ->> 'serviceId') between 1 and 255
              and (backing ->> 'serviceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
              and length(backing ->> 'volumeId') between 1 and 220
              and (backing ->> 'volumeId') ~ '^[A-Za-z0-9_-]+$'
            )
            or (
              backing ->> 'kind' = 'local-directory'
              and backing ?& array[
                'kind', 'bindingId', 'ownerEnvironmentId', 'storageAuthorityId', 'generation'
              ]
              and backing = jsonb_build_object(
                'kind', backing -> 'kind',
                'bindingId', backing -> 'bindingId',
                'ownerEnvironmentId', backing -> 'ownerEnvironmentId',
                'storageAuthorityId', backing -> 'storageAuthorityId',
                'generation', backing -> 'generation'
              )
              and (backing ->> 'bindingId') ~
                '^wbd_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              and (backing ->> 'ownerEnvironmentId') ~
                '^env_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              and (
                backing -> 'storageAuthorityId' = 'null'::jsonb
                or (backing ->> 'storageAuthorityId') ~
                  '^sta_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
              )
            )
          )
        )
    `.execute(database);
    await sql`
      alter table public.workspaces
        add column owner_environment_id text
          generated always as (backing ->> 'ownerEnvironmentId') stored
    `.execute(database);
    // Restrict, not cascade: a machine that still holds somebody's files cannot
    // be deleted out from under them, and losing the machine never means the
    // Workspace row silently disappears.
    await sql`
      alter table public.workspaces
        add constraint workspaces_owner_environment_id_fkey
          foreign key (owner_environment_id)
          references public.execution_environments(id)
          on delete restrict
    `.execute(database);
    await sql`
      create index workspaces_owner_environment_idx
        on public.workspaces(owner_environment_id, status)
        where owner_environment_id is not null
    `.execute(database);
    await sql`
      alter table public.workspaces
        add constraint workspaces_storage_error_shape_check check (
          (
            storage_error_code is null
            and storage_error_message is null
            and storage_error_at is null
            and storage_error_retryable = false
          )
          or (
            storage_error_code = any (array[
              'manager-allocation-rejected',
              'manager-configuration-invalid',
              'manager-identity-rejected',
              'manager-protocol-error',
              'manager-unavailable',
              'manager-unknown-volume-state',
              'local-authority-mismatch',
              'local-authority-unavailable',
              'local-directory-inaccessible',
              'local-directory-missing',
              'local-directory-replaced',
              'local-registry-invalid'
            ])
            and storage_error_message is not null
            and octet_length(storage_error_message) between 1 and 2000
            and storage_error_at is not null
          )
        )
    `.execute(database);
  },
};

/** Watch programs have durable desired state without occupying the command queue. */
export const watchTriggersMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingWatchState = await sql<{ exists: boolean }>`
      select to_regclass('public.trigger_watch_activations') is not null as exists
    `.execute(database);
    // Fresh databases receive the current shape from the baseline before
    // historical migrations run; released pre-watch databases lack this table.
    if (existingWatchState.rows[0]?.exists) return;

    await sql`
      alter table public.trigger_revisions
        drop constraint trigger_revisions_source_check,
        add constraint trigger_revisions_source_check
          check (jsonb_typeof(source) = 'object'
            and source ->> 'kind' = any (array['schedule'::text, 'webhook'::text, 'watch'::text]));
      alter table public.triggers
        drop constraint triggers_kind_check,
        drop constraint triggers_webhook_shape_check,
        add constraint triggers_kind_check
          check (kind = any (array['schedule'::text, 'webhook'::text, 'watch'::text])),
        add constraint triggers_webhook_shape_check check (
          (kind = 'webhook' and webhook_route_key is not null
            and webhook_secret_hash is not null and next_fire_at is null)
          or (kind = 'schedule' and webhook_route_key is null and webhook_secret_hash is null)
          or (kind = 'watch' and webhook_route_key is null
            and webhook_secret_hash is null and next_fire_at is null)
        );
      alter table public.messages
        drop constraint messages_kind_author_check,
        add constraint messages_kind_author_check check (
          (kind = 'input'
            and author ->> 'kind' = any (array['human'::text, 'agent'::text, 'trigger'::text, 'watch'::text]))
          or (kind = any (array['assistant'::text, 'run-result'::text])
            and author ->> 'kind' = 'agent')
          or (kind = 'continuation' and author ->> 'kind' = 'platform')
        );

      create sequence public.trigger_watch_reconcile_generation;

      create table public.trigger_watch_activations (
        id text primary key,
        trigger_id text not null references public.triggers(id) on delete cascade,
        revision_id text not null references public.trigger_revisions(id) on delete restrict,
        environment_id text not null references public.execution_environments(id) on delete restrict,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        anchor_thread_id text not null references public.threads(id) on delete restrict,
        created_by text not null references public.users(id) on delete restrict,
        desired text not null,
        observed text not null,
        execution_generation bigint not null default 0,
        runner_id text references public.runners(id) on delete restrict,
        runner_boot_id text,
        runner_connection_generation bigint,
        restart_count integer not null default 0,
        consecutive_failures integer not null default 0,
        healthy_since timestamptz,
        last_exit_code integer,
        last_error text,
        stdout_tail text not null default '',
        stderr_tail text not null default '',
        lease_expires_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint trigger_watch_activations_desired_check
          check (desired = any (array['active'::text, 'stopped'::text])),
        constraint trigger_watch_activations_observed_check
          check (observed = any (array['starting'::text, 'running'::text, 'backoff'::text, 'expired'::text, 'stopped'::text])),
        constraint trigger_watch_activations_counters_check
          check (execution_generation >= 0 and restart_count >= 0 and consecutive_failures >= 0
            and (runner_connection_generation is null or runner_connection_generation > 0)),
        constraint trigger_watch_activations_log_bounds_check
          check (octet_length(stdout_tail) <= 16384 and octet_length(stderr_tail) <= 16384),
        constraint trigger_watch_activations_trigger_revision_fk
          foreign key (trigger_id, revision_id)
          references public.trigger_revisions(trigger_id, id) on delete restrict
      );
      create unique index trigger_watch_activations_one_active
        on public.trigger_watch_activations(trigger_id) where desired = 'active';
      create index trigger_watch_activations_environment_desired
        on public.trigger_watch_activations(environment_id, desired, updated_at, id);

      create table public.watch_control_requests (
        activation_id text not null references public.trigger_watch_activations(id) on delete cascade,
        observation_id text not null,
        request_id text not null,
        action text not null,
        request_fingerprint text not null,
        created_at timestamptz not null default now(),
        primary key (activation_id, observation_id),
        constraint watch_control_requests_action_check
          check (action = any (array['thread.delegate'::text, 'thread.message'::text]))
      );
      create index watch_control_requests_window
        on public.watch_control_requests(activation_id, created_at);

      alter table public.delegations
        add column parent_watch_activation_id text
          references public.trigger_watch_activations(id) on delete restrict,
        drop constraint delegations_parent_check,
        add constraint delegations_parent_check check (
          num_nonnulls(parent_run_id, parent_occurrence_id, parent_watch_activation_id) = 1
        );

      alter table public.causal_chains
        add column root_watch_activation_id text
          references public.trigger_watch_activations(id) on delete restrict,
        add column root_watch_observation_id text,
        drop constraint causal_chains_root_check,
        add constraint causal_chains_root_check check (
          num_nonnulls(root_message_id, root_occurrence_id, root_watch_activation_id) = 1
          and ((root_watch_activation_id is null) = (root_watch_observation_id is null))
        );
      create unique index causal_chains_watch_observation_unique
        on public.causal_chains(root_watch_activation_id, root_watch_observation_id)
        where root_watch_activation_id is not null;
    `.execute(database);
  },
};

/**
 * A machine is a Runner.
 *
 * The Deployment used to enroll one computer three times — a Runner for agents,
 * a Device for the browser, a Channel Runtime for messaging — and then guess
 * from a self-asserted co-location claim which of those rows were the same
 * machine. This gives the Runner a module grant instead, moves live placement
 * onto `runner_id`, preserves historical credential actors without fabricating
 * a Runner, and drops the two extra identity stacks outright.
 */
export const oneMachineIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingGrant = await sql<{ exists: boolean }>`
      select exists (
        select 1 from pg_attribute
        where attrelid = 'public.runners'::regclass
          and attname = 'allowed_modules'
          and not attisdropped
      ) as exists
    `.execute(database);
    // Fresh databases receive the post-migration shape from the baseline before
    // historical migrations run; only a released pre-module database lacks the
    // grant column, and nothing else ever creates it.
    if (existingGrant.rows[0]?.exists) return;

    await sql`
      alter table public.runners
        add column allowed_modules jsonb default '["agents"]'::jsonb not null,
        add column module_descriptors jsonb default '{}'::jsonb not null,
        alter column max_concurrent_runs drop not null,
        drop constraint runners_max_concurrency_check,
        add constraint runners_max_concurrency_check
          check (max_concurrent_runs is null or max_concurrent_runs between 1 and 1000),
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        ),
        add constraint runners_module_descriptors_check check (
          jsonb_typeof(module_descriptors) = 'object'
          and octet_length(module_descriptors::text) <= 1048576
        ),
        -- An agents Runner is the only one with capacity to declare, and it
        -- must declare it: dispatch has no other number to admit against.
        add constraint runners_agents_capacity_check check (
          (allowed_modules ? 'agents') = (max_concurrent_runs is not null)
        );

      alter table public.runner_enrollments
        add column allowed_modules jsonb default '["agents"]'::jsonb not null,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 3
          and allowed_modules <@ '["agents", "browser", "messaging"]'::jsonb
        );
    `.execute(database);

    // Browser sessions move from the Device that served them to the Runner
    // that does now. A session pinned to a placement that no longer exists
    // cannot be resumed, so the rows go rather than pointing nowhere.
    await sql`
      delete from public.browser_session_attachments;
      delete from public.browser_sessions;
      alter table public.browser_sessions
        drop constraint browser_sessions_placement_check,
        drop constraint browser_sessions_device_id_fkey,
        drop column device_id,
        drop column placement_kind,
        add column runner_id text not null
          references public.runners(id) on delete restrict;
      create index browser_sessions_runner
        on public.browser_sessions(runner_id, state);
    `.execute(database);

    await sql`
      drop index if exists integration_connections_runtime_status;
      alter table public.integration_connections
        drop constraint integration_connections_channel_runtime_id_fkey,
        drop constraint integration_connections_kind_shape,
        drop column channel_runtime_id,
        add column runner_id text references public.runners(id) on delete restrict,
        add constraint integration_connections_kind_shape check (
          (connection_kind = 'channel' and transport_kind is not null
            and integration_server_id is null and auth_method_id is null
            and integration_definition_id is null)
          or (connection_kind = 'provider-account' and transport_kind is null
            and runner_id is null and integration_server_id is null
            and auth_method_id is not null and integration_definition_id is not null)
          or (connection_kind = 'mcp-oauth' and transport_kind is null
            and runner_id is null and provider_application_id is null
            and integration_server_id is not null and auth_method_id is null
            and integration_definition_id is null)
        );
      create index integration_connections_runtime_status
        on public.integration_connections(runner_id, status, updated_at);

      alter table public.credential_access_audit
        add column actor_id text,
        add column runner_id text references public.runners(id) on delete restrict;
      update public.credential_access_audit as audit
      set actor_id = audit.channel_runtime_id,
          runner_id = connection.runner_id
      from public.integration_connections as connection
      where connection.id = audit.connection_id;
      update public.credential_access_audit
      set actor_id = channel_runtime_id
      where actor_id is null;
      alter table public.credential_access_audit
        alter column actor_id set not null,
        drop constraint credential_access_audit_channel_runtime_id_fkey,
        drop column channel_runtime_id;
    `.execute(database);

    // An in-flight claim names a principal that is about to stop existing.
    await sql`
      update public.channel_deliveries
      set status = 'pending', claim_token_hash = null, claim_owner = null,
        claim_expires_at = null, next_attempt_at = now(), updated_at = now()
      where status = 'leased';
      update public.channel_deliveries
      set status = 'unknown', claim_token_hash = null, claim_owner = null,
        claim_expires_at = null,
        last_error = 'The messaging runtime identity was retired mid-attempt.',
        updated_at = now()
      where status = 'attempt-started';
    `.execute(database);

    await sql`
      drop table public.device_enrollments;
      drop table public.devices;
      drop table public.channel_runtime_enrollments;
      drop table public.channel_runtimes;
    `.execute(database);
  },
};

/**
 * A computer becomes something other computers can reach.
 *
 * `shell` joins the module grant on every Runner and every enrollment by set
 * union, because usability is policy rather than grant: a machine that cannot
 * run the module simply never advertises it, while a machine whose owner turns
 * access on must not have to be re-enrolled first. The policy itself and the
 * revision that guards its writes live on the Runner, and the sessions opened
 * against it are their own history.
 */
export const machineAccessMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingSessions = await sql<{ exists: boolean }>`
      select to_regclass('public.machine_access_sessions') is not null as exists
    `.execute(database);
    // Fresh databases receive the post-migration shape from the baseline before
    // historical migrations run, and this table is the object only this
    // migration creates.
    if (existingSessions.rows[0]?.exists) return;

    await sql`
      alter table public.runners
        add column access_policy jsonb
          default '{"reach": "nobody", "shares": [], "commands": false, "forwarding": false}'::jsonb
          not null,
        add column access_policy_revision integer default 1 not null,
        drop constraint runners_allowed_modules_check,
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 4
          and allowed_modules <@ '["agents", "browser", "messaging", "shell"]'::jsonb
        );

      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 4
          and allowed_modules <@ '["agents", "browser", "messaging", "shell"]'::jsonb
        );

      update public.runners
      set allowed_modules = allowed_modules || '["shell"]'::jsonb
      where not (allowed_modules ? 'shell');

      update public.runner_enrollments
      set allowed_modules = allowed_modules || '["shell"]'::jsonb
      where not (allowed_modules ? 'shell');
    `.execute(database);

    await sql`
      create table public.machine_access_sessions (
        id text primary key,
        runner_id text not null references public.runners(id) on delete restrict,
        run_id text not null,
        thread_id text not null,
        requested_by text not null,
        caller_runner_id text not null,
        caller_machine_name text not null,
        thread_title text not null,
        policy_revision integer not null,
        state text not null,
        started_at timestamptz not null,
        ended_at timestamptz,
        end_reason text,
        bytes_in bigint default 0 not null,
        bytes_out bigint default 0 not null,
        constraint machine_access_sessions_state_check
          check (state = any (array['pending', 'active', 'ended']))
      );
      create index machine_access_sessions_history
        on public.machine_access_sessions(runner_id, started_at desc, id desc);
      create index machine_access_sessions_run on public.machine_access_sessions(run_id);
      create index machine_access_sessions_open
        on public.machine_access_sessions(runner_id) where ended_at is null;

      create table public.machine_access_events (
        id bigserial primary key,
        session_id text not null
          references public.machine_access_sessions(id) on delete cascade,
        at timestamptz not null,
        event jsonb not null
      );
      create index machine_access_events_session
        on public.machine_access_events(session_id, id);
    `.execute(database);
  },
};

/**
 * Concurrency belongs to the advertisement that carried it, not to the grant.
 *
 * `0022` made a grant of `agents` require a concurrency number, because every
 * computer that could run agents was running them. A computer may now be
 * granted `agents` and be reach-only right now — the desktop's "Runs agents"
 * switch restarts the same identity with a smaller module set — and one that is
 * not advertising the module has no number to declare. What stays true is the
 * other direction: a number is recorded only by a computer allowed to run
 * agents at all.
 */
export const advertisedAgentsCapacityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.runners
        drop constraint if exists runners_agents_capacity_check,
        add constraint runners_agents_capacity_check check (
          max_concurrent_runs is null or allowed_modules ? 'agents'
        );
    `.execute(database);
  },
};

/**
 * Harness executables are named by the distribution that ships them and handed
 * to each driver by the Runner; a profile no longer carries an executable path,
 * and a stored one would be rejected by the driver's strict configuration.
 */
export const harnessExecutablesFromRuntimeMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    // A configuration change advances the profile's runtime revision and
    // retires its catalog, exactly as an edit through the store does, so a
    // Runner that still holds the old definition refreshes instead of
    // rejecting the same revision with different configuration.
    await sql`
      with changed as (
        update public.harness_instances
          set config = config - 'executable' - 'executableArgs' - 'pathToClaudeCodeExecutable',
              runtime_revision = runtime_revision + 1,
              updated_at = now()
          where config ?| array['executable', 'executableArgs', 'pathToClaudeCodeExecutable']
          returning id
      )
      delete from public.harness_catalogs
        where harness_instance_id in (select id from changed);
    `.execute(database);
  },
};

/**
 * Two facts the Host used to infer rather than record.
 *
 * A Personal remote session now names the presentation family it was minted
 * for, so a header credential can never be replayed as a cookie or the
 * reverse. Every session that predates this column was issued as a cookie,
 * which is what the backfill states.
 *
 * `machine_local_sessions` makes "the owner is at this computer's keyboard" a
 * positive property instead of the absence of a remote-session row. It is
 * deliberately **not** backfilled: no existing row carries the process-launch
 * proof this marker stands for, and inferring one by exclusion would recreate
 * exactly the inference being removed. An owner whose session predates this
 * migration re-establishes it through the local owner claim the application
 * already performs on every start.
 */
export const positiveMachineLocalSessionsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select to_regclass('public.machine_local_sessions') is not null as exists
    `.execute(database);
    // Fresh databases receive the post-migration shape from the baseline before
    // historical migrations run, and this table is the object only this
    // migration creates.
    if (existing.rows[0]?.exists) return;

    await sql`
      create table public.machine_local_sessions (
        auth_session_id text primary key
          references public.auth_sessions(id) on delete cascade,
        established_at timestamptz default now() not null
      );

      alter table public.personal_remote_sessions
        add column delivery text default 'cookie' not null,
        add constraint personal_remote_sessions_delivery_check
          check (delivery = any (array['cookie', 'header']));

      alter table public.personal_remote_sessions
        alter column delivery drop default;
    `.execute(database);
  },
};

/**
 * The notification projector's durable state: how far it has read each
 * Workspace's event log, and the append-only outbox of moments a person needs
 * to know about. Both are absent from a database created before push existed;
 * a fresh one receives them from the baseline, which is why this migration
 * probes before it creates anything.
 *
 * Every Workspace that already exists is checkpointed at its committed head,
 * never at zero. The event log is complete and never pruned, so seeding one at
 * zero would replay every Request and Run this Deployment has ever had onto a
 * lock screen; a Workspace created from now on is checkpointed at zero by the
 * transaction that creates it, so its very first Request is inside the window.
 */
export const notificationOutboxMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select to_regclass('public.notification_outbox') is not null as exists
    `.execute(database);
    if (existing.rows[0]?.exists) return;

    await sql`
      create table public.notification_checkpoints (
        workspace_id text primary key
          references public.workspaces(id) on delete cascade,
        sequence bigint not null,
        created_at timestamptz default now() not null,
        updated_at timestamptz default now() not null,
        constraint notification_checkpoints_sequence_check check (sequence >= 0)
      );

      create table public.notification_outbox (
        id text primary key,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        sequence bigint not null,
        event_id text not null,
        thread_id text not null,
        run_id text,
        request_id text,
        kind text not null,
        recipient_account_ids jsonb not null,
        occurred_at timestamptz not null,
        expires_at timestamptz not null,
        attempts integer default 0 not null,
        next_attempt_at timestamptz default now() not null,
        last_error text,
        lease_token text,
        lease_expires_at timestamptz,
        published_at timestamptz,
        created_at timestamptz default now() not null,
        constraint notification_outbox_event_unique unique (event_id),
        constraint notification_outbox_sequence_check check (sequence >= 1),
        constraint notification_outbox_attempts_check check (attempts between 0 and 1000000),
        constraint notification_outbox_error_check check (
          last_error is null or octet_length(last_error) between 1 and 2000
        ),
        constraint notification_outbox_kind_check check (
          kind = any (array['request-opened', 'run-completed', 'run-failed', 'run-interrupted'])
        ),
        constraint notification_outbox_lease_check check (
          (lease_token is null and lease_expires_at is null)
          or (octet_length(lease_token) between 32 and 128 and lease_expires_at is not null)
        ),
        constraint notification_outbox_origin_check check (
          (kind = 'request-opened' and request_id is not null)
          or (kind <> 'request-opened' and request_id is null and run_id is not null)
        ),
        constraint notification_outbox_recipients_check check (
          jsonb_typeof(recipient_account_ids) = 'array'
          and jsonb_array_length(recipient_account_ids) between 1 and 256
        )
      );

      create index notification_outbox_pending
        on public.notification_outbox (next_attempt_at, created_at)
        where published_at is null;
    `.execute(database);

    // Every Workspace that already exists is checkpointed at its committed
    // head, here and once. That is the whole of the "suppress the backlog"
    // rule: a Workspace created from now on is checkpointed at zero by the
    // transaction that creates it, so its first Request is inside the window.
    await sql`
      insert into public.notification_checkpoints(workspace_id, sequence, created_at, updated_at)
      select id, event_sequence, now(), now() from public.workspaces
      on conflict (workspace_id) do nothing
    `.execute(database);
  },
};

/**
 * The name the old seeding wrote for an ambient profile. It is reconstructed
 * here rather than imported because the code that produced it is gone: the
 * suffix said "this is the CLI you already signed in to", which stopped being
 * a distinction once a driver could hold several accounts and one of them is
 * the default.
 */
function legacySeededAmbientName(driverKind: string): string {
  const label = driverKind
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return `${label || driverKind} — Existing CLI`;
}

interface HarnessDefaultMigrationRow {
  readonly createdAt: Date;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly environmentId: string;
  readonly id: string;
  readonly isDefault: boolean;
  readonly name: string;
  readonly stateKind: string;
}

function harnessDefaultPair(row: HarnessDefaultMigrationRow): string {
  return JSON.stringify([row.environmentId, row.driverKind]);
}

/** The exact account-name ordering the pre-default client used. */
function compareLegacyHarnessAccounts(
  left: HarnessDefaultMigrationRow,
  right: HarnessDefaultMigrationRow,
): number {
  return (
    left.name.localeCompare(right.name) ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Which account of an AI engine a person means when they do not name one.
 *
 * Several profiles of one engine can live on one work location, and until now
 * nothing recorded which was primary — placement fell back to whichever name
 * sorted first, which is an accident, not a choice. The partial unique index
 * is what makes "the default" a fact rather than a convention: at most one live
 * default per `(environment, driver_kind)`, enforced by the database.
 *
 * The backfill names the first enabled profile in the old name ordering,
 * because that is the account new Threads implicitly reached before this
 * column existed. Seeded ambient profiles also lose their ` — Existing CLI`
 * suffix here: the product now shows the engine's own name, and a rename is
 * skipped when the environment already holds a profile with that exact name,
 * so this never collides with one a person chose. An isolated profile may have
 * the same text because a person chose it, so it is never renamed.
 *
 * A fresh database receives the column and the index from the baseline, which
 * is why this probes before it does anything.
 */
export const defaultHarnessPerDriverMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'harness_instances'
          and column_name = 'is_default'
      ) as exists
    `.execute(database);
    if (existing.rows[0]?.exists) return;

    await sql`
      alter table public.harness_instances
        add column is_default boolean default false not null,
        add constraint harness_instances_default_enabled_check
          check ((not is_default) or (enabled and removed_at is null));

      create unique index harness_instances_one_default_per_driver
        on public.harness_instances using btree (environment_id, driver_kind)
        where ((removed_at is null) and is_default);
    `.execute(database);

    const live = await sql<HarnessDefaultMigrationRow>`
      select driver_kind as "driverKind", environment_id as "environmentId", id, name,
             state_kind as "stateKind", enabled, is_default as "isDefault",
             created_at as "createdAt"
      from public.harness_instances
      where removed_at is null
      order by environment_id, created_at, id
    `.execute(database);
    const backfilledPairs = new Set<string>();
    for (const row of live.rows
      .filter(({ enabled }) => enabled)
      .sort(compareLegacyHarnessAccounts)) {
      const pair = harnessDefaultPair(row);
      if (backfilledPairs.has(pair)) continue;
      await sql`
        update public.harness_instances set is_default = true
        where id = ${row.id}
      `.execute(database);
      backfilledPairs.add(pair);
    }
    const namesByEnvironment = new Map<string, Set<string>>();
    for (const row of live.rows) {
      const taken = namesByEnvironment.get(row.environmentId) ?? new Set<string>();
      taken.add(row.name);
      namesByEnvironment.set(row.environmentId, taken);
    }
    for (const row of live.rows) {
      if (row.stateKind !== "ambient") continue;
      if (row.name !== legacySeededAmbientName(row.driverKind)) continue;
      const label = harnessDriverLabel(row.driverKind);
      const taken = namesByEnvironment.get(row.environmentId);
      if (taken?.has(label)) continue;
      await sql`
        update public.harness_instances set name = ${label}, updated_at = now()
        where id = ${row.id}
      `.execute(database);
      taken?.delete(row.name);
      taken?.add(label);
    }
  },
};

/** Gives every existing AI account the source its engine reaches. */
export const harnessAccountSourcesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'harness_instances'
          and column_name = 'source_id'
      ) as exists
    `.execute(database);
    if (existing.rows[0]?.exists) return;

    await sql`
      alter table public.harness_instances add column source_id text
    `.execute(database);
    await sql`
      update public.harness_instances
        set source_id = case
              when driver_kind = 'codex'
                   and config->>'modelProviderId' in ('openai')
                then config->>'modelProviderId'
              when driver_kind = 'claude'
                   and config->>'modelProviderId'
                       in ('anthropic', 'bedrock', 'vertex', 'foundry')
                then config->>'modelProviderId'
              when driver_kind = 'codex' then 'openai'
              when driver_kind = 'claude' then 'anthropic'
              else driver_kind
            end,
            config = case
              when jsonb_typeof(config) = 'object' then config - 'modelProviderId'
              else config
            end
    `.execute(database);
    await sql`
      alter table public.harness_instances
        alter column source_id set not null,
        add constraint harness_instances_source_id_check
          check (source_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$')
    `.execute(database);
  },
};

/**
 * `0029` originally allowed its default bit to remain on a disabled profile.
 * Released databases may already have recorded that migration name, so this
 * repair keeps any usable chosen default, clears an unusable one, fills an
 * empty pair from the same name-ranked account old placement used, and then
 * makes the lifecycle rule a database constraint.
 *
 * A fresh baseline already carries the constraint. That is the no-op probe;
 * the repair stays a new migration rather than changing the meaning of an
 * already-recorded migration alone.
 */
export const harnessDefaultLifecycleMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from pg_constraint
        where conrelid = 'public.harness_instances'::regclass
          and conname = 'harness_instances_default_enabled_check'
      ) as exists
    `.execute(database);
    if (existing.rows[0]?.exists) return;

    await sql`
      update public.harness_instances
        set is_default = false, updated_at = now()
        where is_default and (not enabled or removed_at is not null);
    `.execute(database);
    const live = await sql<HarnessDefaultMigrationRow>`
      select driver_kind as "driverKind", environment_id as "environmentId", id, name,
             state_kind as "stateKind", enabled, is_default as "isDefault",
             created_at as "createdAt"
      from public.harness_instances
      where removed_at is null
    `.execute(database);
    const filledPairs = new Set(
      live.rows.filter(({ enabled, isDefault }) => enabled && isDefault).map(harnessDefaultPair),
    );
    for (const row of live.rows
      .filter(({ enabled }) => enabled)
      .sort(compareLegacyHarnessAccounts)) {
      const pair = harnessDefaultPair(row);
      if (filledPairs.has(pair)) continue;
      await sql`
        update public.harness_instances set is_default = true, updated_at = now()
        where id = ${row.id}
      `.execute(database);
      filledPairs.add(pair);
    }
    await sql`
      alter table public.harness_instances
        add constraint harness_instances_default_enabled_check
          check ((not is_default) or (enabled and removed_at is null));
    `.execute(database);
  },
};

/**
 * Messaging becomes sender-pull: the bot hands the person a link code and the
 * person redeems it while signed in, so a code is minted FOR a channel
 * identity and consumed BY a user rather than the other way round. Existing
 * codes are deleted because the old `/link CODE` flow never reached the Host —
 * the slash command was never registered — so no live code was ever redeemable.
 *
 * The same change gives deliveries a voice of their own. A `status` delivery
 * can answer an ingress that never became a conversation (an unlinked sender,
 * an unrouted channel), so `conversation_id` becomes nullable and exactly one
 * of it and `ingress_id` identifies where the message goes; `audience` decides
 * whether the whole conversation or only the person who wrote sees it; and a
 * reply longer than the provider accepts becomes ordered `part`s of one
 * message, which is why the reply-dedupe index gains `part`.
 *
 * Thread-ness stopped being a conversation type — it is `external_thread_id`
 * alone — and the webhook and device transports are gone with the inbound
 * webhook adapter, so a connection still holding one is revoked rather than
 * silently re-pointed at a transport it was never configured for.
 *
 * A fresh database receives all of this from the baseline, which is why this
 * probes before it does anything.
 */
export const messagingSenderPullLinkingMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'channel_deliveries'
          and column_name = 'audience'
      ) as exists
    `.execute(database);
    if (existing.rows[0]?.exists) return;

    await sql`
      update public.channel_conversations
        set conversation_type = 'channel', updated_at = now()
        where conversation_type = 'thread';
      alter table public.channel_conversations
        drop constraint channel_conversations_conversation_type_check,
        add constraint channel_conversations_conversation_type_check
          check (conversation_type = any (array['dm', 'group', 'channel']));
    `.execute(database);

    // `channelId` in a route selector was always the conversation it named, so
    // it moves rather than being dropped — but only where the newer key is
    // still empty, so a selector carrying both keeps the one it was matched on.
    await sql`
      update public.channel_bindings
        set selector = (selector - 'channelId') || (
              case
                when selector->>'channelId' is not null and selector->>'conversationId' is null
                  then jsonb_build_object('conversationId', selector->'channelId')
                else '{}'::jsonb
              end
            ),
            updated_at = now()
        where selector ? 'channelId';
      update public.channel_bindings
        set selector = jsonb_set(selector, '{conversationType}', '"channel"'::jsonb),
            updated_at = now()
        where selector->>'conversationType' = 'thread';
    `.execute(database);

    // A normalized event no longer carries an event kind (only message
    // creation is ever ingested) or a conversation `channelId`, and the
    // Host parses every stored event strictly.
    await sql`
      update public.channel_ingress_events
        set status = 'ignored',
            processed_at = coalesce(processed_at, now()),
            last_error = 'Unsupported channel event',
            claim_token_hash = null,
            claim_owner = null,
            claim_expires_at = null,
            updated_at = now()
        where status in ('pending', 'leased')
          and event->>'kind' is not null
          and event->>'kind' <> 'message-created';
      update public.channel_ingress_events
        set event = case
              when event->'conversation'->>'type' = 'thread'
                then jsonb_set(event - 'kind', '{conversation,type}', '"channel"'::jsonb)
                       #- '{conversation,channelId}'
              else (event - 'kind') #- '{conversation,channelId}'
            end,
            updated_at = now()
        where event ? 'kind'
          or event->'conversation' ? 'channelId'
          or event->'conversation'->>'type' = 'thread';
    `.execute(database);

    // `proactive` never had a writer; the kind it would have been is `status`.
    await sql`
      update public.channel_deliveries set kind = 'status', updated_at = now() where kind = 'proactive';
      update public.channel_deliveries set ingress_id = null, updated_at = now()
        where conversation_id is not null and ingress_id is not null;
      alter table public.channel_deliveries
        add column audience text default 'conversation' not null,
        add column part integer default 0 not null,
        add column part_count integer default 1 not null,
        alter column conversation_id drop not null,
        drop constraint channel_deliveries_kind_check,
        add constraint channel_deliveries_kind_check check (kind = any (array['reply', 'status'])),
        add constraint channel_deliveries_audience_check
          check (audience = any (array['conversation', 'actor'])),
        add constraint channel_deliveries_destination_check
          check (num_nonnulls(conversation_id, ingress_id) = 1),
        add constraint channel_deliveries_part_check
          check (part >= 0 and part_count >= 1 and part < part_count);

      drop index public.channel_deliveries_message_reply_unique;
      create unique index channel_deliveries_message_reply_unique
        on public.channel_deliveries using btree (message_id, part)
        where ((kind = 'reply') and (message_id is not null));
      drop index public.channel_deliveries_claimable;
      create index channel_deliveries_claimable
        on public.channel_deliveries using btree (coalesce(conversation_id, ingress_id), created_at, part)
        where (status = any (array['pending', 'leased', 'attempt-started', 'retryable-failed', 'unknown']));
      create index channel_deliveries_retention
        on public.channel_deliveries using btree (updated_at)
        where (status = any (array['sent', 'dead']));
      create index channel_ingress_retention
        on public.channel_ingress_events using btree (processed_at)
        where (status = any (array['adopted', 'ignored', 'dead']));
    `.execute(database);

    await sql`
      delete from public.channel_link_codes;
      alter table public.channel_link_codes
        alter column user_id drop not null,
        alter column identity_id set not null,
        drop constraint channel_link_codes_consumption_check,
        add constraint channel_link_codes_consumption_check
          check ((consumed_at is null) = (user_id is null));
      create index channel_link_codes_identity_live
        on public.channel_link_codes using btree (identity_id, expires_at)
        where (consumed_at is null);
    `.execute(database);

    // `anyone` access runs as the person who created the route, so the Thread
    // must not inherit that person's own Main capabilities. The trigger's job
    // is to stop a Thread claiming more authority than it has, not to stop it
    // claiming less, so `workspace` becomes acceptable wherever `main` was
    // required.
    await sql`
      create or replace function public.opensteer_enforce_thread_capability_profile()
      returns trigger language plpgsql as $$
        declare
          highest_profile text;
        begin
          if tg_op = 'UPDATE' then
            if new.capability_profile_id is distinct from old.capability_profile_id then
              raise exception 'thread capability profile is immutable';
            end if;
            return new;
          end if;
          if new.parent_thread_id is not null then
            if new.capability_profile_id is distinct from 'delegated' then
              raise exception 'thread capability profile does not match its durable authority';
            end if;
            return new;
          end if;
          if exists (
            select 1
            from workspaces
            join workspace_memberships
              on workspace_memberships.workspace_id = workspaces.id
            where workspaces.id = new.workspace_id
              and workspaces.kind = 'main'
              and workspace_memberships.user_id = new.created_by
              and workspace_memberships.state = 'active'
              and workspace_memberships.role = 'owner'
          ) then
            highest_profile := 'main';
          else
            highest_profile := 'workspace';
          end if;
          -- The ceiling is the authority; a Thread may deliberately run below it.
          -- A channel route in "anyone" mode runs as the person who created it
          -- without being them, so it takes "workspace" even in their own Main.
          if new.capability_profile_id = highest_profile
            or (highest_profile = 'main' and new.capability_profile_id = 'workspace') then
            return new;
          end if;
          raise exception 'thread capability profile does not match its durable authority';
        end;
      $$;
    `.execute(database);

    await sql`
      update public.integration_connections
        set status = 'revoked',
            status_detail = 'This messaging transport is no longer supported',
            status_reason = 'transport',
            transport_kind = 'socket',
            updated_at = now()
        where connection_kind = 'channel' and transport_kind in ('webhook', 'device');
      alter table public.integration_connections
        drop constraint integration_connections_transport_kind_check,
        add constraint integration_connections_transport_kind_check
          check (transport_kind = any (array['socket', 'polling']));
    `.execute(database);
  },
};

/**
 * Three concepts nothing ever wrote or read leave the messaging tables at once.
 *
 * `aliases` and the `blocked` identity status had no writer: an identity is
 * unlinked until somebody redeems a code for it, and blocking a provider user
 * is the provider's job, not this Deployment's. `placement` on a binding's
 * execution policy had exactly one possible value, so it decided nothing —
 * where a channel message runs is chosen per message from the work locations
 * that are actually available to its sender. The Host now parses both shapes
 * strictly, so the stored rows have to lose the keys with the code.
 */
export const channelDeadConceptsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'channel_identities'
          and column_name = 'aliases'
      ) as exists
    `.execute(database);
    // A fresh baseline already has the narrowed shape.
    if (!existing.rows[0]?.exists) return;

    await sql`
      update public.channel_identities
        set status = 'unlinked', updated_at = now()
        where status = 'blocked';
      alter table public.channel_identities
        drop column aliases,
        drop constraint channel_identities_status_check,
        drop constraint channel_identities_link_shape,
        add constraint channel_identities_link_shape
          check (((status = 'linked') and (linked_user_id is not null))
            or ((status = 'unlinked') and (linked_user_id is null))),
        add constraint channel_identities_status_check
          check (status = any (array['unlinked', 'linked']));
    `.execute(database);

    await sql`
      update public.channel_bindings
        set execution_policy = execution_policy - 'placement', updated_at = now()
        where execution_policy ? 'placement';
    `.execute(database);
  },
};

/**
 * Messaging access is one durable policy per binding. Provider conversations
 * are an access filter on that route, direct messages have their own sender
 * rule, and explicit approval is represented by a durable grant instead of a
 * synthetic Request or Thread. Historical policies are rewritten once so the
 * runtime has no legacy parser and no migration broadens who may run.
 */
export const channelDurableAccessMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ exists: boolean }>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'channel_access_grants'
      ) as exists
    `.execute(database);
    // A fresh baseline already has the durable access tables and policy shape.
    if (existing.rows[0]?.exists) return;

    await sql`
      alter table public.channel_bindings
        add constraint channel_bindings_id_account_id_key unique (id, account_id);

      create table public.channel_access_grants (
        account_id text not null,
        binding_id text not null,
        external_user_id text not null,
        display_name text not null,
        status text not null,
        revision integer default 1 not null,
        requested_at timestamp with time zone default now() not null,
        request_ingress_id text,
        decided_at timestamp with time zone,
        decided_by text,
        updated_at timestamp with time zone default now() not null,
        constraint channel_access_grants_pkey primary key (binding_id, external_user_id),
        constraint channel_access_grants_binding_account_fkey
          foreign key (binding_id, account_id)
          references public.channel_bindings(id, account_id) on delete restrict,
        constraint channel_access_grants_decided_by_fkey
          foreign key (decided_by) references public.users(id) on delete restrict,
        constraint channel_access_grants_request_ingress_id_fkey
          foreign key (request_ingress_id)
          references public.channel_ingress_events(id) on delete set null,
        constraint channel_access_grants_decision_shape check (
          (status = 'pending' and decided_at is null and decided_by is null)
          or (status = any (array['approved', 'declined', 'revoked'])
            and decided_at is not null and decided_by is not null)
        ),
        constraint channel_access_grants_display_name_check
          check (octet_length(display_name) between 1 and 640),
        constraint channel_access_grants_external_user_id_check
          check (octet_length(external_user_id) between 1 and 2048),
        constraint channel_access_grants_revision_check check (revision > 0),
        constraint channel_access_grants_status_check
          check (status = any (array['pending', 'approved', 'declined', 'revoked']))
      );
      create index channel_access_grants_account_status
        on public.channel_access_grants (account_id, status, requested_at desc);

      create table public.channel_conversation_contexts (
        conversation_id text not null,
        authority_user_id text not null,
        binding_revision integer not null,
        active_thread_id text,
        created_at timestamp with time zone default now() not null,
        updated_at timestamp with time zone default now() not null,
        constraint channel_conversation_contexts_pkey
          primary key (conversation_id, authority_user_id),
        constraint channel_conversation_contexts_conversation_id_fkey
          foreign key (conversation_id)
          references public.channel_conversations(id) on delete restrict,
        constraint channel_conversation_contexts_authority_user_id_fkey
          foreign key (authority_user_id) references public.users(id) on delete restrict,
        constraint channel_conversation_contexts_active_thread_id_fkey
          foreign key (active_thread_id) references public.threads(id) on delete restrict,
        constraint channel_conversation_contexts_binding_revision_check
          check (binding_revision > 0)
      );
      create index channel_conversation_contexts_active_thread
        on public.channel_conversation_contexts (active_thread_id)
        where active_thread_id is not null;

      alter table public.channel_link_codes add column request_ingress_id text;
      alter table public.channel_link_codes
        add constraint channel_link_codes_request_ingress_id_fkey
        foreign key (request_ingress_id)
        references public.channel_ingress_events(id) on delete set null;
    `.execute(database);

    // Preserve every existing sender restriction exactly. A historical
    // `selected` sender still has to be linked and in the Workspace; the old
    // allow-list becomes the new policy's independent AND restriction.
    await sql`
      update public.channel_bindings
      set access_policy = jsonb_build_object(
        'channels', jsonb_build_object(
          'scope', case
            when selector->>'conversationId' is null then 'all'
            else 'selected'
          end,
          'conversationIds', case
            when selector->>'conversationId' is null then '[]'::jsonb
            else jsonb_build_array(selector->>'conversationId')
          end,
          'sender', jsonb_build_object(
            'mode', case access_policy->>'mode'
              when 'selected' then 'linked-members'
              else access_policy->>'mode'
            end,
            'allowedExternalUserIds', coalesce(access_policy->'allowedExternalUserIds', '[]'::jsonb)
          )
        ),
        'directMessages', jsonb_build_object(
          'mode', case access_policy->>'mode'
            when 'selected' then 'linked-members'
            else access_policy->>'mode'
          end,
          'allowedExternalUserIds', coalesce(access_policy->'allowedExternalUserIds', '[]'::jsonb)
        )
      ), revision = revision + 1, updated_at = now();
    `.execute(database);

    // Historical channel Threads remain visible, but none of their provider
    // contexts or queued input is executable under the new policy. The first
    // new event creates a fresh root after re-reading current authority.
    await sql`
      update public.thread_inputs
      set state = 'cancelled',
          cancel_reason = 'channel-access-migrated',
          updated_at = now()
      where state = 'pending' and authority_source->>'kind' = 'channel-ingress';
    `.execute(database);
  },
};

/**
 * What a Run consumed, as its engine reported it. The columns are nullable
 * because usage is evidence, not a Run property: an engine whose protocol
 * carries no per-turn usage reports none, and no row is ever backfilled with
 * an estimate. `input_tokens` and `output_tokens` travel together, which is
 * what makes "this Run's usage is already recorded" a single readable fact.
 */
export const runUsageAccountingMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.runs
        add column if not exists input_tokens bigint,
        add column if not exists output_tokens bigint,
        add column if not exists cached_input_tokens bigint,
        add column if not exists cache_write_tokens bigint,
        add column if not exists reasoning_tokens bigint,
        add column if not exists cost_usd numeric(18, 8),
        drop constraint if exists runs_usage_tokens_check,
        drop constraint if exists runs_cost_usd_check,
        add constraint runs_usage_tokens_check check (
          ((input_tokens is null) = (output_tokens is null))
          and (input_tokens is not null or (
            cached_input_tokens is null and cache_write_tokens is null
            and reasoning_tokens is null and cost_usd is null
          ))
          and (input_tokens is null or (input_tokens >= 0 and input_tokens <= 9007199254740991))
          and (output_tokens is null or (output_tokens >= 0 and output_tokens <= 9007199254740991))
          and (cached_input_tokens is null
            or (cached_input_tokens >= 0 and cached_input_tokens <= 9007199254740991))
          and (cache_write_tokens is null
            or (cache_write_tokens >= 0 and cache_write_tokens <= 9007199254740991))
          and (reasoning_tokens is null
            or (reasoning_tokens >= 0 and reasoning_tokens <= 9007199254740991))
        ),
        add constraint runs_cost_usd_check check (cost_usd is null or cost_usd >= 0);
    `.execute(database);
  },
};

/**
 * Cursor's first-party model families acquired their lab identities after the
 * Cursor harness shipped. Preserve every endpoint-owned field and continuation
 * identity; only the canonical provider changes. Historical Runs are rewritten
 * too so one Thread does not show two labs across the upgrade. Stored Cursor
 * catalogs use the old canonical pairs, so discard them and let normal Runner
 * reconciliation capture the same native ids under the new pairs.
 *
 * Keep these predicates as a migration-time snapshot. Future registry rules
 * must not silently widen an already released data rewrite.
 */
export const cursorModelIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.threads as thread
      set model_selection = jsonb_set(
        thread.model_selection,
        '{providerId}',
        to_jsonb(
          case
            when lower(thread.model_selection->>'modelId') = 'auto'
              or lower(thread.model_selection->>'modelId') ~ '^composer($|[-_.])'
              or lower(thread.model_selection->>'modelId') ~ '^cursor-grok($|[-_.])'
            then 'xai'
            when lower(thread.model_selection->>'modelId') ~ '^muse($|[^[:alnum:]_])'
            then 'meta'
          end::text
        ),
        false
      )
      from public.harness_instances as harness
      where harness.id = thread.harness_instance_id
        and harness.driver_kind = 'cursor'
        and thread.model_selection->>'providerId' = 'cursor'
        and (
          lower(thread.model_selection->>'modelId') = 'auto'
          or lower(thread.model_selection->>'modelId') ~ '^composer($|[-_.])'
          or lower(thread.model_selection->>'modelId') ~ '^cursor-grok($|[-_.])'
          or lower(thread.model_selection->>'modelId') ~ '^muse($|[^[:alnum:]_])'
        );

      update public.runs as run
      set model_selection = jsonb_set(
        run.model_selection,
        '{providerId}',
        to_jsonb(
          case
            when lower(run.model_selection->>'modelId') = 'auto'
              or lower(run.model_selection->>'modelId') ~ '^composer($|[-_.])'
              or lower(run.model_selection->>'modelId') ~ '^cursor-grok($|[-_.])'
            then 'xai'
            when lower(run.model_selection->>'modelId') ~ '^muse($|[^[:alnum:]_])'
            then 'meta'
          end::text
        ),
        false
      )
      from public.harness_instances as harness
      where harness.id = run.harness_instance_id
        and harness.driver_kind = 'cursor'
        and run.model_selection->>'providerId' = 'cursor'
        and (
          lower(run.model_selection->>'modelId') = 'auto'
          or lower(run.model_selection->>'modelId') ~ '^composer($|[-_.])'
          or lower(run.model_selection->>'modelId') ~ '^cursor-grok($|[-_.])'
          or lower(run.model_selection->>'modelId') ~ '^muse($|[^[:alnum:]_])'
        );

      delete from public.harness_catalogs as catalog
      using public.harness_instances as harness
      where harness.id = catalog.harness_instance_id
        and harness.driver_kind = 'cursor';
    `.execute(database);
  },
};

/**
 * A person's execution choices become the Host's, so a phone and a desktop
 * never disagree about what was picked last. One row per person, cascading
 * with the user: a preference outliving the account it belongs to would be a
 * hint nobody could ever act on.
 */
export const userExecutionPreferencesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table if not exists public.user_execution_preferences (
        user_id text primary key references public.users(id) on delete cascade,
        preferences jsonb not null,
        updated_at timestamptz not null default now()
      );
    `.execute(database);
  },
};

/**
 * Custom OAuth applications may be private to one user. Existing singleton rows remain
 * deployment-shared; their null owner preserves every connection's existing application id and
 * revision while the partial index retains the original one-shared-app-per-provider invariant.
 */
export const ownerScopedIntegrationProviderApplicationsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_provider_applications
        add column if not exists owner_user_id text
          references public.users(id) on delete cascade;

      alter table public.integration_provider_applications
        drop constraint if exists integration_provider_applications_provider_key;

      create unique index if not exists integration_provider_applications_shared_provider_key
        on public.integration_provider_applications(provider)
        where owner_user_id is null;

      create index if not exists integration_provider_applications_owner_provider_idx
        on public.integration_provider_applications(owner_user_id, provider)
        where owner_user_id is not null;

      create or replace function public.opensteer_bump_provider_integration_authority()
      returns trigger
      language plpgsql
      as $$
        begin
          if old.status is distinct from new.status then
            insert into integration_authority_generations (owner_user_id, generation, updated_at)
            select distinct owner_user_id, 1, now()
            from integration_connections
            where provider_application_id = new.id and status <> 'revoked'
            on conflict (owner_user_id) do update
            set generation = integration_authority_generations.generation + 1,
                updated_at = excluded.updated_at;
          end if;
          return new;
        end
      $$;

      alter table public.integration_auth_attempts
        drop constraint if exists integration_auth_attempts_surface_check;
      alter table public.integration_auth_attempts
        add constraint integration_auth_attempts_surface_check
        check (surface = any (array['desktop'::text, 'native'::text, 'web'::text]));
    `.execute(database);
  },
};

/** Persists one safe, actionable OAuth failure without retaining provider response details. */
export const integrationProviderIdentityFailureMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_auth_attempts
        drop constraint if exists integration_auth_attempts_failure_reason_check;
      alter table public.integration_auth_attempts
        add constraint integration_auth_attempts_failure_reason_check
        check (failure_reason = any (array[
          'cancelled'::text,
          'denied'::text,
          'exchange-failed'::text,
          'provider-identity-already-connected'::text
        ]));
    `.execute(database);
  },
};

/**
 * An access Request can now retain the reviewed installation manifest until it
 * is atomically bound to an installation, and can pin one exact account.
 * Rewrite durable Request snapshots so strict runtime parsing has one shape.
 */
export const unifiedIntegrationAccessMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create temporary table retired_slack_mcp_installations on commit drop as
      select id
      from public.integration_installations
      where source_kind = 'built-in'
        and provenance ->> 'definitionId' = 'slack-mcp';

      update public.integration_installations
      set status = 'disabled', revision = revision + 1, updated_at = now()
      where id in (select id from retired_slack_mcp_installations)
        and status <> 'disabled';

      with affected as (
        select request_row.id, request_row.response_command_id
        from public.requests request_row
        join public.integration_request_details detail on detail.request_id = request_row.id
        where request_row.kind = 'integration.access'
          and request_row.status = 'pending'
          and detail.installation_id in (select id from retired_slack_mcp_installations)
      ),
      failed_commands as (
        update public.commands command_row
        set status = 'failed', updated_at = now(),
          last_error = jsonb_build_object(
            'message', 'The Request was cancelled before its response completed'
          )
        from affected
        where command_row.id = affected.response_command_id
          and command_row.type = 'request.respond'
          and command_row.status in ('pending', 'dispatched', 'unknown')
        returning command_row.id
      ),
      cancelled as (
        update public.requests request_row
        set status = 'cancelled', cancellation_reason = 'authority-revoked',
          resolved_at = now(), resolved_by = null, response = null, response_command_id = null
        where request_row.id in (select id from affected)
        returning request_row.id
      )
      delete from public.request_continuations continuation
      where continuation.request_id in (select id from cancelled);

      alter table public.integration_request_details
        add column if not exists requested_connection_id text;

      update public.requests
      set payload = payload || jsonb_build_object(
        'manifest', null,
        'requestedConnectionId', null
      )
      where kind = 'integration.access';

      update public.workspace_events
      set data = jsonb_set(
        jsonb_set(data, '{request,payload,manifest}', 'null'::jsonb, true),
        '{request,payload,requestedConnectionId}', 'null'::jsonb, true
      )
      where type in ('request.opened', 'request.resolved')
        and data #>> '{request,kind}' = 'integration.access';

      create index if not exists integration_request_details_access_subject_lookup
        on public.integration_request_details(
          installation_id,
          requested_connection_id,
          requested_server_id,
          access
        );
    `.execute(database);
  },
};

/**
 * An enrolled computer may serve connection-scoped integration tools.
 *
 * `integrations` joins every existing Runner grant by set union because an
 * owner's app choice, not enrollment, decides whether a computer serves an
 * app. Computer connections pin that Runner permanently and carry no
 * credential or OAuth authority.
 */
export const computerAppsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existingColumn = await sql<{ exists: boolean }>`
      select exists (
        select 1 from pg_attribute
        where attrelid = 'public.integration_connections'::regclass
          and attname = 'computer_access'
          and not attisdropped
      ) as exists
    `.execute(database);
    await sql`
      alter table public.runners
        drop constraint runners_allowed_modules_check,
        add constraint runners_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 5
          and allowed_modules <@ '["agents", "browser", "integrations", "messaging", "shell"]'::jsonb
        );

      alter table public.runner_enrollments
        drop constraint runner_enrollments_allowed_modules_check,
        add constraint runner_enrollments_allowed_modules_check check (
          jsonb_typeof(allowed_modules) = 'array'
          and jsonb_array_length(allowed_modules) between 1 and 5
          and allowed_modules <@ '["agents", "browser", "integrations", "messaging", "shell"]'::jsonb
        );

      update public.runners
      set allowed_modules = allowed_modules || '["integrations"]'::jsonb
      where not (allowed_modules ? 'integrations');

      update public.runner_enrollments
      set allowed_modules = allowed_modules || '["integrations"]'::jsonb
      where not (allowed_modules ? 'integrations');
    `.execute(database);

    // Fresh databases already carry the connection shape, but the grant
    // convergence above stays safe and also repairs fixtures carved from a
    // newer baseline to exercise an older module constraint.
    if (existingColumn.rows[0]?.exists) return;

    await sql`
      alter table public.integration_connections
        add column computer_access text,
        drop constraint integration_connections_connection_method_check,
        drop constraint integration_connections_kind_check,
        drop constraint integration_connections_kind_shape,
        add constraint integration_connections_connection_method_check check (
          connection_method = any (array[
            'api-key'::text, 'managed-oauth'::text, 'bring-your-own'::text,
            'computer'::text, 'device'::text
          ])
        ),
        add constraint integration_connections_kind_check check (
          connection_kind = any (array[
            'provider-account'::text, 'channel'::text, 'computer'::text, 'mcp-oauth'::text
          ])
        ),
        add constraint integration_connections_computer_access_check check (
          computer_access is null or computer_access = any (array['read'::text, 'read-write'::text])
        ),
        add constraint integration_connections_kind_shape check (
          (connection_kind = 'channel' and transport_kind is not null
            and integration_server_id is null and auth_method_id is null
            and integration_definition_id is null and computer_access is null)
          or (connection_kind = 'provider-account' and transport_kind is null
            and runner_id is null and integration_server_id is null
            and auth_method_id is not null and integration_definition_id is not null
            and computer_access is null)
          or (connection_kind = 'mcp-oauth' and transport_kind is null
            and runner_id is null and provider_application_id is null
            and integration_server_id is not null and auth_method_id is null
            and integration_definition_id is null and computer_access is null)
          or (connection_kind = 'computer' and runner_id is not null
            and integration_server_id is not null and integration_definition_id is not null
            and computer_access is not null and auth_method_id is not null
            and credential_id is null and provider_application_id is null
            and application_source is null and transport_kind is null
            and authorization_digest is null and account_identifier is null
            and external_identity_id is null and external_tenant_id is null)
        );

      create unique index integration_connections_computer_live_unique
        on public.integration_connections(integration_definition_id, runner_id)
        where connection_kind = 'computer' and status <> 'revoked';
    `.execute(database);
  },
};

/** An OAuth app's install page is source authority, not something derivable from its client id. */
export const providerApplicationInstallationUrlMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_provider_applications
        add column installation_url text;
    `.execute(database);
  },
};

/** Retains the broker's bounded OAuth failure classification on the Host attempt. */
export const integrationAuthAttemptFailureClassificationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_auth_attempts
        drop constraint if exists integration_auth_attempts_failure_reason_check;
      alter table public.integration_auth_attempts
        add constraint integration_auth_attempts_failure_reason_check
        check (failure_reason = any (array[
          'account-link-mismatch'::text,
          'authorization-denied'::text,
          'cancelled'::text,
          'catalog-version-skew'::text,
          'client-rejected'::text,
          'denied'::text,
          'exchange-failed'::text,
          'expired'::text,
          'grant-rejected'::text,
          'invalid-provider-response'::text,
          'provider-exchange-failed'::text,
          'provider-identity-already-connected'::text,
          'scope-escalation'::text,
          'stale-provider-application'::text
        ]));
    `.execute(database);
  },
};

/** Separates passive report delivery from work that may start a Run. */
export const threadReportQueueMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.thread_inputs
        drop constraint thread_inputs_policy_check,
        drop constraint thread_inputs_state_shape_check;

      update public.thread_inputs
      set policy = case
        when steer_command_id is not null then 'steer'
        when policy = 'trigger' then 'queue'
        else 'report'
      end;
    `.execute(database);

    let lastMessageId = "";
    while (true) {
      const migratedInputs = await sql<{
        authoritySource: unknown;
        content: unknown;
        messageId: string;
        policy: string;
        threadId: string;
      }>`
        select input.authority_source as "authoritySource", message.content,
          input.message_id as "messageId", input.policy, input.thread_id as "threadId"
        from public.thread_inputs as input
        join public.messages as message on message.id = input.message_id
        where input.message_id > ${lastMessageId}
        order by input.message_id
        limit 100
      `.execute(database);
      if (migratedInputs.rows.length === 0) break;
      for (const input of migratedInputs.rows) {
        if (!isRecord(input.authoritySource) || typeof input.authoritySource.kind !== "string") {
          throw new Error(`Thread input ${input.messageId} has an invalid authority source`);
        }
        const authority = input.authoritySource;
        // Delegation receipts have their own content-only idempotency fingerprint
        // and are never replayed through ordinary Thread input admission.
        if (authority.kind === "delegation-result") continue;
        const source = (() => {
          switch (authority.kind) {
            case "workspace-membership":
              return { kind: "human" };
            case "channel-ingress":
              return {
                kind: "channel",
                conversationId: authority.conversationId,
                ingressId: authority.ingressId,
                principalId: authority.principalId,
              };
            case "thread-agent":
              return { kind: "agent", runId: authority.runId };
            case "trigger-occurrence":
              return { kind: "trigger", occurrenceId: authority.occurrenceId };
            case "watch-observation":
              return {
                kind: "watch",
                activationId: authority.activationId,
                observationId: authority.observationId,
                revisionId: authority.revisionId,
                triggerId: authority.triggerId,
              };
            case "platform":
              return {
                kind: "platform",
                cause: authority.cause,
                ...(authority.referenceId ? { referenceId: authority.referenceId } : {}),
                sourceRunId: authority.sourceRunId,
              };
            default:
              throw new Error(
                `Thread input ${input.messageId} has unknown authority source ${authority.kind}`,
              );
          }
        })();
        const requestFingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              content: ContentPartSchema.array().min(1).parse(input.content),
              policy: input.policy,
              source,
              threadId: input.threadId,
            }),
            "utf8",
          )
          .digest("base64url");
        await sql`
          update public.thread_inputs
          set request_fingerprint = ${requestFingerprint}
          where message_id = ${input.messageId}
        `.execute(database);
      }
      lastMessageId = migratedInputs.rows.at(-1)!.messageId;
    }

    await sql`

      create or replace function public.opensteer_enforce_thread_membership_and_parent()
      returns trigger
      language plpgsql
      as $function$
      declare
        parent_workspace_id text;
      begin
        if tg_op = 'UPDATE'
           and new.id is not distinct from old.id
           and new.workspace_id is not distinct from old.workspace_id
           and new.created_by is not distinct from old.created_by
           and new.parent_thread_id is not distinct from old.parent_thread_id then
          return new;
        end if;
        if not exists (
          select 1
          from public.workspace_memberships
          where workspace_id = new.workspace_id
            and user_id = new.created_by
            and state = 'active'
        ) then
          raise exception 'thread creator must be an active workspace member';
        end if;
        if new.parent_thread_id is null then
          return new;
        end if;
        if new.parent_thread_id = new.id then
          raise exception 'thread cannot be its own parent';
        end if;
        select threads.workspace_id into parent_workspace_id
        from public.threads
        where threads.id = new.parent_thread_id;
        if parent_workspace_id is null then
          raise exception 'parent thread does not exist';
        end if;
        if not exists (
          select 1
          from public.workspace_memberships
          where workspace_id = parent_workspace_id
            and user_id = new.created_by
            and state = 'active'
        ) then
          raise exception 'thread creator must be a member of both parent and child workspaces';
        end if;
        return new;
      end;
      $function$;

      create or replace function public.opensteer_enforce_command_execution_authority()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.type not in (
          'run.execute',
          'trigger.execute',
          'run.steer',
          'run.interrupt',
          'request.respond'
        ) then
          return new;
        end if;
        if new.type = 'run.interrupt' and exists (
          select 1
          from public.runs target_run
          join public.threads thread on thread.id = target_run.thread_id
          join public.workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = new.requested_by
           and membership.state = 'active'
          where target_run.id = new.run_id
            and thread.id = new.thread_id
            and thread.environment_id = new.environment_id
            and (
              target_run.requested_by = new.requested_by
              or membership.role = 'owner'
            )
        ) then
          return new;
        end if;
        if new.thread_id is null
           or new.environment_id is null
           or not exists (
             select 1 from public.threads thread
             where thread.id = new.thread_id
               and thread.environment_id = new.environment_id
               and public.opensteer_user_can_execute_thread(thread.id, new.requested_by)
           ) then
          raise exception 'command requester cannot execute the thread environment';
        end if;
        return new;
      end;
      $function$;

      alter table public.thread_inputs
        add constraint thread_inputs_policy_check check (
          policy = any (array['report'::text, 'queue'::text, 'steer'::text])
        ),
        add constraint thread_inputs_state_shape_check check (
          (state = 'pending' and run_id is null and steer_command_id is null
            and delivered_at is null and cancel_reason is null)
          or (state = 'claimed' and run_id is not null
            and delivered_at is null and cancel_reason is null)
          or (state = 'delivered' and run_id is not null
            and delivered_at is not null and cancel_reason is null)
          or (state = 'unknown' and run_id is not null
            and (policy = 'report' or steer_command_id is not null)
            and delivered_at is null and cancel_reason is null)
          or (state = 'cancelled' and delivered_at is null and cancel_reason is not null)
        );

      update public.workspace_events as event
      set data = jsonb_set(event.data, '{input,policy}', to_jsonb(input.policy), false)
      from public.thread_inputs as input
      where event.data #>> '{input,messageId}' = input.message_id
        and event.data #> '{input,policy}' is not null
        and event.data #>> '{input,policy}' is distinct from input.policy;

      update public.workspace_events
      set data = jsonb_set(data, '{thread,inputQueuePaused}', 'false'::jsonb, true)
      where jsonb_typeof(data -> 'thread') = 'object'
        and not (data -> 'thread' ? 'inputQueuePaused');

      alter table public.threads
        add column input_queue_paused boolean not null default false,
        add column input_queue_paused_by text references public.users(id),
        add constraint threads_input_queue_pause_actor check (
          input_queue_paused = (input_queue_paused_by is not null)
        );

      alter table public.runs
        add column report_context jsonb,
        add constraint runs_report_context_shape check (
          report_context is null or (
            jsonb_typeof(report_context) = 'object'
            and report_context ?& array['messageIds', 'omittedCount', 'throughSequence']
            and report_context = jsonb_build_object(
              'messageIds', report_context -> 'messageIds',
              'omittedCount', report_context -> 'omittedCount',
              'throughSequence', report_context -> 'throughSequence'
            )
            and jsonb_typeof(report_context -> 'messageIds') = 'array'
            and not jsonb_path_exists(
              report_context,
              '$.messageIds[*] ? (@.type() != "string")'
            )
            and jsonb_typeof(report_context -> 'omittedCount') = 'number'
            and report_context ->> 'omittedCount' ~ '^(0|[1-9][0-9]*)$'
            and (
              report_context -> 'throughSequence' = 'null'::jsonb
              or (
                jsonb_typeof(report_context -> 'throughSequence') = 'string'
                and report_context ->> 'throughSequence' ~ '^(0|[1-9][0-9]*)$'
              )
            )
          )
        );

      create view public.thread_work_inputs as
        select * from public.thread_inputs where policy = 'queue';

      create function public.enforce_run_work_seed()
      returns trigger
      language plpgsql
      as $function$
      begin
        if not exists (
          select 1
          from public.thread_inputs as input
          where input.message_id = new.seed_input_id
            and input.thread_id = new.thread_id
            and input.policy = 'queue'
        ) then
          raise exception 'Run seed input must be queued work for the same Thread'
            using errcode = '23514', constraint = 'runs_seed_work_input_check';
        end if;
        return new;
      end;
      $function$;

      create trigger runs_seed_work_input_check
        before insert on public.runs
        for each row execute function public.enforce_run_work_seed();
    `.execute(database);
  },
};

export const triggerProgramToolContractMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.trigger_revisions
      set program = jsonb_set(program, '{toolContractVersion}', '1'::jsonb, true)
      where not (program ? 'toolContractVersion');
    `.execute(database);
  },
};

/**
 * A computer connection may name one app on its Mac.
 *
 * Until now "this definition on this Runner" was the whole identity of a
 * computer connection, and the live unique index said so. Computer use adds a
 * definition — `macos-app` — whose connections name one app each, so the
 * identity gains a third component and the index gains a third column.
 *
 * `computer_app_key` is written by the store from `computerAppIdentityKey`
 * rather than generated from `computer_app` by Postgres. macOS resolves bundle
 * identifiers case-insensitively and the store has to look a connection up by
 * that key, so the key in the index must be the same lowercasing the lookup
 * uses; `lower()` is collation-dependent and JavaScript's is not, and one row
 * written under a collation that disagrees would be a row nothing could find.
 * The pairing checks keep the two columns from drifting apart, and the
 * `coalesce(..., '')` in each unique index keeps every app-less computer
 * connection — Messages and every app like it — under the old rule, because
 * NULLs would otherwise never collide with each other.
 */
export const computerAppIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_connections
        add column computer_app jsonb,
        add column computer_app_key text,
        add constraint integration_connections_computer_app_shape check (
          computer_app is null or (
            jsonb_typeof(computer_app) = 'object'
            and computer_app ?& array['bundleId', 'displayName', 'teamId']
            and jsonb_typeof(computer_app -> 'bundleId') = 'string'
            and jsonb_typeof(computer_app -> 'displayName') = 'string'
            and (
              computer_app -> 'teamId' = 'null'::jsonb
              or jsonb_typeof(computer_app -> 'teamId') = 'string'
            )
          )
        ),
        add constraint integration_connections_computer_app_pairing check (
          (computer_app is null) = (computer_app_key is null)
          and (computer_app_key is null or length(computer_app_key) between 1 and 255)
          and (connection_kind = 'computer' or computer_app is null)
        );

      drop index if exists public.integration_connections_computer_live_unique;
      create unique index integration_connections_computer_live_unique
        on public.integration_connections(
          integration_definition_id, runner_id, coalesce(computer_app_key, '')
        )
        where connection_kind = 'computer' and status <> 'revoked';

      alter table public.computer_app_setup_requests
        add column app jsonb,
        add column app_key text,
        add constraint computer_app_setup_requests_app_shape check (
          app is null or (
            jsonb_typeof(app) = 'object'
            and app ?& array['bundleId', 'displayName', 'teamId']
            and jsonb_typeof(app -> 'bundleId') = 'string'
            and jsonb_typeof(app -> 'displayName') = 'string'
            and (app -> 'teamId' = 'null'::jsonb or jsonb_typeof(app -> 'teamId') = 'string')
          )
        ),
        add constraint computer_app_setup_requests_app_pairing check (
          (app is null) = (app_key is null)
          and (app_key is null or length(app_key) between 1 and 255)
        ),
        drop constraint computer_app_setup_requests_runner_id_definition_id_key;

      create unique index computer_app_setup_requests_app_unique
        on public.computer_app_setup_requests(
          runner_id, definition_id, coalesce(app_key, '')
        );
    `.execute(database);
    // Same textual widening the browser-source migration used: the live
    // definition is the only description of these lists, so it is read and
    // extended rather than restated and silently narrowed.
    for (const name of ["requests_kind_check", "requests_kind_mode_check"] as const) {
      const result = await sql<{ definition: string }>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'public.requests'::regclass and conname = ${name}
      `.execute(database);
      const definition = result.rows[0]?.definition;
      if (!definition) throw new Error(`Cannot extend ${name} for computer app access`);
      if (definition.includes("computer.app.access")) continue;
      const anchor = "'integration.install'::text";
      if (!definition.includes(anchor)) {
        throw new Error(`Cannot extend ${name} for computer app access`);
      }
      const next = definition.replaceAll(anchor, `${anchor}, 'computer.app.access'::text`);
      await sql.raw(`alter table public.requests drop constraint ${name}`).execute(database);
      await sql.raw(`alter table public.requests add constraint ${name} ${next}`).execute(database);
    }
  },
};

/**
 * Adds the policy state introduced after the released 0049 app-identity
 * migration. Keeping this as a new migration lets upgraded databases receive
 * the columns instead of skipping an edited migration they already recorded.
 */
export const computerAppPolicyMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_connections
        add column computer_blocked_at timestamptz,
        add column computer_policy_revision integer check (computer_policy_revision > 0);

      alter table public.computer_app_setup_requests
        add column kind text not null default 'app' check (kind in ('app', 'policy')),
        add column policy_app_approval text,
        add column thread_id text references public.threads(id) on delete set null,
        add column workspace_id text references public.workspaces(id) on delete set null,
        add column reason text,
        add column thread_title text,
        add constraint computer_app_setup_requests_policy_shape check (
          (kind = 'app' and policy_app_approval is null)
          or (kind = 'policy' and policy_app_approval = 'automatic'
              and app is null and definition_id = 'macos-app' and access = 'read-write')
        );

      drop index public.computer_app_setup_requests_app_unique;
      create unique index computer_app_setup_requests_app_unique
        on public.computer_app_setup_requests(
          runner_id, definition_id, kind, coalesce(app_key, '')
        );

      create table public.computer_use_policies (
        deployment_id text not null references public.deployments(id) on delete cascade,
        runner_id text not null references public.runners(id) on delete cascade,
        owner_user_id text not null references public.users(id) on delete cascade,
        app_approval text not null check (app_approval in ('ask', 'automatic')),
        revision integer not null check (revision > 0),
        approval jsonb,
        updated_at timestamptz not null,
        primary key (deployment_id, runner_id, owner_user_id),
        check ((app_approval = 'ask' and approval is null)
          or (app_approval = 'automatic' and approval is not null))
      );
    `.execute(database);
  },
};

/**
 * Approvals are signed by the desktop's own key, pinned per Mac separately
 * from the Runner's authentication key, and a `computer.app.access` Request is
 * answered by the Mac's owner — who is always the requester, because a task
 * can only ask for apps on its own person's Macs.
 *
 * No key is carried over: every existing install approves nothing until its
 * owner opens that Mac's page in Opensteer on the Mac, which registers the
 * desktop's key. A signature by the Runner key was never proof of the person.
 */
export const computerUseApprovalKeysMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.computer_use_approval_keys (
        runner_id text primary key references public.runners(id) on delete cascade,
        owner_user_id text not null references public.users(id) on delete cascade,
        public_key_pem text not null,
        key_id text not null,
        registered_at timestamptz not null
      );

      alter table public.computer_app_setup_requests
        add column workspace_name text check (workspace_name is null or char_length(workspace_name) between 1 and 160);

      update public.computer_app_setup_requests as setup
        set workspace_name = left(workspaces.name, 160)
        from public.workspaces
        where setup.workspace_id = workspaces.id;

      update public.computer_use_policies
        set app_approval = 'ask', approval = null, revision = revision + 1
        where app_approval = 'automatic';

      update public.requests
        set required_actor = 'requester'
        where kind = 'computer.app.access' and status = 'pending';
    `.execute(database);
  },
};

/**
 * An account's default model and reasoning level are whatever its engine
 * reports, and a Run's are what its selection names. Claude Code and Codex
 * accounts once stored their own `model`, `effort` and `reasoningEffort`,
 * which could name a model the engine no longer lists and so take the whole
 * account down; the drivers' strict schemas no longer accept them. Removing
 * them is a configuration change, handled exactly like 0025.
 */
export const harnessModelDefaultsFromEngineMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      with changed as (
        update public.harness_instances
          set config = config - 'model' - 'effort' - 'reasoningEffort',
              runtime_revision = runtime_revision + 1,
              updated_at = now()
          where driver_kind in ('claude', 'codex')
            and config ?| array['model', 'effort', 'reasoningEffort']
          returning id
      )
      delete from public.harness_catalogs
        where harness_instance_id in (select id from changed);
    `.execute(database);
  },
};

/** Existing compatible selections retain the model identities their catalogs recorded. */
export const compatibleEndpointModelIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      with changed as (
        update public.harness_instances
          set config = jsonb_set(config, '{modelIdentity}', '"legacy"'::jsonb),
              runtime_revision = runtime_revision + 1,
              updated_at = now()
          where driver_kind in ('pi', 'opencode')
            and source_id = 'openai-compatible'
            and jsonb_typeof(config) = 'object'
            and not config ? 'modelIdentity'
          returning id
      )
      delete from public.harness_catalogs
        where harness_instance_id in (select id from changed);
    `.execute(database);
  },
};

/**
 * The shape and platform a computer describes itself with, kept beside what it
 * advertises so a computer that is away is still drawn as itself.
 */
export const runnerDeviceMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.runners
        add column if not exists device jsonb,
        drop constraint if exists runners_device_check,
        add constraint runners_device_check check (
          device is null or jsonb_typeof(device) = 'object'
        )
    `.execute(database);
  },
};

export const attachmentsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.attachments (
        id text primary key check (id ~ '^att_[0-9a-f-]{36}$'),
        workspace_id text not null references public.workspaces(id) on delete cascade,
        uploader_id text not null references public.users(id) on delete cascade,
        name text not null check (length(name) between 1 and 255),
        media_type text not null check (length(media_type) between 1 and 255),
        size_bytes integer not null check (size_bytes between 0 and 26214400),
        kind text check (kind in ('image', 'file')),
        width integer check (width > 0),
        height integer check (height > 0),
        sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
        state text not null check (state in ('uploading', 'ready', 'deleting')),
        idempotency_key text not null check (length(idempotency_key) between 1 and 255),
        request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
        message_id text references public.messages(id) on delete cascade,
        thread_id text references public.threads(id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        unique (uploader_id, idempotency_key),
        check ((message_id is null) = (thread_id is null)),
        check ((state = 'uploading' and sha256 is null and kind is null and message_id is null) or
               (state = 'ready' and sha256 is not null and kind is not null) or
               (state = 'deleting' and message_id is null))
      );
      create index attachments_workspace on public.attachments(workspace_id, created_at);
      create index attachments_thread on public.attachments(thread_id, id) where message_id is not null;
      create index attachments_expiry on public.attachments(expires_at) where message_id is null;
    `.execute(database);
  },
};

/** A selected native conversation exists independently of a process binding. */
const durableProviderSessionsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.provider_sessions
        drop constraint provider_sessions_active_status_check,
        alter column runner_id drop not null,
        alter column runner_boot_id drop not null,
        alter column lease_token_hash drop not null,
        alter column lease_expires_at drop not null,
        alter column binding_generation set default 0,
        add column continuation_identity jsonb,
        add column state_layout text not null default 'thread'
          check (state_layout in ('thread', 'session'));

      update public.provider_sessions session
      set continuation_identity = thread.continuation_identity
      from public.threads thread
      where session.thread_id = thread.id;

      insert into public.provider_sessions (
        id, thread_id, harness_instance_id, provider_session_reference,
        runner_id, runner_boot_id, binding_generation, lease_token_hash,
        lease_expires_at, status, active, continuation_identity, state_layout
      )
      select 'psn_' || gen_random_uuid()::text, thread.id, thread.harness_instance_id,
        null, null, null, 0, null, null, 'starting', true,
        thread.continuation_identity, 'thread'
      from public.threads thread
      join public.harness_instances harness
        on harness.id = thread.harness_instance_id
      where not exists (
        select 1 from public.provider_sessions session
        where session.thread_id = thread.id and session.active
      );

      alter table public.provider_sessions
        add constraint provider_sessions_binding_fields_check check (
          (runner_id is null and runner_boot_id is null and lease_token_hash is null and lease_expires_at is null)
          or (runner_id is not null and runner_boot_id is not null and lease_token_hash is not null and lease_expires_at is not null)
        ),
        add constraint provider_sessions_continuation_identity_check check (
          continuation_identity is null or jsonb_typeof(continuation_identity) = 'object'
        ),
        add constraint provider_sessions_reference_identity_check check (
          provider_session_reference is null or continuation_identity is not null
        );

      create or replace function public.opensteer_protect_provider_session_identity()
      returns trigger language plpgsql as $$
      begin
        if new.thread_id is distinct from old.thread_id
           or new.state_layout is distinct from old.state_layout then
          raise exception 'ProviderSession thread and state layout are immutable';
        end if;
        if old.continuation_identity is not null
           and new.continuation_identity is distinct from old.continuation_identity
           and coalesce(current_setting('opensteer.continuation_adoption', true), '') <> 'on' then
          raise exception 'ProviderSession continuation identity is immutable once established';
        end if;
        return new;
      end;
      $$;
      create trigger provider_sessions_protect_identity
        before update on public.provider_sessions for each row
        execute function public.opensteer_protect_provider_session_identity();

      alter table public.runs
        add column provider_session_id text,
        add column initial_context jsonb;
      create unique index provider_sessions_id_thread_unique on public.provider_sessions(id, thread_id);
      alter table public.runs add constraint runs_provider_session_thread_fkey
        foreign key (provider_session_id, thread_id)
        references public.provider_sessions(id, thread_id) on delete restrict;
      create index runs_provider_session on public.runs(provider_session_id, status)
        where provider_session_id is not null;

      -- A single historical candidate with the Run's harness is evidence;
      -- multiple candidates are deliberately left unresolved.
      update public.runs run
      set provider_session_id = candidate.id
      from (
        select run_inner.id as run_id, min(session.id) as id
        from public.runs run_inner
        join public.provider_sessions session
          on session.thread_id = run_inner.thread_id
         and session.harness_instance_id = run_inner.harness_instance_id
        group by run_inner.id
        having count(*) = 1
      ) candidate
      where run.id = candidate.run_id;

      do $$
      begin
        if exists (
          select 1 from public.runs
          where status in ('queued', 'starting', 'running', 'waiting')
            and provider_session_id is null
        ) then
          raise exception 'Cannot migrate a nonterminal Run without an exact ProviderSession';
        end if;
      end;
      $$;

      create or replace function public.opensteer_require_run_provider_session()
      returns trigger language plpgsql as $$
      begin
        if new.provider_session_id is null then
          raise exception 'a newly admitted Run requires a ProviderSession';
        end if;
        return new;
      end;
      $$;
      create trigger runs_require_provider_session
        before insert on public.runs for each row
        execute function public.opensteer_require_run_provider_session();

      create or replace function public.opensteer_prevent_thread_binding_change()
      returns trigger language plpgsql as $$
      begin
        if new.environment_id is distinct from old.environment_id
           or new.parent_thread_id is distinct from old.parent_thread_id
           or new.workspace_id is distinct from old.workspace_id
           or new.created_by is distinct from old.created_by then
          raise exception 'thread ownership, execution environment, and lineage are immutable';
        end if;
        return new;
      end;
      $$;
      alter table public.threads drop column continuation_identity;

      alter table public.workspaces add column home_thread_id text;
      alter table public.workspaces add constraint workspaces_home_main_only_check
        check (home_thread_id is null or kind = 'main');
      create unique index threads_id_workspace_unique on public.threads(id, workspace_id);
      alter table public.workspaces add constraint workspaces_home_thread_workspace_fkey
        foreign key (home_thread_id, id)
        references public.threads(id, workspace_id) on delete set null (home_thread_id);
    `.execute(database);
  },
};

/** Per-person reading and specialist alert choices, plus passive report delivery. */
export const homeNotificationStateMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table if not exists public.thread_read_markers (
        thread_id text not null references public.threads(id) on delete cascade,
        user_id text not null references public.users(id) on delete cascade,
        sequence bigint not null default 0 check (sequence >= 0),
        updated_at timestamptz not null default now(),
        primary key (thread_id, user_id)
      );
      create index if not exists thread_read_markers_user on public.thread_read_markers(user_id, thread_id);

      create table if not exists public.agent_notification_mutes (
        workspace_id text not null references public.workspaces(id) on delete cascade,
        user_id text not null references public.users(id) on delete cascade,
        muted boolean not null,
        updated_at timestamptz not null default now(),
        primary key (workspace_id, user_id)
      );
      create index if not exists agent_notification_mutes_user on public.agent_notification_mutes(user_id, workspace_id)
        where muted;

      insert into public.thread_read_markers(thread_id, user_id, sequence)
      select thread.id, membership.user_id, last_visible.sequence
      from public.threads thread
      join public.workspace_memberships membership
        on membership.workspace_id = thread.workspace_id and membership.state = 'active'
      cross join lateral (
          select max(message.sequence) as sequence
          from public.messages message
          left join public.thread_inputs inbox on inbox.message_id = message.id
          where message.thread_id = thread.id
            and (message.kind in ('assistant', 'run-result')
              or (message.kind = 'input' and (
                (inbox.policy = 'report' and inbox.state <> 'cancelled')
                or (inbox.policy <> 'report' and inbox.state = 'delivered')
              )))
      ) last_visible
      where last_visible.sequence is not null
      on conflict (thread_id, user_id) do nothing;

      alter table public.notification_outbox
        add column if not exists message_id text,
        add column if not exists message_sequence bigint,
        add column if not exists source_workspace_id text,
        drop constraint if exists notification_outbox_message_sequence_check,
        add constraint notification_outbox_message_sequence_check
          check (message_sequence is null or message_sequence >= 0),
        drop constraint if exists notification_outbox_kind_check,
        drop constraint if exists notification_outbox_origin_check,
        add constraint notification_outbox_kind_check check (
          kind in ('request-opened', 'run-completed', 'run-failed', 'run-interrupted', 'report-published')
        ),
        add constraint notification_outbox_origin_check check (
          (kind = 'request-opened' and request_id is not null and message_id is null)
          or (kind = 'report-published' and request_id is null and message_id is not null
              and message_sequence is not null and source_workspace_id is not null)
          or (kind in ('run-completed', 'run-failed', 'run-interrupted')
              and request_id is null and run_id is not null and message_id is null)
        );
    `.execute(database);
  },
};

/** Each viewer's mute choice has a durable monotonic ordering across devices. */
export const workspaceNotificationPreferenceRevisionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.agent_notification_mutes
        add column if not exists revision bigint not null default 1
          check (revision > 0);
      create index if not exists agent_notification_mutes_user_all
        on public.agent_notification_mutes(user_id, workspace_id)
    `.execute(database);
  },
};

/**
 * A Run can hold several Browser Sessions at once and addresses each by ID, so
 * an attachment is one (binding, session) pair rather than one slot per binding
 * that every open overwrote.
 */
export const browserSessionAttachmentSetMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.browser_session_attachments
        drop constraint browser_session_attachments_pkey,
        add constraint browser_session_attachments_pkey primary key (agent_binding_id, session_id);
    `.execute(database);
  },
};

/**
 * Migration names are the durable key: Kysely records each one and refuses to
 * run against a database that recorded a name the code no longer offers, or
 * that offers an earlier name after a recorded one. A released name is
 * therefore never renamed or renumbered.
 */
const homeMessageLookupMigration: Migration = {
  async up(database) {
    await sql`ALTER TABLE public.messages ADD COLUMN quote jsonb;
      CREATE INDEX messages_text_search ON public.messages USING gin
      (jsonb_to_tsvector('simple', jsonb_path_query_array(content, '$[*] ? (@.type == "text").text'), '["string"]'));
    `.execute(database);
  },
};

/** A finite objective survives Run boundaries and has an explicit outcome. */
export const assignmentsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.threads
        add column role text not null default 'work',
        add constraint threads_role_check check (role in ('conversation', 'work'));
      update public.threads as thread set role = 'conversation'
        from public.workspaces as workspace
        where workspace.home_thread_id = thread.id;
      update public.threads as thread set role = 'conversation'
        from public.channel_conversation_contexts as context
        join public.channel_conversations as conversation on conversation.id = context.conversation_id
        join public.workspaces as workspace on workspace.id = conversation.workspace_id
        where context.active_thread_id = thread.id
          and conversation.conversation_type = 'dm'
          and workspace.kind = 'main'
          and workspace.created_by = context.authority_user_id;

      alter table public.delegations
        add column initial_input_message_id text,
        add column objective text,
        add column origin text,
        add column parent_assignment_id text references public.delegations(id) on delete restrict,
        add column status text,
        add column result_text text,
        add column result_run_id text,
        add column finished_at timestamptz,
        add column revision integer not null default 1,
        add column updated_at timestamptz not null default now();
      -- A delegation settled when its one child Run ended. One whose child Run
      -- is still active stays open so the new completion rule finishes it; one
      -- whose Run ended but whose result never reached the parent keeps its
      -- pending return so the outbox delivers it exactly once.
      update public.delegations as assignment
        set initial_input_message_id = run.seed_input_id,
            objective = left(thread.title, 2048),
            origin = case
              when assignment.parent_run_id is not null then 'run'
              when assignment.parent_occurrence_id is not null then 'trigger'
              else 'watch' end,
            status = case
              when run.status in ('queued', 'starting', 'running', 'waiting') then 'open'
              when run.status = 'failed' then 'failed'
              when run.status = 'interrupted' then 'cancelled'
              else 'completed' end,
            result_text = case when run.status in ('queued', 'starting', 'running', 'waiting') then null
              else 'This task settled before the Assignment upgrade. Read its task Thread for the result.' end,
            result_run_id = case
              when run.status in ('queued', 'starting', 'running', 'waiting', 'interrupted') then null
              else assignment.child_run_id end,
            finished_at = case when run.status in ('queued', 'starting', 'running', 'waiting') then null
              else coalesce(assignment.completed_at, run.completed_at, now()) end,
            updated_at = coalesce(assignment.completed_at, run.completed_at, assignment.created_at)
        from public.runs as run
        join public.threads as thread on thread.id = run.thread_id
        where assignment.child_run_id = run.id;
      alter table public.delegations
        alter column initial_input_message_id set not null,
        alter column objective set not null,
        alter column origin set not null,
        alter column status set not null,
        add constraint assignments_origin_check check (
          (origin = 'run' and parent_run_id is not null)
          or (origin = 'trigger' and parent_occurrence_id is not null)
          or (origin = 'watch' and parent_watch_activation_id is not null)),
        add constraint assignments_status_check check (
          status in ('open', 'completed', 'failed', 'cancelled')
          and ((status = 'open') = (finished_at is null))
          and (status <> 'open' or result_status = 'pending')),
        add constraint assignments_result_check check (
          (status = 'open' and result_text is null and result_run_id is null)
          or (status = 'cancelled' and result_run_id is null)
          or (status in ('completed', 'failed') and octet_length(result_text) >= 1
            and result_run_id is not null)),
        add constraint assignments_size_check check (
          octet_length(objective) between 1 and 2048
          and (result_text is null or octet_length(result_text) <= 65536)),
        add constraint assignments_revision_check check (revision > 0);
      create unique index assignments_one_open_per_worker
        on public.delegations(child_thread_id) where status = 'open';
      create index assignments_parent_open
        on public.delegations(parent_assignment_id, status) where parent_assignment_id is not null;
      create index assignments_return_outbox
        on public.delegations(result_status, result_attempted_at, created_at)
        where result_status = 'pending';

      alter table public.runs
        add column assignment_id text references public.delegations(id)
          deferrable initially deferred;
      alter table public.thread_inputs
        add column assignment_id text references public.delegations(id)
          deferrable initially deferred;
    `.execute(database);
    await sql`
      create or replace view public.thread_work_inputs as
        select * from public.thread_inputs where policy = 'queue';
      -- Indexes first: the backfill below leaves deferred foreign-key checks
      -- pending on these tables, and PostgreSQL then refuses to index them.
      create index runs_assignment on public.runs(assignment_id, status) where assignment_id is not null;
      create index thread_inputs_assignment on public.thread_inputs(assignment_id, state)
        where assignment_id is not null;
      update public.runs as run set assignment_id = assignment.id
        from public.delegations as assignment where run.id = assignment.child_run_id;
      update public.thread_inputs as input set assignment_id = assignment.id
        from public.delegations as assignment
        where input.message_id = assignment.initial_input_message_id;
      update public.delegations as child set parent_assignment_id = parent.id
        from public.runs as parent_run
        join public.delegations as parent on parent.id = parent_run.assignment_id
        where child.parent_run_id = parent_run.id;
      alter table public.agent_control_requests
        drop constraint agent_control_requests_action_check,
        drop constraint agent_control_requests_action_class_check,
        add constraint agent_control_requests_action_check check (
          action in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write')),
        add constraint agent_control_requests_action_class_check check (
          action_class in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write'));
    `.execute(database);
  },
};

/** Shared provider types replace the closures older adapters copied into every tool. */
export const integrationToolDefinitionsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    const existing = await sql<{ present: boolean }>`
      select to_regclass('public.integration_tool_definitions') is not null as present
    `.execute(database);
    // A fresh baseline already has the column and document table.
    if (existing.rows[0]?.present) return;
    await sql`
      alter table public.integration_tools add column definition_names text[] not null default '{}';
      create table public.integration_tool_definitions (
        server_id text not null references public.integration_servers(id) on delete restrict,
        connection_id text references public.integration_connections(id) on delete restrict,
        definitions jsonb not null,
        updated_at timestamptz not null default now(),
        constraint integration_tool_definitions_document check (
          jsonb_typeof(definitions) = 'object' and octet_length(definitions::text) <= 8388608),
        constraint integration_tool_definitions_scope unique nulls not distinct (server_id, connection_id)
      );
    `.execute(database);
    let after: IntegrationServerId | null = null;
    for (;;) {
      const result = await sql<{ id: IntegrationServerId }>`
        select s.id from public.integration_servers s
        join public.integration_installations i on i.id = s.installation_id
        where s.transport ->> 'type' = 'adapter'
          and i.adapter_snapshot ->> 'adapter' in ('openapi', 'graphql')
          and (${after}::text is null or s.id > ${after})
        order by s.id limit 1
      `.execute(database);
      const server: { id: IntegrationServerId } | undefined = result.rows[0];
      if (!server) break;
      after = server.id;
      const rows = await sql<IntegrationToolMaterial>`
        select annotations, connection_id, description, id, input_schema, name, output_schema,
          status, title from public.integration_tools
        where server_id = ${server.id} and status = 'active' order by id
      `.execute(database);
      const scopes = new Map<IntegrationConnectionId | null, IntegrationToolMaterial[]>();
      for (const row of rows.rows) {
        const tools = scopes.get(row.connectionId) ?? [];
        tools.push(row);
        scopes.set(row.connectionId, tools);
      }
      for (const [connectionId, tools] of scopes) {
        const definitions: Record<string, Readonly<Record<string, unknown>>> = {};
        const digests = new Map<string, string>();
        let conflict = false;
        const strip = (schema: Readonly<Record<string, unknown>>) => {
          const { $defs, ...root } = schema;
          if ($defs === undefined) return root;
          if (!isRecord($defs)) {
            conflict = true;
            return root;
          }
          for (const [name, definition] of Object.entries($defs)) {
            if (!isRecord(definition)) {
              conflict = true;
              continue;
            }
            const digest = integrationSchemaDigest(definition);
            if (digests.has(name) && digests.get(name) !== digest) conflict = true;
            digests.set(name, digest);
            Object.defineProperty(definitions, name, {
              configurable: true,
              enumerable: true,
              value: definition,
            });
          }
          return root;
        };
        const stripped = tools.map((tool) => ({
          ...tool,
          inputSchema: strip(tool.inputSchema),
          outputSchema: tool.outputSchema === null ? null : strip(tool.outputSchema),
        }));
        if (conflict) continue;
        const catalog = materializeToolCatalog({ definitions, tools: stripped });
        const size = await sql<{ bytes: number }>`
          select octet_length(${jsonValue(catalog.definitions)}::text) as bytes
        `.execute(database);
        // An old scope may exceed the document limit even though each copied closure fitted.
        if (size.rows[0]!.bytes > 8388608) continue;
        for (const tool of catalog.tools) {
          await sql`
            update public.integration_tools set input_schema = ${jsonValue(tool.inputSchema)},
              output_schema = ${tool.outputSchema === null ? null : jsonValue(tool.outputSchema)},
              definition_names = ${[...tool.definitionNames]}::text[], schema_digest = ${tool.schemaDigest}
            where id = ${tool.id}
          `.execute(database);
        }
        if (Object.keys(catalog.definitions).length > 0) {
          await sql`
            insert into public.integration_tool_definitions(server_id, connection_id, definitions)
            values (${server.id}, ${connectionId}, ${jsonValue(catalog.definitions)})
          `.execute(database);
        }
      }
    }
  },
};

/**
 * An OpenAPI tool records the operation it runs, so no call finds it by a
 * planned name, and a name belongs to one active tool: a renamed operation can
 * take a name a tool that is gone still holds. A target is part of the stored
 * document, so it is bounded as that is. The Host binds tools stored before
 * this at startup, from their snapshots.
 */
export const integrationToolTargetsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_tools
        add column if not exists target jsonb,
        drop constraint if exists integration_tools_target_check,
        add constraint integration_tools_target_check check (
          target is null or (jsonb_typeof(target) = 'object' and octet_length(target::text) <= 8388608)
        );
      drop index if exists public.integration_tools_server_connection_name;
      create unique index integration_tools_server_connection_name
        on public.integration_tools (server_id, connection_id, name) nulls not distinct
        where status = 'active';
    `.execute(database);
  },
};

export const triggerAgentAuthorityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.triggers
        add column created_by_thread_id text references public.threads(id) on delete set null;
      alter table public.trigger_revisions
        add column created_by_thread_id text references public.threads(id) on delete set null;
    `.execute(database);
  },
};

export function migrationProvider() {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      return {
        "0001_baseline": baselineMigration,
        "0002_canonical_tool_identity": canonicalToolIdentityMigration,
        "0003_fixed_integration_authorization": fixedIntegrationAuthorizationMigration,
        "0004_canonical_tool_output": canonicalToolOutputMigration,
        "0005_authorization_result_connection": authorizationResultConnectionMigration,
        "0006_environment_harness_instances": environmentHarnessInstancesMigration,
        "0007_owned_native_oauth_callback": ownedNativeOAuthCallbackMigration,
        "0008_personal_account_link_activation_state": personalAccountLinkActivationStateMigration,
        "0009_integration_account_identifier": integrationAccountIdentifierMigration,
        "0010_deployment_axes": deploymentAxesMigration,
        "0011_trigger_originated_requests": triggerOriginatedRequestsMigration,
        "0012_deployment_kind_and_host_identity": deploymentKindAndHostIdentityMigration,
        "0013_integration_access_class": integrationAccessClassMigration,
        "0014_administrator_directory_projection": administratorDirectoryProjectionMigration,
        "0015_account_directory_projection_revision": accountDirectoryProjectionRevisionMigration,
        "0016_continuation_identity_adoption": continuationIdentityAdoptionMigration,
        "0017_trigger_downstream_run_lookup": triggerDownstreamRunLookupMigration,
        "0018_channel_runtime_enrollment_idempotency": channelRuntimeEnrollmentIdempotencyMigration,
        "0019_runner_enrollment_name": runnerEnrollmentNameMigration,
        "0020_runner_owned_local_workspaces": runnerOwnedLocalWorkspacesMigration,
        "0021_watch_triggers": watchTriggersMigration,
        "0022_one_machine_identity": oneMachineIdentityMigration,
        "0023_machine_access": machineAccessMigration,
        "0024_advertised_agents_capacity": advertisedAgentsCapacityMigration,
        "0025_harness_executables_from_runtime": harnessExecutablesFromRuntimeMigration,
        "0026_positive_machine_local_sessions": positiveMachineLocalSessionsMigration,
        "0027_notification_outbox": notificationOutboxMigration,
        "0028_machine_full_disk_access": machineFullDiskAccessMigration,
        "0029_default_harness_per_driver": defaultHarnessPerDriverMigration,
        "0030_harness_account_sources": harnessAccountSourcesMigration,
        "0031_messaging_sender_pull_linking": messagingSenderPullLinkingMigration,
        "0032_channel_dead_concepts": channelDeadConceptsMigration,
        "0033_harness_default_lifecycle": harnessDefaultLifecycleMigration,
        "0034_channel_durable_access": channelDurableAccessMigration,
        "0035_run_usage_accounting": runUsageAccountingMigration,
        "0036_cursor_model_identity": cursorModelIdentityMigration,
        "0037_user_execution_preferences": userExecutionPreferencesMigration,
        "0038_owner_scoped_integration_provider_applications":
          ownerScopedIntegrationProviderApplicationsMigration,
        "0039_integration_provider_identity_failure": integrationProviderIdentityFailureMigration,
        "0040_unified_integration_access": unifiedIntegrationAccessMigration,
        "0041_computer_apps": computerAppsMigration,
        "0042_provider_application_installation_url": providerApplicationInstallationUrlMigration,
        "0043_integration_auth_attempt_failure_classification":
          integrationAuthAttemptFailureClassificationMigration,
        "0044_thread_report_queue": threadReportQueueMigration,
        "0045_trigger_program_tool_contract": triggerProgramToolContractMigration,
        "0046_computer_app_setup_requests": computerAppSetupRequestsMigration,
        "0047_browser_sources": browserSourcesMigration,
        "0048_browser_sources_retirement": browserSourcesRetirementMigration,
        "0049_computer_app_identity": computerAppIdentityMigration,
        "0050_computer_app_policy": computerAppPolicyMigration,
        "0051_computer_use_approval_keys": computerUseApprovalKeysMigration,
        "0052_harness_model_defaults_from_engine": harnessModelDefaultsFromEngineMigration,
        "0053_runner_device": runnerDeviceMigration,
        "0054_browser_sources_restoration": browserSourcesRestorationMigration,
        "0055_browser_sign_ins": browserSignInsMigration,
        "0056_thread_input_queue_order": threadInputQueueOrderMigration,
        "0057_attachments": attachmentsMigration,
        "0058_workspace_icon": workspaceIconMigration,
        "0059_compatible_endpoint_model_identity": compatibleEndpointModelIdentityMigration,
        "0060_browser_session_attachment_set": browserSessionAttachmentSetMigration,
        "0061_durable_provider_sessions": durableProviderSessionsMigration,
        "0062_home_notification_state": homeNotificationStateMigration,
        "0063_home_message_lookup": homeMessageLookupMigration,
        "0064_workspace_notification_preference_revision":
          workspaceNotificationPreferenceRevisionMigration,
        "0065_assignments": assignmentsMigration,
        "0066_computer_channels": computerChannelsMigration,
        "0067_local_mcp_servers": localMcpServersMigration,
        "0068_assignment_work_view": assignmentWorkViewMigration,
        "0069_listed_threads": listedThreadsMigration,
        "0070_chat_thread_title": chatThreadTitleMigration,
        "0071_assignment_run_models": assignmentRunModelsMigration,
        "0072_run_reply": runReplyMigration,
        "0073_computer_use_stops": computerUseStopsMigration,
        "0074_run_binding_generation": runBindingGenerationMigration,
        "0075_thread_state": threadStateMigration,
        "0076_thread_state_pending": threadStatePendingMigration,
        "0077_workspace_owner_fence": workspaceOwnerFenceMigration,
        "0078_deferred_integration_authority": deferredIntegrationAuthorityMigration,
        "0079_run_attempts_and_grants": runAttemptsAndGrantsMigration,
        "0080_run_attempt_facts": runAttemptFactsMigration,
        "0081_execution_nodes": executionNodesMigration,
        "0082_run_background": runBackgroundMigration,
        "0083_run_attempt_engine_start": runAttemptEngineStartMigration,
        "0084_notifications": notificationsMigration,
        "0085_finished_one_time_triggers": finishedOneTimeTriggersMigration,
        "0086_password_sign_in_requests": passwordSignInRequestsMigration,
        "0087_request_call_joins": requestCallJoinsMigration,
        "0088_browser_session_uses": browserSessionUsesMigration,
        "0089_thread_task_placement": threadTaskPlacementMigration,
        "0090_thread_task_placement_revision": threadTaskPlacementRevisionMigration,
        "0091_integration_tool_definitions": integrationToolDefinitionsMigration,
        "0092_integration_reasons": integrationReasonsMigration,
        "0093_integration_tool_targets": integrationToolTargetsMigration,
        "0094_integration_proposal_reason": integrationProposalReasonMigration,
        "0095_browser_person_opens": browserPersonOpensMigration,
        "0096_browser_tab_open_retention": browserTabOpenRetentionMigration,
        "0097_runner_update_required": runnerUpdateRequiredMigration,
        "0098_workspace_tabs": workspaceTabsMigration,
        "0099_workspace_tab_icons": workspaceTabIconsMigration,
        "0100_agent_phone_owner_access": agentPhoneOwnerAccessMigration,
        "0101_browser_tab_groups": browserTabGroupsMigration,
        "0102_thread_title_source": threadTitleSourceMigration,
        "0103_task_marks": taskMarksMigration,
        "0104_run_recovery": runRecoveryMigration,
        "0105_browser_tab_order": browserTabOrderMigration,
        "0106_trigger_agent_authority": triggerAgentAuthorityMigration,
        "0107_agent_browser_profile_create": agentBrowserProfileCreateMigration,
        "0108_drop_host_notifications": dropHostNotificationsMigration,
        "0109_workspace_tab_reopen": workspaceTabReopenMigration,
        "0110_iphone_device_profile": iphoneDeviceProfileMigration,
        "0111_environment_discovery": environmentDiscoveryMigration,
        "0112_task_done": taskDoneMigration,
        "0113_person_asked_threads": personAskedThreadsMigration,
        "0114_run_started_by": runStartedByMigration,
        "0115_better_auth_17": betterAuth17Migration,
        "0116_screen_show": screenShowMigration,
        "0117_remove_screen_show": removeScreenShowMigration,
        "0118_browser_history": browserHistoryMigration,
        "0119_native_browser_profiles": nativeBrowserProfilesMigration,
      };
    },
  };
}

/**
 * A channel whose transport runs on one computer — iMessage through that
 * Mac's Messages — is pinned there, holds no secret, and is a use of that
 * computer's app connection, which it never outlives: revoking the app
 * revokes the channel first, so an uninstall that then deletes the app's row
 * leaves only a revoked channel without its source. Every computer may now
 * carry `messaging` for such transports, as every one carries `integrations`.
 */
export const computerChannelsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_connections
        add column source_connection_id text
          references public.integration_connections(id) on delete set null,
        drop constraint integration_connections_transport_kind_check,
        add constraint integration_connections_transport_kind_check
          check (transport_kind = any (array['socket', 'polling', 'computer'])),
        add constraint integration_connections_computer_channel_shape check (
          (source_connection_id is null or transport_kind is not distinct from 'computer')
          and (transport_kind is distinct from 'computer' or (
            connection_kind = 'channel'
            and runner_id is not null
            and credential_id is null
            and (source_connection_id is not null or status = 'revoked')))
        );

      update public.runners
      set allowed_modules = allowed_modules || '["messaging"]'::jsonb
      where not (allowed_modules ? 'messaging');

      update public.runner_enrollments
      set allowed_modules = allowed_modules || '["messaging"]'::jsonb
      where not (allowed_modules ? 'messaging');
    `.execute(database);
  },
};

/**
 * An Agent Plugin's MCP server that starts a program, or listens on a
 * computer's own loopback, runs on one computer instead of inside the Host:
 * pinned there, and started only once that computer's owner approved its
 * exact launch on it (`approved_launch_digest`). The approval rides the setup
 * requests every other approval on a Mac does, as `kind = 'server'`. A server
 * the Host ran itself moves to the Deployment's Main computer and waits there
 * for that approval; with no Main computer it waits for the plugin to be
 * installed again, naming the computer that runs it.
 */
export const localMcpServersMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.integration_servers
        add column approved_launch_digest text check (
          approved_launch_digest is null or char_length(approved_launch_digest) between 1 and 128
        );

      alter table public.computer_app_setup_requests
        add column server jsonb,
        drop constraint computer_app_setup_requests_kind_check,
        add constraint computer_app_setup_requests_kind_check
          check (kind in ('app', 'policy', 'server')),
        drop constraint computer_app_setup_requests_policy_shape,
        add constraint computer_app_setup_requests_kind_shape check (
          (kind = 'app' and policy_app_approval is null and server is null)
          or (kind = 'policy' and policy_app_approval = 'automatic' and app is null
              and definition_id = 'macos-app' and access = 'read-write' and server is null)
          or (kind = 'server' and policy_app_approval is null and app is null
              and access = 'read-write' and server is not null
              and jsonb_typeof(server) = 'object'
              and coalesce(server ->> 'serverId' = definition_id, false))
        );
    `.execute(database);
    const main = await sql<{ readonly id: string }>`
      select id from public.runners
      where kind = 'main' and revoked_at is null
      order by enrolled_at asc
      limit 1
    `.execute(database);
    const runnerId = main.rows[0]?.id ?? null;
    const servers = await sql<{ readonly id: string; readonly transport: unknown }>`
      select id, transport from public.integration_servers
      where transport ->> 'type' in ('stdio', 'streamable-http')
    `.execute(database);
    for (const server of servers.rows) {
      const transport = isRecord(server.transport) ? server.transport : {};
      const local =
        transport.type === "stdio" ||
        (typeof transport.url === "string" && isLoopbackHostname(new URL(transport.url).hostname));
      if (!local) continue;
      await sql`
        update public.integration_servers
        set transport = ${JSON.stringify({ launch: transport, runnerId, type: "runner" })}::jsonb,
            status = 'needs-attention',
            status_detail = ${
              runnerId
                ? "Waiting for approval on the computer that runs it."
                : "Install this plugin again, choosing the computer that runs this server."
            },
            updated_at = now()
        where id = ${server.id}
      `.execute(database);
    }
  },
};

/** Earlier Assignment upgrades may have left the work view without its new column. */
export const assignmentWorkViewMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create or replace view public.thread_work_inputs as
        select * from public.thread_inputs where policy = 'queue';
    `.execute(database);
  },
};

/**
 * Navigation lists a Thread when it is a root or work a conversation handed
 * off, not when it merely has no parent. Durable Thread events are rewritten
 * to the Thread's current shape, including the role 0065 added, so replay
 * parses exactly as a live event does.
 */
export const listedThreadsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.threads add column listed boolean not null default true;
      update public.threads as thread set listed = false
        from public.threads as parent
        where parent.id = thread.parent_thread_id and parent.role <> 'conversation';
      alter table public.threads alter column listed drop default;

      update public.workspace_events as event
      set data = jsonb_set(
        jsonb_set(event.data, '{thread,listed}', to_jsonb(thread.listed), true),
        '{thread,role}', to_jsonb(thread.role), true)
      from public.threads as thread
      where event.thread_id = thread.id
        and jsonb_typeof(event.data -> 'thread') = 'object'
        and event.data #>> '{thread,id}' = thread.id;
    `.execute(database);
  },
};

/**
 * Home is now called Chat. Clients titled the Thread when they created it, so
 * each person's stored title and the durable Thread snapshots in its events
 * are renamed; the Host titles every new one. Only the Thread a Workspace
 * names as its Chat changes: a task someone called Home keeps its title.
 */
const chatThreadTitleMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.threads as thread set title = 'Chat'
        from public.workspaces as workspace
        where workspace.home_thread_id = thread.id;

      update public.workspace_events as event
      set data = jsonb_set(event.data, '{thread,title}', '"Chat"')
      from public.workspaces as workspace
      where event.thread_id = workspace.home_thread_id
        and jsonb_typeof(event.data -> 'thread') = 'object'
        and event.data #>> '{thread,id}' = workspace.home_thread_id;
    `.execute(database);
  },
};

/** Assignment events retain each update's Run model, including after a Thread is reused. */
const assignmentRunModelsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.workspace_events as event
      set data = jsonb_set(
        event.data, '{assignment,modelLabel}',
        case
          when parent.id is not null
            and worker.model_selection ->> 'providerId' = parent.model_selection ->> 'providerId'
            and worker.model_selection ->> 'modelId' = parent.model_selection ->> 'modelId'
          then 'null'::jsonb
          else to_jsonb(worker.model_selection ->> 'modelId')
        end, true)
      from public.delegations as assignment
      join public.runs as worker on worker.assignment_id = assignment.id
      left join public.runs as parent on parent.id = assignment.parent_run_id
      where event.type in ('assignment.created', 'assignment.updated')
        and event.data #>> '{assignment,id}' = assignment.id
        and worker.id = coalesce(
          event.data #>> '{assignment,currentRunId}',
          event.data #>> '{assignment,initialRunId}')
        and not (event.data -> 'assignment' ? 'modelLabel');
    `.execute(database);
    const missing = await sql<{ count: string }>`
      select count(*)::text as count from public.workspace_events
      where type in ('assignment.created', 'assignment.updated')
        and not (data -> 'assignment' ? 'modelLabel')
    `.execute(database);
    if (missing.rows[0]?.count !== "0") {
      throw new Error("Stored Assignment events have no pinned Run model");
    }
  },
};

/**
 * Completed Runs name their reply: the last message their agent wrote that
 * says something, which is what a conversation shows and a channel sends. The
 * Host now records it when it commits `run.completed` (`runReply`); stored
 * events learn it by the same rule. Blank is what JavaScript's `trim` removes,
 * spelled out because PostgreSQL's own whitespace classes follow the locale.
 */
const runReplyMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      with reply as (
        select distinct on (message.run_id) message.run_id, message.id
        from public.messages as message
        where message.kind = 'assistant' and message.run_id is not null
          and exists (
            select 1 from jsonb_array_elements(message.content) as part
            where part ->> 'type' = 'artifact'
              or (part ->> 'type' = 'text' and part ->> 'text'
                ~ '[^ \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]')
          )
        order by message.run_id, message.sequence desc
      )
      update public.workspace_events as event
      set data = jsonb_set(event.data, '{replyMessageId}', to_jsonb(reply.id), true)
      from reply
      where event.type = 'run.completed'
        and event.run_id = reply.run_id
        and not (event.data ? 'replyMessageId');

      update public.workspace_events
      set data = jsonb_set(data, '{replyMessageId}', 'null'::jsonb, true)
      where type = 'run.completed' and not (data ? 'replyMessageId');
    `.execute(database);
    const missing = await sql<{ count: string }>`
      select count(*)::text as count from public.workspace_events
      where type = 'run.completed' and not (data ? 'replyMessageId')
    `.execute(database);
    if (missing.rows[0]?.count !== "0") {
      throw new Error("Stored completed Runs have no recorded reply");
    }
  },
};

/**
 * A person's Stop for one Run on one Mac, kept for as long as the Run is.
 * Runs now outlive a Host restart, so the Stop has to as well: a Run that
 * resumed after one must not find the Mac open to it again.
 */
const computerUseStopsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.computer_use_stops (
        run_id text not null references public.runs(id) on delete cascade,
        runner_id text not null references public.runners(id) on delete cascade,
        stopped_at timestamptz not null default now(),
        primary key (run_id, runner_id)
      );
    `.execute(database);
  },
};

/**
 * Which binding a Run acquired. A provider session is rebound for each Run of
 * its Thread, so its state alone cannot say whether the Run now starting is
 * the one it is bound for; recovery after a restart has to know. Active Runs
 * are taken to hold their session's current binding: failing a Run that never
 * started is safer than dispatching one that did.
 */
const runBindingGenerationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.runs add column binding_generation integer;

      update public.runs as run
      set binding_generation = session.binding_generation
      from public.provider_sessions as session
      where session.id = run.provider_session_id
        and run.status in ('starting', 'running', 'waiting')
        and session.runner_id is not null;

      -- Only a Run that was never bound proves its execute never reached a
      -- Runner. Older Runs carry no binding record, so a finished one that was
      -- dispatched without confirming its start keeps counting as bound.
      update public.runs as run
      set binding_generation = 0
      where run.binding_generation is null
        and run.started_at is null
        and run.status in ('completed', 'failed', 'interrupted')
        and exists (
          select 1 from public.commands as command
          where command.run_id = run.id
            and command.type = 'run.execute'
            and command.attempts > 0
        );
    `.execute(database);
  },
};

/**
 * A Run whose engine finished a turn while work it started in the background
 * still runs: its phase, the deadline that work runs against (set once per
 * Run), and the reply its channel was already sent when that turn ended.
 * Background shells are execution nodes too.
 */
/** Whether each attempt's engine was already running for its Thread. */
const runAttemptEngineStartMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.run_attempts
        add column engine_start text check (engine_start in ('cold', 'warm'));
    `.execute(database);
  },
};

/**
 * Notifications become the Host's own record, decided for every Deployment
 * rather than only one with an Account to push through: one row per person
 * and the reply, Request or failed Run they are told about. The outbox it
 * replaces held only transient two-minute publications, so its rows are
 * dropped rather than translated.
 *
 * Every Workspace is checkpointed at its committed head here, once. Hosts
 * without an Account never ran the projector, so their checkpoints are stale
 * or missing, and reading the log from there would replay every reply this
 * Deployment has ever had. A Workspace created from now on has no checkpoint
 * until the projector first reads it, from zero, so its first reply alerts.
 *
 * An automation that stops working wakes the Thread it is anchored to, so
 * its agent can tell the person; the notice is the durable half of that, as
 * Request continuations are for an answered Request.
 */
const notificationsMigration: Migration = {
  async up(database) {
    await sql`
      drop table public.notification_outbox;

      create table public.notifications (
        id text primary key,
        user_id text not null references public.users(id) on delete cascade,
        workspace_id text not null references public.workspaces(id) on delete cascade,
        thread_id text not null references public.threads(id) on delete cascade,
        kind text not null,
        subject_id text not null,
        message_id text,
        request_id text,
        run_id text,
        event_id text not null,
        sequence bigint not null,
        title text not null,
        body text not null,
        occurred_at timestamptz not null,
        expires_at timestamptz not null,
        attempts integer default 0 not null,
        next_attempt_at timestamptz default now() not null,
        last_error text,
        lease_token text,
        lease_expires_at timestamptz,
        published_at timestamptz,
        created_at timestamptz default now() not null,
        constraint notifications_subject_unique unique (user_id, kind, subject_id),
        constraint notifications_kind_check check (
          (kind = 'reply-published' and subject_id = message_id and run_id is not null
            and request_id is null)
          or (kind = 'request-opened' and subject_id = request_id and message_id is null
            and run_id is null)
          or (kind = 'run-failed' and subject_id = run_id and message_id is null
            and request_id is null)
        ),
        constraint notifications_sequence_check check (sequence >= 1),
        constraint notifications_text_check check (
          char_length(title) between 1 and 120 and char_length(body) between 1 and 180
        ),
        constraint notifications_window_check check (expires_at > occurred_at),
        constraint notifications_attempts_check check (attempts between 0 and 1000000),
        constraint notifications_error_check check (
          last_error is null or octet_length(last_error) between 1 and 2000
        ),
        constraint notifications_lease_check check (
          (lease_token is null and lease_expires_at is null)
          or (octet_length(lease_token) between 32 and 128 and lease_expires_at is not null)
        )
      );

      create index notifications_pending
        on public.notifications (next_attempt_at, created_at)
        where published_at is null;
      create index notifications_thread on public.notifications (thread_id);
      create index notifications_workspace on public.notifications (workspace_id);
      create index notifications_created on public.notifications (created_at);

      insert into public.notification_checkpoints(workspace_id, sequence, created_at, updated_at)
      select id, event_sequence, now(), now() from public.workspaces
      on conflict (workspace_id) do update
        set sequence = greatest(notification_checkpoints.sequence, excluded.sequence),
          updated_at = now();

      alter table public.users
        add column time_zone text
          constraint users_time_zone_check check (char_length(time_zone) between 1 and 64);

      create table public.automation_failure_notices (
        id text primary key,
        trigger_id text not null references public.triggers(id) on delete cascade,
        occurrence_id text references public.trigger_occurrences(id) on delete cascade,
        activation_id text references public.trigger_watch_activations(id) on delete cascade,
        reason text not null,
        detail text not null,
        attempts integer default 0 not null,
        next_attempt_at timestamptz default now() not null,
        last_error text,
        settled_at timestamptz,
        created_at timestamptz default now() not null,
        constraint automation_failure_notices_reason_check check (
          (reason = 'final-occurrence-failed' and occurrence_id is not null
            and activation_id is null)
          or (reason = 'paused' and ((occurrence_id is null) <> (activation_id is null)))
        ),
        constraint automation_failure_notices_occurrence_unique unique (occurrence_id),
        constraint automation_failure_notices_detail_check check (
          char_length(detail) between 1 and 2000
        ),
        constraint automation_failure_notices_attempts_check check (
          attempts between 0 and 1000000
        ),
        constraint automation_failure_notices_error_check check (
          last_error is null or octet_length(last_error) between 1 and 2000
        )
      );

      create index automation_failure_notices_pending
        on public.automation_failure_notices (next_attempt_at, created_at)
        where settled_at is null;
      create index automation_failure_notices_trigger
        on public.automation_failure_notices (trigger_id);
    `.execute(database);
  },
};

/**
 * A one-time Trigger is finished once a run succeeds after its instant, and a
 * finished one is archived (see TriggerStore.completeExecution). Those that
 * finished before that rule existed are archived the same way.
 */
const finishedOneTimeTriggersMigration: Migration = {
  async up(database) {
    await sql`
      update public.triggers
         set status = 'archived', pause_reason = null, updated_at = now()
        from public.trigger_revisions
       where trigger_revisions.id = triggers.current_revision_id
         and triggers.kind = 'schedule'
         and triggers.status <> 'archived'
         and triggers.next_fire_at is null
         and trigger_revisions.source -> 'schedule' ->> 'kind' = 'at'
         and (trigger_revisions.source -> 'schedule' ->> 'at')::timestamptz <= now()
         and exists (
           select 1
             from public.trigger_occurrences
            where trigger_occurrences.trigger_id = triggers.id
              and trigger_occurrences.status = 'succeeded'
              and trigger_occurrences.completed_at
                >= (trigger_revisions.source -> 'schedule' ->> 'at')::timestamptz
         );
    `.execute(database);
  },
};

const runBackgroundMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.runs
        add column phase text not null default 'turn' check (phase in ('turn', 'background')),
        add column background_deadline_at timestamptz,
        add column turn_reply_message_id text references public.messages(id) on delete set null;

      alter table public.execution_nodes
        drop constraint execution_nodes_kind_check,
        add constraint execution_nodes_kind_check check (kind in ('subagent', 'task'));
    `.execute(database);
  },
};

/**
 * A Run's subagents: each invocation an engine reports, under the attempt that
 * ran it. A Request a subagent asked names it, so a person sees who is asking.
 */
const executionNodesMigration: Migration = {
  async up(database) {
    await sql`
      create table public.execution_nodes (
        id text primary key,
        run_id text not null references public.runs(id) on delete cascade,
        attempt_id text not null references public.run_attempts(id) on delete cascade,
        parent_node_id text references public.execution_nodes(id) on delete cascade,
        kind text not null check (kind = 'subagent'),
        title text not null check (char_length(title) between 1 and 240),
        prompt text check (octet_length(prompt) <= 8192),
        model text check (char_length(model) between 1 and 255),
        native_ref text not null check (char_length(native_ref) between 1 and 255),
        session_ref text check (char_length(session_ref) between 1 and 255),
        origin_call_id text check (char_length(origin_call_id) between 1 and 255),
        status text not null check (status in ('running', 'completed', 'failed', 'interrupted')),
        result text check (octet_length(result) <= 16384),
        started_at timestamptz not null,
        ended_at timestamptz,
        input_tokens bigint check (input_tokens between 0 and 9007199254740991),
        output_tokens bigint check (output_tokens between 0 and 9007199254740991),
        cached_input_tokens bigint check (cached_input_tokens between 0 and 9007199254740991),
        cache_write_tokens bigint check (cache_write_tokens between 0 and 9007199254740991),
        reasoning_tokens bigint check (reasoning_tokens between 0 and 9007199254740991),
        cost_usd numeric(18, 8) check (cost_usd >= 0),
        unique (run_id, native_ref),
        check ((status = 'running') = (ended_at is null)),
        check ((input_tokens is null) = (output_tokens is null))
      );
      create index execution_nodes_attempt on public.execution_nodes(attempt_id);

      alter table public.requests
        add column originating_node_id text references public.execution_nodes(id) on delete set null;
    `.execute(database);
  },
};

/**
 * Attempts become the record of each execution of a Run: its placement,
 * timings, outcome and usage, and why it began. A restart supersedes an
 * attempt and revokes its grant; `run.restart` is the steer that asks for one,
 * held to the same execution authority as any steer.
 */
const runAttemptFactsMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.run_attempts
        drop constraint run_attempts_reason_check,
        add constraint run_attempts_reason_check check (reason in ('initial', 'steer_restart')),
        add column binding_generation integer check (binding_generation >= 1),
        add column runner_id text,
        add column runner_boot_id text,
        add column model_selection jsonb,
        add column dispatched_at timestamptz,
        add column first_event_at timestamptz,
        add column ended_at timestamptz,
        add column outcome text
          check (outcome in ('completed', 'failed', 'interrupted', 'cancelled')),
        add column input_tokens bigint check (input_tokens between 0 and 9007199254740991),
        add column output_tokens bigint check (output_tokens between 0 and 9007199254740991),
        add column cached_input_tokens bigint
          check (cached_input_tokens between 0 and 9007199254740991),
        add column cache_write_tokens bigint
          check (cache_write_tokens between 0 and 9007199254740991),
        add column reasoning_tokens bigint
          check (reasoning_tokens between 0 and 9007199254740991),
        add column cost_usd numeric(18, 8) check (cost_usd >= 0),
        add constraint run_attempts_usage_pair check ((input_tokens is null) = (output_tokens is null)),
        add constraint run_attempts_outcome_ended check ((outcome is null) = (ended_at is null));

      -- Every earlier attempt was created by the binding that dispatched it.
      update public.run_attempts attempt
      set binding_generation = run.binding_generation,
          dispatched_at = attempt.started_at,
          model_selection = run.model_selection,
          ended_at = case
            when run.status in ('completed', 'failed', 'interrupted')
              then coalesce(run.completed_at, attempt.started_at)
          end,
          outcome = case
            when run.status in ('completed', 'failed', 'interrupted') then run.status
          end
      from public.runs run
      where run.id = attempt.run_id
        and run.binding_generation is not null;

      alter table public.grants
        drop constraint grants_revoked_reason_check,
        add constraint grants_revoked_reason_check check (
          revoked_reason in ('stopped', 'assignment-cancelled', 'binding-replaced', 'superseded')
        );

      create or replace function public.opensteer_enforce_command_execution_authority()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.type not in (
          'run.execute',
          'trigger.execute',
          'run.steer',
          'run.restart',
          'run.interrupt',
          'request.respond'
        ) then
          return new;
        end if;
        if new.type = 'run.interrupt' and exists (
          select 1
          from public.runs target_run
          join public.threads thread on thread.id = target_run.thread_id
          join public.workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = new.requested_by
           and membership.state = 'active'
          where target_run.id = new.run_id
            and thread.id = new.thread_id
            and thread.environment_id = new.environment_id
            and (
              target_run.requested_by = new.requested_by
              or membership.role = 'owner'
            )
        ) then
          return new;
        end if;
        if new.thread_id is null
           or new.environment_id is null
           or not exists (
             select 1 from public.threads thread
             where thread.id = new.thread_id
               and thread.environment_id = new.environment_id
               and public.opensteer_user_can_execute_thread(thread.id, new.requested_by)
           ) then
          raise exception 'command requester cannot execute the thread environment';
        end if;
        return new;
      end;
      $function$;
    `.execute(database);
  },
};

const runnerUpdateRequiredMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.runners add column update_required text
        check (update_required in ('agent-phone-outdated', 'runner-outdated'))
    `.execute(database);
  },
};

/** The database records migrations this build does not have: another lineage migrated it. */
export class MigrationLineageError extends Error {
  readonly unknownMigrations: readonly string[];

  constructor(unknownMigrations: readonly string[], options?: ErrorOptions) {
    super(
      `The database belongs to a different migration lineage: it applied ${unknownMigrations.join(", ")}, which this build does not have.`,
      options,
    );
    this.name = "MigrationLineageError";
    this.unknownMigrations = unknownMigrations;
  }
}

export async function migrateToLatest(
  database: Kysely<DatabaseSchema>,
  /** Another release's migrations, for a journey that upgrades from an older schema. */
  provider: MigrationProvider = migrationProvider(),
): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db: database, provider });
  const result = await migrator.migrateToLatest();
  const failure = result.results?.find((entry) => entry.status === "Error");
  if (result.error || failure) {
    const known = new Set(Object.keys(await provider.getMigrations()));
    const applied = await sql<{ name: string }>`select name from kysely_migration order by name`
      .execute(database)
      .then(({ rows }) => rows.map(({ name }) => name))
      .catch(() => []);
    const unknown = applied.filter((name) => !known.has(name));
    if (unknown.length) throw new MigrationLineageError(unknown, { cause: result.error });
    const reason =
      result.error === undefined
        ? ""
        : `: ${result.error instanceof Error ? result.error.message : String(result.error)}`;
    throw new Error(
      `Database migration failed${failure ? ` at ${failure.migrationName}` : ""}${reason}`,
      { cause: result.error },
    );
  }
  return result;
}

export const threadStateMigration: Migration = {
  async up(database) {
    await sql`
      alter table threads add column pending_request_count integer not null default 0,
        add column projected_input_queue_paused boolean not null default false;
      update threads set pending_request_count = (
        select count(*)::integer from requests
        where requests.originating_thread_id = threads.id and requests.status = 'pending'
      ), projected_input_queue_paused = input_queue_paused;
    `.execute(database);
  },
};

export const threadStatePendingMigration: Migration = {
  async up(database) {
    await sql`
      create table thread_state_pending (
        thread_id text primary key references threads(id) on delete cascade,
        requested_at timestamptz not null default now()
      );
    `.execute(database);
  },
};

/** Membership changes serialize on the Workspace without blocking its foreign keys. */
const workspaceOwnerFenceMigration: Migration = {
  async up(database) {
    await sql`
      create or replace function public.opensteer_prevent_last_workspace_owner_removal()
      returns trigger language plpgsql as $$
      begin
        if old.state = 'active'
           and old.role = 'owner'
           and (
             tg_op = 'DELETE'
             or new.state is distinct from 'active'
             or new.role is distinct from 'owner'
           ) then
          perform 1 from workspaces where id = old.workspace_id for no key update;
          if not exists (
            select 1
            from workspace_memberships
            where workspace_id = old.workspace_id
              and user_id <> old.user_id
              and state = 'active'
              and role = 'owner'
          ) then
            raise exception 'workspace must retain at least one active owner';
          end if;
        end if;
        return case when tg_op = 'DELETE' then old else new end;
      end;
      $$;
    `.execute(database);
  },
};

/** Cache epochs publish with the committed source rows, after all domain fences. */
const deferredIntegrationAuthorityMigration: Migration = {
  async up(database) {
    await sql`
      create table public.integration_authority_pending (
        transaction_id xid8 not null,
        owner_user_id text not null references public.users(id) on delete cascade,
        primary key (transaction_id, owner_user_id)
      );
      create function public.opensteer_flush_integration_authority() returns trigger
      language plpgsql as $$
      declare authority_owner_id text;
      begin
        -- The first deferred invocation drains the complete transaction's set.
        -- Concurrent writers acquire shared epoch rows in the same owner order.
        for authority_owner_id in
          select owner_user_id from public.integration_authority_pending
          where transaction_id = pg_current_xact_id() order by owner_user_id
        loop
          insert into public.integration_authority_generations (owner_user_id, generation, updated_at)
          values (authority_owner_id, 1, now())
          on conflict (owner_user_id) do update
          set generation = integration_authority_generations.generation + 1,
              updated_at = excluded.updated_at;
        end loop;
        delete from public.integration_authority_pending where transaction_id = pg_current_xact_id();
        return null;
      end;
      $$;
      create constraint trigger integration_authority_pending_flush
        after insert on public.integration_authority_pending
        deferrable initially deferred for each row
        execute function public.opensteer_flush_integration_authority();

      create or replace function public.opensteer_bump_all_integration_authority() returns trigger
      language plpgsql as $$
      begin
        insert into public.integration_authority_pending (transaction_id, owner_user_id)
        select pg_current_xact_id(), id from public.users
        on conflict do nothing;
        return null;
      end;
      $$;
      create or replace function public.opensteer_bump_integration_owner_authority() returns trigger
      language plpgsql as $$
      declare authority_owner_id text;
      begin
        authority_owner_id := case when tg_op = 'DELETE' then old.owner_user_id else new.owner_user_id end;
        insert into public.integration_authority_pending (transaction_id, owner_user_id)
        values (pg_current_xact_id(), authority_owner_id) on conflict do nothing;
        return case when tg_op = 'DELETE' then old else new end;
      end;
      $$;
      create or replace function public.opensteer_bump_provider_integration_authority() returns trigger
      language plpgsql as $$
      begin
        if old.status is distinct from new.status then
          insert into public.integration_authority_pending (transaction_id, owner_user_id)
          select distinct pg_current_xact_id(), owner_user_id from public.integration_connections
          where provider_application_id = new.id and status <> 'revoked'
          on conflict do nothing;
        end if;
        return new;
      end;
      $$;
    `.execute(database);
  },
};

/**
 * Attempts and grants make a Run's execution and its tool authority explicit.
 * Every Run that ever started gets attempt 1. Only Runs live at migration time,
 * holding their current binding, get a grant, so tokens issued before the
 * upgrade keep working and no finished Run gains authority.
 */
const runAttemptsAndGrantsMigration: Migration = {
  async up(database) {
    await sql`
      create table public.run_attempts (
        id text primary key,
        run_id text not null references public.runs(id) on delete cascade,
        ordinal integer not null check (ordinal >= 1),
        reason text not null check (reason in ('initial', 'steer_restart', 'recovery')),
        status text not null check (status in ('current', 'superseded')),
        started_at timestamptz not null default now(),
        superseded_at timestamptz,
        superseded_by text references public.run_attempts(id),
        unique (run_id, ordinal),
        check ((status = 'superseded') = (superseded_at is not null))
      );
      create unique index run_attempts_one_current on public.run_attempts(run_id)
        where status = 'current';

      create table public.grants (
        id text primary key,
        run_id text not null references public.runs(id) on delete cascade,
        attempt_id text not null references public.run_attempts(id) on delete cascade,
        binding_generation integer not null check (binding_generation >= 1),
        runner_id text not null,
        runner_boot_id text not null,
        status text not null check (status in ('active', 'revoked')),
        revoked_reason text
          check (revoked_reason in ('stopped', 'assignment-cancelled', 'binding-replaced')),
        created_at timestamptz not null default now(),
        revoked_at timestamptz,
        check ((status = 'revoked') = (revoked_at is not null and revoked_reason is not null))
      );
      create unique index grants_one_active_per_attempt on public.grants(attempt_id)
        where status = 'active';
      create index grants_active_run on public.grants(run_id) where status = 'active';

      -- Generation 0 is 0074's record of a Run that was never bound, so it never started.
      insert into public.run_attempts (id, run_id, ordinal, reason, status, started_at)
      select 'rat_' || gen_random_uuid(), runs.id, 1, 'initial', 'current',
        coalesce(runs.started_at, runs.created_at)
      from public.runs
      where runs.status <> 'queued'
        and (runs.started_at is not null or runs.binding_generation > 0);

      insert into public.grants
        (id, run_id, attempt_id, binding_generation, runner_id, runner_boot_id, status)
      select 'grt_' || gen_random_uuid(), runs.id, run_attempts.id, runs.binding_generation,
        provider_sessions.runner_id, provider_sessions.runner_boot_id, 'active'
      from public.runs
      join public.run_attempts
        on run_attempts.run_id = runs.id and run_attempts.status = 'current'
      join public.provider_sessions on provider_sessions.id = runs.provider_session_id
      where runs.status in ('starting', 'running', 'waiting')
        and runs.binding_generation is not null
        and provider_sessions.active
        and provider_sessions.binding_generation = runs.binding_generation
        and provider_sessions.runner_id is not null
        and provider_sessions.runner_boot_id is not null;
    `.execute(database);
  },
};

/**
 * Admits `browser.password-sign-in`, a durable Request that only the Mac named
 * in it approves. It needs no table of its own: the Request row carries the
 * operation it started, and the vault never reaches the Host.
 */
export const passwordSignInRequestsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    // Same textual widening the browser-source migration used: the live
    // definition is the only description of these lists, so it is read and
    // extended rather than restated and silently narrowed.
    for (const name of ["requests_kind_check", "requests_kind_mode_check"] as const) {
      const result = await sql<{ definition: string }>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'public.requests'::regclass and conname = ${name}
      `.execute(database);
      const definition = result.rows[0]?.definition;
      if (!definition) throw new Error(`Cannot extend ${name} for password sign-ins`);
      if (definition.includes("browser.password-sign-in")) continue;
      const anchor = "'browser.sign-in'::text";
      if (definition.split(anchor).length !== 2) {
        throw new Error(`Cannot extend ${name} for password sign-ins`);
      }
      const next = definition.replace(anchor, `${anchor}, 'browser.password-sign-in'::text`);
      await sql.raw(`alter table public.requests drop constraint ${name}`).execute(database);
      await sql.raw(`alter table public.requests add constraint ${name} ${next}`).execute(database);
    }
  },
};

/**
 * A call that joined a Request its Run already had open, so a replay of that
 * call finds the Request instead of opening another.
 */
export const requestCallJoinsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.request_call_joins (
        originating_run_id text not null references public.runs(id) on delete cascade,
        call_id text not null,
        request_id text not null references public.requests(id) on delete cascade,
        created_at timestamp with time zone not null default now(),
        primary key (originating_run_id, call_id)
      );
      create index request_call_joins_request_id_idx on public.request_call_joins(request_id);
    `.execute(database);
  },
};

/**
 * Usage outlives a Run's live attachment and credits its assignment lineage
 * once. Each row is one page a Run used, one page a person included, or the
 * conversation's membership (no Run, no page), which every use also moves;
 * the title and site are what that page showed at its latest use, so a link
 * to an ended browser can still name it. The browser catalog names each
 * session's most recently active conversations from the membership rows.
 */
export const browserSessionUsesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.browser_session_uses (
        id text primary key,
        session_id text not null references public.browser_sessions(id) on delete cascade,
        thread_id text not null references public.threads(id) on delete cascade,
        run_id text references public.runs(id) on delete cascade,
        tab_id text,
        page_title text check (char_length(page_title) <= 256),
        page_site text check (char_length(page_site) <= 2048),
        first_used_at timestamptz not null default now(),
        last_used_at timestamptz not null default now(),
        constraint browser_session_uses_identity unique nulls not distinct (session_id, thread_id, run_id, tab_id)
      );
      create index browser_session_uses_thread on public.browser_session_uses(thread_id, session_id);
      create index browser_session_uses_run on public.browser_session_uses(run_id) where run_id is not null;
      create index browser_session_uses_membership
        on public.browser_session_uses(session_id, last_used_at desc)
        where run_id is null and tab_id is null;
    `.execute(database);
  },
};

/**
 * A reader's own placement of a task, Done or kept in Tasks, and the read
 * position they made it at. It is never past that position, so reading
 * anything newer returns the task to the automatic rule without a reset.
 */
export const threadTaskPlacementMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.thread_read_markers
        add column placement_done boolean,
        add column placement_sequence bigint,
        add constraint thread_read_markers_placement_shape
          check ((placement_done is null) = (placement_sequence is null)),
        add constraint thread_read_markers_placement_within_read
          check (placement_sequence between 0 and sequence);
    `.execute(database);
  },
};

/** Placement changes are ordered independently of Workspace content and read positions. */
export const threadTaskPlacementRevisionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.thread_read_markers
        add column placement_revision bigint not null default 0
          check (placement_revision >= 0);
      update public.thread_read_markers set placement_revision = 1 where placement_done is not null;
    `.execute(database);
  },
};

/**
 * Reasons an older Host stored, or never stored, say why and what to do next.
 * An agent's OAuth-only proposal installed before the Host refused them can
 * never work, so Uninstall is its only exit. The Slack MCP preset 0040 turned
 * off recorded no reason. Only servers that are not disabled get either: a
 * disabled server is not shown, and its reason would not be either.
 */
export const integrationReasonsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      update public.integration_servers
      set status_detail = 'Opensteer can’t set up this service’s sign-in from an agent’s proposal. Uninstall it, then add the service from Add a service if it’s listed there.',
        updated_at = now()
      where status_detail = 'This OAuth API requires administrator-authored declarative identity configuration'
        and status <> 'disabled';

      update public.integration_servers server
      set status_detail = 'Opensteer no longer supports Slack MCP. Uninstall it and use Slack instead.',
        updated_at = now()
      from public.integration_installations installation
      where installation.id = server.installation_id
        and installation.source_kind = 'built-in'
        and installation.provenance ->> 'definitionId' = 'slack-mcp'
        and installation.status = 'disabled'
        and server.status <> 'disabled'
        and server.status_detail is distinct from 'Opensteer no longer supports Slack MCP. Uninstall it and use Slack instead.';

      update public.integration_connections
      set status_detail = 'Opensteer changed how this service connects. Reconnect this account to keep using it.',
        updated_at = now()
      where status_detail = 'The integration authorization changed; reconnect this account.';
    `.execute(database);
  },
};

export const integrationProposalReasonMigration: Migration = {
  async up(database) {
    await sql`
      update public.integration_servers
      set status_detail = 'Opensteer can’t set up this service’s sign-in from an agent’s proposal. Add the service from Add a service if it’s listed there, then uninstall this one.', updated_at = now()
      where status_detail = 'Opensteer can’t set up this service’s sign-in from an agent’s proposal. Uninstall it, then add the service from Add a service if it’s listed there.';
    `.execute(database);
  },
};

const browserPersonOpensMigration: Migration = {
  async up(database) {
    await sql`alter table browser_sessions add column opener jsonb`.execute(database);
    await sql`create table browser_tab_opens (
      owner_id text not null references users(id) on delete cascade,
      idempotency_key text not null,
      binding jsonb not null,
      identity_key text,
      runner_id text not null,
      created_at timestamptz not null default now(),
      primary key (owner_id, idempotency_key)
    )`.execute(database);
    await sql`create index browser_tab_opens_preference on browser_tab_opens
      (owner_id, identity_key, created_at desc) where identity_key is not null`.execute(database);
  },
};

const browserTabOpenRetentionMigration: Migration = {
  async up(database) {
    await sql`create index browser_tab_opens_retention on browser_tab_opens (owner_id, created_at)`.execute(
      database,
    );
  },
};

export const workspaceTabsMigration: Migration = {
  async up(database) {
    await sql`alter table browser_sessions add column tab_group_id text;
      update browser_sessions set tab_group_id = id;
      alter table browser_sessions alter column tab_group_id set not null;
      alter table browser_sessions add column tab_revision integer not null default 0;
      create index browser_sessions_tab_group on browser_sessions(tab_group_id, created_at desc);
      create table workspace_tabs (
        id text primary key,
        group_id text not null references browser_sessions(id) on delete cascade,
        session_id text not null references browser_sessions(id) on delete cascade,
        title text not null,
        url text not null,
        "order" integer not null check ("order" >= 0),
        opener_id text,
        state text not null check (state in ('suspended', 'restoring', 'live')),
        closed_at timestamptz
      );
      create index workspace_tabs_group on workspace_tabs(group_id, "order");
      create index workspace_tabs_session on workspace_tabs(session_id);
    `.execute(database);
  },
};

export const workspaceTabIconsMigration: Migration = {
  async up(database) {
    await sql`alter table workspace_tabs
      add column favicon text,
      add column icon_ref text,
      add constraint workspace_tab_icon_pair check (
        (favicon is null and icon_ref is null) or
        (favicon is not null and icon_ref is not null and length(favicon) <= 21912
          and icon_ref ~ '^[A-Za-z0-9_-]{43}$')
      );
    `.execute(database);
  },
};

export const agentPhoneOwnerAccessMigration: Migration = {
  async up(database) {
    await sql`
      DELETE FROM public.computer_use_approval_keys AS k
      USING public.runners AS r
      WHERE k.runner_id = r.id
        AND r.device->>'form' = 'phone'
        AND r.device->>'platform' = 'android';

      UPDATE public.requests AS q
      SET presentation = jsonb_set(q.presentation, '{detail}', to_jsonb(
        (q.payload->>'reason') || ' ' || r.name || ' — ' ||
        CASE WHEN q.payload->>'access' = 'read-write' THEN 'can see and control' ELSE 'can see' END ||
        '. Allow or decline from any Opensteer app.'
      ))
      FROM public.runners AS r
      WHERE q.status = 'pending'
        AND q.kind = 'computer.app.access'
        AND q.payload->>'definitionId' = 'android-phone'
        AND q.payload->>'runnerId' = r.id;
    `.execute(database);
  },
};

export const browserTabGroupsMigration: Migration = {
  async up(database) {
    await sql`
      create table browser_tab_layouts (
        owner_id text primary key references users(id) on delete cascade,
        revision bigint not null default 0 check (revision >= 0)
      );
      create table browser_tab_groups (
        id text primary key,
        owner_id text not null references users(id) on delete cascade,
        title text not null check (length(title) <= 80),
        color text not null check (color in ('grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange')),
        collapsed boolean not null default false,
        created_by_thread_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (id, owner_id)
      );
      create index browser_tab_groups_owner on browser_tab_groups(owner_id);
      create table browser_tab_group_members (
        owner_id text not null,
        tab_id text not null references workspace_tabs(id) on delete cascade,
        group_id text not null,
        primary key (owner_id, tab_id),
        foreign key (group_id, owner_id) references browser_tab_groups(id, owner_id) on delete cascade
      );
      create index browser_tab_group_members_group on browser_tab_group_members(group_id);
    `.execute(database);
    await sql`
      alter table public.agent_control_requests
        drop constraint agent_control_requests_action_check,
        drop constraint agent_control_requests_action_class_check,
        add constraint agent_control_requests_action_check check (
          action in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.tab.read', 'browser.tab.write',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write')),
        add constraint agent_control_requests_action_class_check check (
          action_class in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.tab.read', 'browser.tab.write',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write'));
    `.execute(database);
  },
};

/** Existing names are chosen; only newly opted-in Threads may be titled. */
export const threadTitleSourceMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.threads
        add column if not exists title_source text not null default 'chosen';
      alter table public.threads drop constraint if exists threads_title_source_check;
      alter table public.threads add constraint threads_title_source_check
        check (title_source in ('provisional', 'generated', 'chosen'));
    `.execute(database);
  },
};

export const taskMarksMigration: Migration = {
  async up(database) {
    // A prior migration can have updated legacy rows with unvalidated foreign
    // keys in this same transaction. UPDATE would recheck those unchanged keys.
    // Rewrite only the new columns through DDL, preserving every accepted row
    // and all existing FK definitions/enforcement. Stage the ranks once so each
    // rewrite lookup is indexed rather than rerunning the window per row.
    await sql`
      alter table public.threads
        add column icon text check (icon in (${sql.join(workspaceIconNames.map((name) => sql.lit(name)))})),
        add column icon_source text not null default 'provisional'
          check (icon_source in ('provisional', 'generated', 'chosen')),
        add column color text check (color in (${sql.join(markColors.map((color) => sql.lit(color)))}));
      alter table public.workspaces add column color text check (color in (${sql.join(markColors.map((color) => sql.lit(color)))}));
      create temporary table task_mark_backfill (
        kind text not null, id text not null, color text not null, icon_source text,
        primary key (kind, id)
      ) on commit drop;
      insert into pg_temp.task_mark_backfill
      select 'thread', thread.id,
        (array[${sql.join(markColorAllocationOrder.map((color) => sql.lit(color)))}]::text[])[
          ((row_number() over (partition by thread.created_by order by thread.created_at, thread.id) - 1) % 7 + 1)::int
        ],
        case when exists (
          select 1 from public.workspaces where home_thread_id = thread.id
        ) then 'chosen' else 'provisional' end
      from public.threads as thread;
      insert into pg_temp.task_mark_backfill
      select 'workspace', id,
        (array[${sql.join(markColorAllocationOrder.map((color) => sql.lit(color)))}]::text[])[
          ((row_number() over (partition by created_by order by created_at, id) - 1) % 7 + 1)::int
        ], null
      from public.workspaces;
      create function pg_temp.task_mark_backfill(text, text)
      returns pg_temp.task_mark_backfill language sql stable as $$
        select * from pg_temp.task_mark_backfill where kind = $1 and id = $2
      $$;
      alter table public.threads
        alter column color type text using (pg_temp.task_mark_backfill('thread', id)).color,
        alter column icon_source type text using (pg_temp.task_mark_backfill('thread', id)).icon_source;
      alter table public.workspaces
        alter column color type text using (pg_temp.task_mark_backfill('workspace', id)).color;
      drop function pg_temp.task_mark_backfill(text, text);
      drop table pg_temp.task_mark_backfill;
      alter table public.threads alter column color set not null;
      alter table public.workspaces alter column color set not null;
      create index threads_creator_created on public.threads (created_by, created_at desc, id desc);
      create index workspaces_creator_created on public.workspaces (created_by, created_at desc, id desc);
    `.execute(database);
  },
};

export const runRecoveryMigration: Migration = {
  async up(database) {
    await sql`alter table public.run_attempts
      drop constraint run_attempts_reason_check,
      add constraint run_attempts_reason_check
        check (reason in ('initial', 'steer_restart', 'recovery'));

      alter table public.automation_failure_notices
        drop constraint automation_failure_notices_reason_check,
        add constraint automation_failure_notices_reason_check check (
          (reason in ('final-occurrence-failed', 'final-occurrence-interrupted')
            and occurrence_id is not null and activation_id is null)
          or (reason = 'paused' and ((occurrence_id is null) <> (activation_id is null)))
        );
    `.execute(database);
  },
};

export const browserTabOrderMigration: Migration = {
  async up(database) {
    await sql`
      alter table workspace_tabs add column created_at timestamptz not null default now();
      update workspace_tabs as tab set created_at = lineage.created_at
        from browser_sessions as lineage where lineage.id = tab.group_id;
      alter table browser_tab_layouts add column tab_order jsonb
        check (tab_order is null or (jsonb_typeof(tab_order) = 'array' and jsonb_array_length(tab_order) <= 10000));
    `.execute(database);
  },
};

export const agentBrowserProfileCreateMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.agent_control_requests
        drop constraint agent_control_requests_action_check,
        drop constraint agent_control_requests_action_class_check,
        add constraint agent_control_requests_action_check check (
          action in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save', 'browser.profile.create',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.tab.read', 'browser.tab.write',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write')),
        add constraint agent_control_requests_action_class_check check (
          action_class in ('assignment.cancel',
            'workspace.inspect', 'workspace.create', 'workspace.mount', 'thread.read',
            'thread.list', 'thread.delegate', 'thread.message', 'request.list',
            'request.withdraw', 'browser.profile.list', 'browser.profile.save', 'browser.profile.create',
            'machine.full-disk-access.request', 'browser.access.request',
            'browser.session.list', 'browser.session.open', 'browser.session.close',
            'browser.tab.read', 'browser.tab.write',
            'browser.source.inspect', 'browser.profile.import', 'browser.sign-in',
            'trigger.read', 'trigger.write'));
    `.execute(database);
  },
};

export const dropHostNotificationsMigration: Migration = {
  async up(database) {
    await sql`drop table public.notifications; drop table public.notification_checkpoints;`.execute(
      database,
    );
  },
};

export const workspaceTabReopenMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`alter table workspace_tabs
      add column closed_by text references users(id) on delete set null,
      add column closed_after_tab_id text,
      add column closed_tab_group_id text,
      add column reopened_at timestamptz;
      create index workspace_tabs_reopen on workspace_tabs(closed_by, closed_at desc, id desc)
        where closed_by is not null and reopened_at is null;`.execute(database);
  },
};

export const environmentDiscoveryMigration: Migration = {
  async up(database) {
    for (const table of ["agent_control_requests", "trigger_control_requests"] as const) {
      for (const column of ["action", "action_class"] as const) {
        const name = `${table}_${column}_check`;
        const result = await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = ${`public.${table}`}::regclass and conname = ${name}
        `.execute(database);
        const definition = result.rows[0]?.definition;
        const previous = "'workspace.inspect'::text";
        if (!definition?.includes(previous))
          throw new Error(`Cannot extend ${name} for environment discovery`);
        const next = definition.replaceAll(
          previous,
          `${previous}, 'environment.list'::text${column === "action" ? ", 'workspace.list'::text" : ""}`,
        );
        await sql.raw(`alter table public.${table} drop constraint ${name}`).execute(database);
        await sql
          .raw(`alter table public.${table} add constraint ${name} ${next}`)
          .execute(database);
      }
      await sql
        .raw(
          `alter table public.${table}
          drop constraint ${table}_action_mapping_check,
          add constraint ${table}_action_mapping_check check (
            action_class = case when action = 'workspace.list' then 'workspace.inspect' else action end
          )`,
        )
        .execute(database);
    }
  },
};

export const iphoneDeviceProfileMigration: Migration = {
  async up(database) {
    await sql`
      alter table runner_enrollments add column device_profile text;
      alter table runner_enrollments add constraint runner_enrollments_device_profile_check check (
        device_profile is null or (device_profile = 'iphone' and runner_kind = 'local'
          and owner_kind = 'user' and allowed_modules = '["integrations"]'::jsonb));
      alter table runners add column device_profile text;
      alter table runners add constraint runners_device_profile_check check (
        device_profile is null or (device_profile = 'iphone' and kind = 'local'
          and owner_kind = 'user' and allowed_modules = '["integrations"]'::jsonb));
    `.execute(database);
  },
};

export const taskDoneMigration: Migration = {
  async up(database) {
    // Extend the actions agents may record rather than restate them, so this
    // keeps whatever earlier migrations allowed.
    for (const column of ["action", "action_class"] as const) {
      const name = `agent_control_requests_${column}_check`;
      const result = await sql<{ definition: string }>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'agent_control_requests'::regclass and conname = ${name}
      `.execute(database);
      const definition = result.rows[0]?.definition;
      const previous = "'thread.read'::text";
      if (!definition?.includes(previous))
        throw new Error(`Cannot extend ${name} for thread writes`);
      const next = definition.replace(previous, `${previous}, 'thread.write'::text`);
      await sql.raw(`alter table agent_control_requests drop constraint ${name}`).execute(database);
      await sql
        .raw(`alter table agent_control_requests add constraint ${name} ${next}`)
        .execute(database);
    }
    await sql`
      alter table requests drop constraint requests_cancellation_reason_check,
        add constraint requests_cancellation_reason_check check (
          cancellation_reason is null or cancellation_reason in (
            'run-ended', 'process-lost', 'source-closed', 'thread-archived', 'task-done',
            'workspace-deleted', 'membership-revoked', 'resource-deleted', 'authority-revoked'));
      alter table threads add column done_at timestamptz;
      alter table runs add column done_when_finished boolean not null default false;
      update threads as thread
        set done_at = now(), input_queue_paused = false, input_queue_paused_by = null
      where thread.role = 'work'
        and not exists (select 1 from workspaces where home_thread_id = thread.id)
        and not exists (select 1 from channel_conversation_contexts where active_thread_id = thread.id)
        -- A Done task holds no work and asks nothing, as marking it Done ensures.
        and not exists (
          select 1 from runs
          where thread_id = thread.id and status in ('queued', 'starting', 'running', 'waiting'))
        and not exists (
          select 1 from thread_inputs
          where thread_id = thread.id and state in ('pending', 'claimed') and policy <> 'report')
        and not exists (
          select 1 from delegations
          where status = 'open' and (child_thread_id = thread.id or parent_thread_id = thread.id))
        and not exists (
          select 1 from requests where originating_thread_id = thread.id and status = 'pending')
        and (thread.status = 'archived' or (
          thread.listed
          and not exists (
            select 1 from messages message
            left join thread_inputs inbox on inbox.message_id = message.id
            left join thread_read_markers marker on marker.thread_id = thread.id and marker.user_id = thread.created_by
            where message.thread_id = thread.id
              and message.kind in ('input', 'assistant', 'run-result')
              and (inbox.message_id is null or inbox.state = 'delivered' or (inbox.policy = 'report' and inbox.state <> 'cancelled'))
              and message.sequence > coalesce(marker.sequence, -1)
              and (message.author->>'kind' <> 'human' or coalesce(message.author->>'userId', inbox.requested_by) is distinct from thread.created_by)
          )
          and coalesce((
            select case when marker.placement_sequence >= marker.sequence then marker.placement_done else null end
            from thread_read_markers marker where marker.thread_id = thread.id and marker.user_id = thread.created_by
          ), thread.updated_at <= now() - interval '24 hours')
        ));
      update threads as thread set status = coalesce((
        select case when status = 'waiting' then 'waiting'
          when status = 'queued' and thread.input_queue_paused then null else 'running' end
        from runs where thread_id = thread.id and status in ('queued', 'starting', 'running', 'waiting')
        order by run_ordinal limit 1
      ), case when (select status from runs where thread_id = thread.id order by run_ordinal desc limit 1) = 'failed' then 'failed' else 'idle' end)
      where thread.status = 'archived';
      alter table thread_read_markers drop column placement_done, drop column placement_sequence, drop column placement_revision;
    `.execute(database);
  },
};

export const personAskedThreadsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      with asked as (
        select distinct delegation.child_thread_id as id
        from delegations as delegation
        join threads as parent on parent.id = delegation.parent_thread_id
        join runs as run on run.id = delegation.parent_run_id
        join messages as seed on seed.id = run.seed_input_id
        where parent.role = 'conversation' and delegation.origin = 'run'
          and seed.author ->> 'kind' = 'human'
      ), listing as (
        -- Every delegation writes its row with the child it creates, so a child
        -- with none is one a person made, listed only when made in a conversation.
        select thread.id, (
          thread.parent_thread_id is null
          or asked.id is not null
          or (parent.role = 'conversation' and not exists (
            select 1 from delegations as delegation where delegation.child_thread_id = thread.id))
        ) as listed
        from threads as thread
        left join threads as parent on parent.id = thread.parent_thread_id
        left join asked on asked.id = thread.id
      )
      update threads as thread set listed = listing.listed
      from listing where thread.id = listing.id and thread.listed is distinct from listing.listed;

      -- Clients apply the whole Thread any event carries (created, listed or
      -- execution-updated), so every stored snapshot must agree on replay.
      update workspace_events as event
      set data = jsonb_set(event.data, '{thread,listed}', to_jsonb(thread.listed), true)
      from threads as thread
      where event.thread_id = thread.id
        and jsonb_typeof(event.data -> 'thread') = 'object'
        and event.data #>> '{thread,id}' = thread.id
        and event.data #> '{thread,listed}' is distinct from to_jsonb(thread.listed);
    `.execute(database);
  },
};

/** Backfill once without per-event lookups; replayed pages must classify independently. */
export const runStartedByMigration: Migration = {
  async up(database) {
    // Every Run lifecycle event asks whether a person's input joined its Run;
    // without this, that lookup scans every message, here and at each commit.
    await sql`
      create index if not exists messages_run_inputs on messages (run_id) where kind = 'input'
    `.execute(database);
    await sql`
      update workspace_events event
      set data = event.data || context.data
      from (
        select run.id, jsonb_build_object(
          'startedBy', message.author,
          'startedAt', to_char(run.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'personWaiting', message.author->>'kind' = 'human' or exists (
            select 1 from messages input where input.run_id = run.id
            and input.kind = 'input' and input.author->>'kind' = 'human'
          )
        ) as data
        from runs run join messages message on message.id = run.seed_input_id
      ) context
      where event.run_id = context.id
        and event.type in ('run.started', 'run.status', 'run.restarted', 'run.phase',
                           'run.completed', 'run.failed', 'run.interrupted')
        and not event.data @> context.data
    `.execute(database);
  },
};

/**
 * Columns and tables Better Auth 1.7's JWT and OAuth provider plugins read and
 * write. The provider replaced a client's `public`/`type` pair with
 * `application_type`; every Host-managed client is a public native app.
 */
export const betterAuth17Migration: Migration = {
  async up(database) {
    await sql`
      alter table public.auth_jwks add column alg text, add column crv text;

      alter table public.host_oauth_clients
        add column client_discovery_id text,
        add column client_credentials_scopes jsonb default '[]'::jsonb,
        add column backchannel_logout_uri text,
        add column backchannel_logout_session_required boolean,
        add column application_type text,
        add column jwks text,
        add column jwks_uri text,
        add column dpop_bound_access_tokens boolean default false,
        drop constraint host_oauth_public_client_check;
      update public.host_oauth_clients set application_type = case
        when type = 'native' then 'native'
        when type in ('web', 'user-agent-based') then 'web'
      end;
      alter table public.host_oauth_clients
        drop column public,
        drop column type,
        add constraint host_oauth_public_client_check check (
          token_endpoint_auth_method is distinct from 'none'
          or (coalesce(require_pkce, false) and application_type in ('native', 'web'))
        );

      alter table public.host_oauth_refresh_tokens
        add column authorization_code_id text,
        add column resources jsonb,
        add column requested_user_info_claims jsonb,
        add column rotated_at timestamptz,
        add column rotation_replay_response text,
        add column rotation_replay_expires_at timestamptz,
        add column confirmation jsonb;
      create index host_oauth_refresh_tokens_authorization_code_id
        on public.host_oauth_refresh_tokens (authorization_code_id);

      alter table public.host_oauth_access_tokens
        add column authorization_code_id text,
        add column resources jsonb,
        add column requested_user_info_claims jsonb,
        add column revoked timestamptz,
        add column confirmation jsonb;
      create index host_oauth_access_tokens_authorization_code_id
        on public.host_oauth_access_tokens (authorization_code_id);

      alter table public.host_oauth_consents
        add column resources jsonb,
        add column requested_user_info_claims jsonb;

      create table public.host_oauth_resources (
        id text primary key,
        identifier text not null unique,
        name text not null,
        access_token_ttl integer,
        refresh_token_ttl integer,
        signing_algorithm text,
        signing_key_id text,
        allowed_scopes jsonb,
        custom_claims jsonb,
        dpop_bound_access_tokens_required boolean default false,
        disabled boolean default false,
        created_at timestamptz,
        updated_at timestamptz,
        policy_version integer default 1,
        metadata jsonb
      );
      create table public.host_oauth_client_resources (
        id text primary key,
        client_id text not null
          references public.host_oauth_clients (client_id) on delete cascade,
        resource_id text not null
          references public.host_oauth_resources (identifier) on delete cascade,
        metadata jsonb,
        created_at timestamptz,
        unique (client_id, resource_id)
      );
      create index host_oauth_client_resources_resource_id
        on public.host_oauth_client_resources (resource_id);
      create table public.host_oauth_client_assertions (
        id text primary key,
        expires_at timestamptz not null
      );
    `.execute(database);
  },
};

export const screenShowMigration: Migration = {
  async up(database) {
    for (const column of ["action", "action_class"] as const) {
      const name = `agent_control_requests_${column}_check`;
      const result = await sql<{ definition: string }>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'agent_control_requests'::regclass and conname = ${name}
      `.execute(database);
      const definition = result.rows[0]?.definition;
      const previous = "'thread.read'::text";
      if (!definition?.includes(previous))
        throw new Error(`Cannot extend ${name} for screen presentation`);
      const next = definition.replace(previous, `${previous}, 'screen.show'::text`);
      await sql.raw(`alter table agent_control_requests drop constraint ${name}`).execute(database);
      await sql
        .raw(`alter table agent_control_requests add constraint ${name} ${next}`)
        .execute(database);
    }
  },
};

/** Voice moved screen changes onto the call's own agent; no Run requests them any more. */
export const removeScreenShowMigration: Migration = {
  async up(database) {
    await sql`
      delete from agent_control_requests
      where action = 'screen.show' or action_class = 'screen.show'
    `.execute(database);
    for (const column of ["action", "action_class"] as const) {
      const name = `agent_control_requests_${column}_check`;
      const result = await sql<{ definition: string }>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'agent_control_requests'::regclass and conname = ${name}
      `.execute(database);
      const definition = result.rows[0]?.definition;
      const added = ", 'screen.show'::text";
      if (!definition?.includes(added))
        throw new Error(`Cannot narrow ${name} after screen presentation`);
      await sql.raw(`alter table agent_control_requests drop constraint ${name}`).execute(database);
      await sql
        .raw(
          `alter table agent_control_requests add constraint ${name} ${definition.replace(added, "")}`,
        )
        .execute(database);
    }
  },
};

export const browserHistoryMigration: Migration = {
  async up(database) {
    await sql`
      create table browser_history_entries (
        profile_id text not null references browser_profiles(id) on delete cascade,
        url text not null,
        origin text not null,
        title varchar(200) not null,
        typed_count integer not null check (typed_count >= 0),
        visit_count integer not null check (visit_count > 0),
        last_visit_at timestamptz not null,
        primary key (profile_id, url)
      );
      create index browser_history_entries_newest on browser_history_entries (profile_id, last_visit_at desc, url);
      create table browser_history_icons (
        profile_id text not null references browser_profiles(id) on delete cascade,
        origin text not null,
        icon_ref text not null,
        favicon text not null,
        primary key (profile_id, origin)
      );
    `.execute(database);
  },
};

export const nativeBrowserProfilesMigration: Migration = {
  async up(database) {
    await sql`
      alter table browser_profiles
        add column storage_state text not null default 'vault' check (storage_state in ('vault', 'initializing', 'local')),
        add column storage_binding_version integer check (storage_binding_version = 1),
        add column storage_deployment_id text references deployments(id),
        add column storage_runner_id text references runners(id),
        add column storage_instance_id uuid,
        add column storage_binding_id uuid unique,
        add column storage_engine text check (storage_engine in ('electron', 'chromium')),
        add column frozen_seed_revision bigint check (frozen_seed_revision between 0 and 9007199254740991),
        add column frozen_seed_digest text check (frozen_seed_digest ~ '^[a-f0-9]{64}$'),
        add column initialization_token_hash text check (initialization_token_hash ~ '^[a-f0-9]{64}$'),
        add column initialization_token_expires_at timestamptz,
        add constraint browser_profiles_storage_binding_check check (
          (storage_state = 'vault'
            and storage_binding_version is null and storage_deployment_id is null
            and storage_runner_id is null and storage_instance_id is null
            and storage_binding_id is null and storage_engine is null
            and frozen_seed_revision is null and frozen_seed_digest is null)
          or (storage_state in ('initializing', 'local')
            and storage_binding_version is not null and storage_deployment_id is not null
            and storage_runner_id is not null and storage_instance_id is not null
            and storage_binding_id is not null and storage_engine is not null
            and frozen_seed_revision is not null and frozen_seed_digest is not null)
        ),
        add constraint browser_profiles_initialization_token_check check (
          (initialization_token_hash is null and initialization_token_expires_at is null)
          or (storage_state = 'initializing'
            and initialization_token_hash is not null and initialization_token_expires_at is not null)
        );
      create index browser_profiles_storage_owner on browser_profiles (storage_runner_id, storage_instance_id);
      create table browser_profile_deletions (
        deletion_id uuid primary key,
        profile_id text not null unique references browser_profiles(id),
        binding_version integer not null check (binding_version = 1),
        deployment_id text not null references deployments(id),
        runner_id text not null references runners(id),
        storage_instance_id uuid not null,
        binding_id uuid not null,
        engine text not null check (engine in ('electron', 'chromium')),
        state text not null check (state in ('pending-computer', 'pending-restart', 'deleted')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint browser_profile_deletions_completion_check check ((state = 'deleted') = (deleted_at is not null))
      );
      create index browser_profile_deletions_pending on browser_profile_deletions (runner_id, storage_instance_id) where state <> 'deleted';
    `.execute(database);
  },
};
