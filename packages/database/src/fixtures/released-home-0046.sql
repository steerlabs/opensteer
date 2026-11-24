-- The schema of a Home at main's last migration (0046_run_provider_retry), made by main's own
-- code: what every released Home holds. It never changes: a test that starts here proves this
-- branch's migrations take a released Home to what a fresh install of this branch is.
--
-- Made from origin/main at 6e4687d2d48345f57f9ba6f13b6789e5382e9c50 ("Fix Passwords auto-sign-in
-- race and overhaul browser, host, and thread UI performance (#733)"), in a clean checkout of
-- that commit with `pnpm install` done, by running this script from its root. The script starts
-- the PostgreSQL image main's deploy/compose/compose.yaml pins (postgres:18-alpine, server 18.4),
-- runs main's own `migrateToLatest` on its empty database (main's 0038 conversion included, which
-- on a Home with no history drops the old event tables), sets every ledger row to one fixed time,
-- and prints everything below its BEGIN line. Two runs gave the same bytes.
--
--   #!/bin/bash
--   # Run from the root of a clean checkout of origin/main (6e4687d2d) with its packages installed.
--   set -euo pipefail
--   image=$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' deploy/compose/compose.yaml | head -1)
--   name="opensteer-released-home-schema-$$"
--   docker run -d --rm --name "$name" -e POSTGRES_USER=opensteer -e POSTGRES_PASSWORD=opensteer \
--     -e POSTGRES_DB=opensteer -p 127.0.0.1::5432 "$image" >/dev/null
--   trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
--   until docker exec "$name" pg_isready -h 127.0.0.1 -U opensteer -d opensteer >/dev/null 2>&1; do sleep 0.25; done
--   port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
--   cat > packages/database/make-released-home-schema.ts <<'TS'
--   import { sql } from "kysely";
--   import { createDatabase } from "./src/connection.js";
--   import { migrateToLatest } from "./src/migrations.js";
--   const database = createDatabase({ connectionString: process.env.RELEASED_HOME_URL! });
--   await migrateToLatest(database);
--   // One fixed time for every ledger row, so the file is the same each time it is made.
--   await sql`update kysely_migration set timestamp = '2026-01-01T00:00:00.000Z'`.execute(database);
--   await database.destroy();
--   TS
--   RELEASED_HOME_URL="postgres://opensteer:opensteer@127.0.0.1:$port/opensteer" \
--     pnpm --dir packages/database exec tsx make-released-home-schema.ts
--   rm packages/database/make-released-home-schema.ts
--   # pg_dump's restrict lines carry a new random key each time and are psql commands, not SQL.
--   unrestricted() { grep -v -E '^.(un)?restrict '; }
--   echo "=====BEGIN====="
--   docker exec "$name" pg_dump -U opensteer -d opensteer --schema-only --no-owner --no-privileges \
--     | unrestricted
--   docker exec "$name" pg_dump -U opensteer -d opensteer --data-only --inserts --no-owner \
--     --no-privileges -t kysely_migration -t kysely_migration_lock | unrestricted
--   echo "=====END====="
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: opensteer_bump_all_integration_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_bump_all_integration_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into integration_authority_pending(transaction_id, owner_user_id)
    select pg_current_xact_id(), id from users on conflict do nothing;
  return null;
end $$;


--
-- Name: opensteer_bump_integration_owner_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_bump_integration_owner_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into integration_authority_pending(transaction_id, owner_user_id)
    values(pg_current_xact_id(), case when tg_op='DELETE' then old.owner_user_id else new.owner_user_id end)
    on conflict do nothing;
  return null;
end $$;


--
-- Name: opensteer_check_team_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_check_team_principal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if (new.member_user_id is not null) is distinct from
        (new.home_team_id=(select id from deployments where singleton_key='primary')) then
        raise check_violation using message='Principal home team must match its membership';
      end if;
      return new;
    end $$;


--
-- Name: opensteer_create_member_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_create_member_principal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare home_team_id text;
    begin
      select id into strict home_team_id from deployments where singleton_key='primary';
      insert into team_principals(id,home_team_id,home_user_id,member_user_id,created_at,updated_at)
        values(new.user_id,home_team_id,new.user_id,new.user_id,new.joined_at,new.changed_at);
      return new;
    end $$;


--
-- Name: opensteer_enforce_command_execution_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_command_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.type in ('run.execute', 'trigger.execute', 'run.steer', 'run.interrupt', 'request.respond')
    and not exists (
      select 1 from threads thread
      join execution_environments environment on environment.id = thread.environment_id
      join personal_settings settings on settings.owner_id = new.requested_by
      join users person on person.id = settings.owner_id and person.disabled_at is null
      where thread.id = new.thread_id and thread.environment_id = new.environment_id
        and environment.runner_id = settings.agent_home_computer_id
    ) then
    raise exception 'command requester cannot execute the thread environment';
  end if;
  return new;
end $$;


--
-- Name: opensteer_flush_integration_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_flush_integration_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare authority_owner_id text;
begin
  for authority_owner_id in
    select owner_user_id from integration_authority_pending
    where transaction_id = pg_current_xact_id() order by owner_user_id loop
    insert into integration_authority_generations(owner_user_id, generation, updated_at)
      select authority_owner_id, 1, now() where exists(select 1 from users where id = authority_owner_id)
      on conflict(owner_user_id) do update
      set generation = integration_authority_generations.generation + 1, updated_at = excluded.updated_at;
  end loop;
  delete from integration_authority_pending where transaction_id = pg_current_xact_id();
  return null;
end $$;


--
-- Name: opensteer_keep_task_team_origin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_keep_task_team_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if row(old.team_id, old.channel_id, old.thread_root_id)
    is distinct from row(new.team_id, new.channel_id, new.thread_root_id) then
    raise exception 'A task''s team origin never changes' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: opensteer_prevent_harness_instance_identity_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_harness_instance_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
end $$;


--
-- Name: opensteer_project_auth_account_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_project_auth_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op='DELETE' then
    if old.password is null then
      perform opensteer_set_account_directory_projection(old.provider_id,old.account_id,old.user_id,false);
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.password is null and (
    row(old.provider_id,old.account_id,old.user_id) is distinct from row(new.provider_id,new.account_id,new.user_id)
    or new.password is not null
  ) then
    perform opensteer_set_account_directory_projection(old.provider_id,old.account_id,old.user_id,false);
  end if;
  perform opensteer_refresh_account_directory_user(new.user_id);
  return new;
end;
$$;


--
-- Name: opensteer_project_user_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_project_user_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op='DELETE' then
    update account_directory_projections set present=false,generation=generation+1,attempts=0,
      next_attempt_at=now(),last_error=null,lease_token=null,lease_expires_at=null,updated_at=now()
    where user_id=old.id and present;
    return old;
  end if;
  perform opensteer_refresh_account_directory_user(new.id);
  return new;
end;
$$;


--
-- Name: opensteer_refresh_account_directory_user(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_refresh_account_directory_user(target_user_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  target_present boolean;
  account record;
begin
  select exists (
    select 1 from users u cross join deployments d
    where u.id=target_user_id and u.disabled_at is null and d.singleton_key='primary'
      and ((d.deployment_shape->>'kind'='personal' and u.id=(
        select id from users order by created_at limit 1
      )) or (d.deployment_shape->>'kind'='team' and exists (
        select 1 from team_members m where m.user_id=u.id and m.state='active'
      )))
  ) into target_present;
  for account in
    select a.provider_id,a.account_id from auth_accounts a
    join account_directory_provider p on p.provider_id=a.provider_id
    where a.user_id=target_user_id and a.password is null
  loop
    if target_present or exists (
      select 1 from account_directory_projections p
      where p.provider_id=account.provider_id and p.account_id=account.account_id
    ) then
      perform opensteer_set_account_directory_projection(account.provider_id,account.account_id,target_user_id,target_present);
    end if;
  end loop;
end;
$$;


--
-- Name: opensteer_set_account_directory_projection(text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_set_account_directory_projection(target_provider_id text, target_account_id text, target_user_id text, target_present boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (select 1 from account_directory_provider where provider_id=target_provider_id) then
    return;
  end if;
  insert into account_directory_projections(provider_id,account_id,user_id,present,generation,published_generation)
  values(target_provider_id,target_account_id,target_user_id,target_present,1,0)
  on conflict(provider_id,account_id) do update
  set user_id=excluded.user_id,present=excluded.present,
      generation=account_directory_projections.generation+1,attempts=0,next_attempt_at=now(),
      last_error=null,lease_token=null,lease_expires_at=null,updated_at=now()
  where account_directory_projections.present is distinct from excluded.present
     or account_directory_projections.user_id is distinct from excluded.user_id;
end;
$$;


--
-- Name: opensteer_task_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_task_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  begin
    if TG_TABLE_NAME = 'requests' then
      if new.originating_thread_id is distinct from old.originating_thread_id then
        raise check_violation using message = 'Request task cannot change';
      end if;
    elsif new.thread_id is distinct from old.thread_id then
      raise check_violation using message = 'Input task cannot change';
    end if;
    return new;
  end;
  $$;


--
-- Name: opensteer_team_message_ordinal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_team_message_ordinal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if new.created_seq=0 then
        select coalesce(max(created_seq),0)+1 into new.created_seq from team_messages where channel_id=new.channel_id;
      end if;
      return new;
    end $$;


--
-- Name: opensteer_valid_place(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_valid_place(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN ((jsonb_typeof(value) = 'object'::text) AND (value ?& ARRAY['tabId'::text, 'title'::text, 'site'::text]) AND ((value - ARRAY['tabId'::text, 'title'::text, 'site'::text]) = '{}'::jsonb) AND (jsonb_typeof((value -> 'tabId'::text)) = 'string'::text) AND ((length((value ->> 'tabId'::text)) >= 1) AND (length((value ->> 'tabId'::text)) <= 255)) AND (jsonb_typeof((value -> 'title'::text)) = 'string'::text) AND (octet_length((value ->> 'title'::text)) <= 1024) AND (((value -> 'site'::text) = 'null'::jsonb) OR ((jsonb_typeof((value -> 'site'::text)) = 'string'::text) AND (octet_length((value ->> 'site'::text)) <= 2048))));


--
-- Name: team_bus_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'access', 'revision', new.revision::text));
  return null;
end $$;


--
-- Name: team_bus_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'account'));
  return null;
end $$;


--
-- Name: team_bus_channel(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_channel() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'channel', 'channelId', new.id));
  return null;
end $$;


--
-- Name: team_bus_link(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'link', 'linkId', new.id, 'epoch', new.connection_epoch::text));
  return null;
end $$;


--
-- Name: team_bus_link_presence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_link_presence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  owner text;
begin
  select owner_user_id into owner from team_links where id = coalesce(new.link_id, old.link_id);
  if owner is not null then
    perform team_bus_notify(jsonb_build_object('kind', 'linkPresence', 'userId', owner));
  end if;
  return null;
end $$;


--
-- Name: team_bus_member(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'member', 'userId', new.id));
  return null;
end $$;


--
-- Name: team_bus_notify(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_notify(payload jsonb) RETURNS void
    LANGUAGE sql
    AS $$
  select pg_notify('opensteer_team', payload::text)
$$;


--
-- Name: team_bus_partner_call(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_partner_call() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' then
    perform team_bus_notify(jsonb_build_object('kind', 'partnerCall', 'linkId', new.link_id));
  elsif new.state in ('done', 'failed') and new.state is distinct from old.state then
    perform team_bus_notify(jsonb_build_object('kind', 'partnerResult', 'callId', new.id));
  end if;
  return null;
end $$;


--
-- Name: team_bus_partner_link(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_partner_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'partnerLink', 'linkId', new.id));
  return null;
end $$;


--
-- Name: team_bus_presence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_presence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'presence', 'userId', coalesce(new.user_id, old.user_id)));
  return null;
end $$;


--
-- Name: team_bus_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_bus_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform team_bus_notify(jsonb_build_object('kind', 'request', 'linkId', new.link_id));
  return null;
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_directory_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_directory_projections (
    provider_id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    present boolean NOT NULL,
    generation bigint NOT NULL,
    published_generation bigint NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_directory_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_directory_provider (
    singleton_key text NOT NULL,
    provider_id text NOT NULL,
    issuer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_directory_provider_singleton_key_check CHECK ((singleton_key = 'opensteer-account'::text))
);


--
-- Name: agent_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_connections (
    id text NOT NULL,
    user_id text NOT NULL,
    label text NOT NULL,
    client_name text NOT NULL,
    access_mode text NOT NULL,
    resource text NOT NULL,
    token_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: agent_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_control_requests (
    result_message_id text,
    run_id text NOT NULL,
    request_id text NOT NULL,
    source_thread_id text NOT NULL,
    action text NOT NULL,
    action_class text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_control_requests_action_check CHECK ((action = ANY (ARRAY['assignment.cancel'::text, 'device.access.request'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.sign-in'::text, 'browser.profile.create'::text, 'browser.profile.list'::text, 'browser.session.close'::text, 'browser.session.list'::text, 'browser.tab.read'::text, 'browser.tab.write'::text, 'browser.session.open'::text, 'request.list'::text, 'request.withdraw'::text, 'thread.delegate'::text, 'thread.list'::text, 'thread.message'::text, 'person.message'::text, 'person.show'::text, 'thread.read'::text, 'thread.write'::text, 'trigger.read'::text, 'trigger.write'::text, 'environment.list'::text]))),
    CONSTRAINT agent_control_requests_action_class_check CHECK ((action_class = ANY (ARRAY['assignment.cancel'::text, 'device.access.request'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.sign-in'::text, 'browser.profile.create'::text, 'browser.profile.list'::text, 'browser.session.close'::text, 'browser.session.list'::text, 'browser.tab.read'::text, 'browser.tab.write'::text, 'browser.session.open'::text, 'request.list'::text, 'request.withdraw'::text, 'thread.delegate'::text, 'thread.list'::text, 'thread.message'::text, 'person.show'::text, 'thread.read'::text, 'thread.write'::text, 'trigger.read'::text, 'trigger.write'::text, 'environment.list'::text])))
);


--
-- Name: agent_home_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_home_settings (
    computer_id text NOT NULL,
    environment_id text NOT NULL,
    boot_id text NOT NULL,
    connection_generation bigint NOT NULL,
    connection_id text NOT NULL,
    connection_lease_id text NOT NULL,
    read_sequence bigint NOT NULL,
    read_at timestamp with time zone NOT NULL,
    file_status text NOT NULL,
    file_error jsonb,
    settings jsonb NOT NULL,
    CONSTRAINT agent_home_settings_file_status_check CHECK ((file_status = ANY (ARRAY['valid'::text, 'missing'::text, 'invalid'::text])))
);


--
-- Name: agent_home_skill_inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_home_skill_inventory (
    computer_id text NOT NULL,
    environment_id text NOT NULL,
    boot_id text NOT NULL,
    connection_generation bigint NOT NULL,
    connection_id text NOT NULL,
    connection_lease_id text NOT NULL,
    binding_generation integer NOT NULL,
    scan_sequence bigint NOT NULL,
    scanned_at timestamp with time zone NOT NULL,
    scan_status text NOT NULL,
    metadata jsonb NOT NULL,
    CONSTRAINT agent_home_skill_inventory_scan_status_check CHECK ((scan_status = ANY (ARRAY['complete'::text, 'failed'::text])))
);


--
-- Name: app_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_servers (
    app_id text NOT NULL,
    computer_id text NOT NULL,
    port integer NOT NULL,
    desired_state text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    last_error text,
    CONSTRAINT app_servers_desired_state_check CHECK ((desired_state = ANY (ARRAY['running'::text, 'stopped'::text]))),
    CONSTRAINT app_servers_generation_check CHECK ((generation > 0)),
    CONSTRAINT app_servers_port_check CHECK (((port >= 49152) AND (port <= 65535)))
);


--
-- Name: app_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_versions (
    app_id text NOT NULL,
    version integer NOT NULL,
    sha256 text,
    size_bytes integer,
    server jsonb,
    created_by_run text,
    publish_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id text NOT NULL,
    thread_id text,
    run_id text,
    name text CONSTRAINT apps_title_not_null NOT NULL,
    latest_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id text NOT NULL,
    computer_id text NOT NULL,
    creation_key text,
    deleting boolean DEFAULT false NOT NULL,
    CONSTRAINT apps_latest_version CHECK ((latest_version >= 0))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id text NOT NULL,
    uploader_id text NOT NULL,
    name text NOT NULL,
    media_type text NOT NULL,
    size_bytes integer NOT NULL,
    kind text,
    width integer,
    height integer,
    sha256 text,
    state text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    message_id text,
    thread_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'file'::text]))),
    CONSTRAINT attachments_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'ready'::text, 'deleting'::text])))
);


--
-- Name: auth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_accounts (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_admissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_admissions (
    id text NOT NULL,
    purpose text NOT NULL,
    subject_selector text NOT NULL,
    browser_nonce_hash text NOT NULL,
    reserved_email text,
    reserved_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_admissions_purpose_check CHECK ((purpose = ANY (ARRAY['setup'::text, 'recovery'::text, 'invitation'::text])))
);


--
-- Name: auth_jwks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    alg text,
    crv text
);


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    member_generation bigint,
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    absolute_expires_at timestamp with time zone DEFAULT now() NOT NULL,
    device_label text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_via text,
    account_issuer text,
    account_subject text,
    grant_id text,
    device_id text
);


--
-- Name: auth_sso_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sso_providers (
    id text NOT NULL,
    issuer text NOT NULL,
    oidc_config text,
    saml_config text,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    organization_id text,
    domain text NOT NULL
);


--
-- Name: auth_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_failure_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_failure_notices (
    id text NOT NULL,
    trigger_id text NOT NULL,
    occurrence_id text,
    activation_id text,
    reason text NOT NULL,
    detail text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_failure_notices_reason_check CHECK ((reason = ANY (ARRAY['final-occurrence-failed'::text, 'final-occurrence-interrupted'::text, 'paused'::text])))
);


--
-- Name: browser_history_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_history_entries (
    profile_id text NOT NULL,
    url text NOT NULL,
    origin text NOT NULL,
    title text NOT NULL,
    typed_count integer NOT NULL,
    visit_count integer NOT NULL,
    last_visit_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_history_icons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_history_icons (
    profile_id text NOT NULL,
    origin text NOT NULL,
    icon_ref text NOT NULL,
    favicon text NOT NULL
);


--
-- Name: browser_profile_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profile_deletions (
    deletion_id text NOT NULL,
    profile_id text NOT NULL,
    binding_version integer NOT NULL,
    deployment_id text NOT NULL,
    runner_id text NOT NULL,
    storage_instance_id text NOT NULL,
    binding_id text NOT NULL,
    engine text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT browser_profile_deletions_binding_version_check CHECK ((binding_version = 1)),
    CONSTRAINT browser_profile_deletions_state_check CHECK ((state = ANY (ARRAY['pending-computer'::text, 'pending-restart'::text, 'deleted'::text, 'unconfirmed'::text])))
);


--
-- Name: browser_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profiles (
    home_runner_id text,
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    storage_state text DEFAULT 'unbound'::text NOT NULL,
    storage_binding_version integer,
    storage_deployment_id text,
    storage_runner_id text,
    storage_instance_id text,
    storage_binding_id text,
    storage_engine text,
    initialized boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT browser_profiles_storage_binding_version_check CHECK ((storage_binding_version = 1)),
    CONSTRAINT browser_profiles_storage_state_check CHECK ((storage_state = ANY (ARRAY['unbound'::text, 'local'::text])))
);


--
-- Name: browser_session_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_attachments (
    agent_binding_id text NOT NULL,
    owner_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_session_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_uses (
    id text NOT NULL,
    session_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    tab_id text,
    page_title text,
    page_site text,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    tab_group_id text NOT NULL,
    tab_revision integer DEFAULT 0 NOT NULL,
    opener jsonb,
    id text NOT NULL,
    origin text NOT NULL,
    profile_id text,
    placement_key text NOT NULL,
    runner_id text NOT NULL,
    runtime_id text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT browser_sessions_origin_check CHECK ((origin = ANY (ARRAY['agent'::text, 'trigger'::text, 'person'::text]))),
    CONSTRAINT browser_sessions_state_check CHECK ((state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text, 'closed'::text, 'failed'::text])))
);


--
-- Name: browser_sign_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sign_ins (
    owner_id text NOT NULL,
    id text NOT NULL,
    site text NOT NULL,
    source_id text NOT NULL,
    source_name text NOT NULL,
    session_id text NOT NULL,
    profile_name text,
    request_id text,
    actor text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT browser_sign_ins_actor_check CHECK ((actor = ANY (ARRAY['agent'::text, 'owner'::text, 'request'::text])))
);


--
-- Name: browser_site_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_site_grants (
    deployment_id text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    site text NOT NULL,
    preferred_source_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_signed_in_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: browser_source_pairings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_source_pairings (
    code_hash text NOT NULL,
    owner_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    canonical_origin text NOT NULL,
    remote_origin text,
    remote_generation integer
);


--
-- Name: browser_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sources (
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    paired_origin text,
    paired_route_generation integer
);


--
-- Name: browser_tab_opens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_tab_opens (
    owner_id text NOT NULL,
    idempotency_key text NOT NULL,
    binding jsonb NOT NULL,
    identity_key text,
    runner_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: causal_chains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.causal_chains (
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id text NOT NULL,
    max_delegations integer NOT NULL,
    max_autonomous_runs integer NOT NULL,
    root_message_id text,
    root_occurrence_id text,
    root_watch_activation_id text,
    root_watch_observation_id text,
    used_delegations integer NOT NULL,
    used_autonomous_runs integer NOT NULL
);


--
-- Name: channel_access_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_access_grants (
    account_id text NOT NULL,
    binding_id text NOT NULL,
    external_user_id text NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL,
    revision integer NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    request_ingress_id text,
    decided_at timestamp with time zone,
    decided_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_access_grants_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'revoked'::text])))
);


--
-- Name: channel_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_accounts (
    id text NOT NULL,
    connection_id text NOT NULL,
    provider text NOT NULL,
    external_account_id text NOT NULL,
    display_name text NOT NULL,
    handle text,
    routing_mode text NOT NULL,
    status text NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_accounts_routing_mode_check CHECK ((routing_mode = ANY (ARRAY['dedicated'::text, 'shared'::text]))),
    CONSTRAINT channel_accounts_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'needs-attention'::text, 'paused'::text, 'revoked'::text])))
);


--
-- Name: channel_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_bindings (
    id text NOT NULL,
    account_id text NOT NULL,
    created_by text NOT NULL,
    selector jsonb NOT NULL,
    execution_policy jsonb NOT NULL,
    access_policy jsonb NOT NULL,
    revision integer NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'revoked'::text])))
);


--
-- Name: channel_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_conversations (
    personal_context boolean DEFAULT false NOT NULL,
    id text NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    external_account_id text NOT NULL,
    binding_id text NOT NULL,
    binding_revision integer NOT NULL,
    external_scope_id text,
    external_conversation_id text NOT NULL,
    external_thread_id text,
    conversation_type text NOT NULL,
    display_name text,
    active_thread_id text,
    provider_state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_conversations_conversation_type_check CHECK ((conversation_type = ANY (ARRAY['dm'::text, 'group'::text, 'channel'::text])))
);


--
-- Name: channel_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_deliveries (
    id text NOT NULL,
    account_id text NOT NULL,
    conversation_id text,
    ingress_id text,
    message_id text,
    audience text NOT NULL,
    kind text NOT NULL,
    part integer DEFAULT 0 NOT NULL,
    part_count integer DEFAULT 0 NOT NULL,
    content jsonb NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    claim_token_hash text,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    receipt jsonb,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_deliveries_audience_check CHECK ((audience = ANY (ARRAY['conversation'::text, 'actor'::text]))),
    CONSTRAINT channel_deliveries_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'status'::text]))),
    CONSTRAINT channel_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'attempt-started'::text, 'sent'::text, 'retryable-failed'::text, 'unknown'::text, 'dead'::text])))
);


--
-- Name: channel_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_identities (
    id text NOT NULL,
    account_id text NOT NULL,
    principal_id text NOT NULL,
    external_user_id text NOT NULL,
    display_name text NOT NULL,
    linked_user_id text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_identities_status_check CHECK ((status = ANY (ARRAY['unlinked'::text, 'linked'::text])))
);


--
-- Name: channel_ingress_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_ingress_events (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_event_id text NOT NULL,
    lane_key text NOT NULL,
    event jsonb NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    claim_token_hash text,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    conversation_id text,
    message_id text,
    run_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_ingress_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'adopted'::text, 'ignored'::text, 'dead'::text])))
);


--
-- Name: channel_link_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_link_codes (
    id text NOT NULL,
    account_id text NOT NULL,
    user_id text,
    code_hash text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    identity_id text NOT NULL,
    request_ingress_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_changes (
    deployment_id text NOT NULL,
    sequence bigint NOT NULL,
    scope_key text NOT NULL,
    ordinal smallint NOT NULL,
    entity_kind text NOT NULL,
    entity_id text NOT NULL,
    operation text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    byte_count integer GENERATED ALWAYS AS (octet_length((payload)::text)) STORED,
    CONSTRAINT client_changes_byte_count_check CHECK ((byte_count <= 524288)),
    CONSTRAINT client_changes_check CHECK ((((entity_kind = 'scope'::text) = (operation = 'reset'::text)) AND (((scope_key = 'shell'::text) AND (entity_kind = ANY (ARRAY['task'::text, 'visit'::text, 'attention'::text, 'scope'::text]))) OR ((scope_key <> 'shell'::text) AND (entity_kind = ANY (ARRAY['thread'::text, 'run-queue'::text, 'queue-entry'::text, 'assignment'::text, 'request'::text, 'item'::text, 'node'::text, 'scope'::text])))))),
    CONSTRAINT client_changes_operation_check CHECK ((operation = ANY (ARRAY['upsert'::text, 'remove'::text, 'reset'::text]))),
    CONSTRAINT client_changes_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 127))),
    CONSTRAINT client_changes_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT client_changes_scope_key_check CHECK (((scope_key = 'shell'::text) OR (scope_key ~ '^(thread|node):.+$'::text))),
    CONSTRAINT client_changes_sequence_check CHECK ((sequence > 0))
);


--
-- Name: client_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_sync_state (
    deployment_id text CONSTRAINT deployment_event_state_deployment_id_not_null NOT NULL,
    sequence bigint DEFAULT 0 CONSTRAINT deployment_event_state_sequence_not_null NOT NULL,
    epoch uuid DEFAULT gen_random_uuid() NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    pruned_through_sequence bigint DEFAULT 0 NOT NULL,
    retained_change_count integer DEFAULT 0 NOT NULL,
    last_commit_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    resource_revisions jsonb DEFAULT '{"tab": "0", "plugin": "0", "harness": "0", "machine": "0", "identity": "0", "settings": "0", "tab-layout": "0", "environment": "0", "browser-home": "0", "team-replies": "0", "owner-profile": "0", "browser-profile": "0", "harness-catalog": "0", "browser-placement": "0", "browser-availability": "0"}'::jsonb NOT NULL,
    pending_request_count integer DEFAULT 0 NOT NULL,
    needs_you_count integer DEFAULT 0 NOT NULL,
    unread_task_count integer DEFAULT 0 NOT NULL,
    pending_requests_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT client_sync_state_check CHECK (((pruned_through_sequence >= 0) AND (pruned_through_sequence <= sequence))),
    CONSTRAINT client_sync_state_check2 CHECK ((needs_you_count >= pending_request_count)),
    CONSTRAINT client_sync_state_check3 CHECK (((pending_requests_revision >= 0) AND (pending_requests_revision <= sequence))),
    CONSTRAINT client_sync_state_check4 CHECK (((jsonb_typeof(resource_revisions) = 'object'::text) AND (resource_revisions ?& ARRAY['settings'::text, 'identity'::text, 'owner-profile'::text, 'environment'::text, 'machine'::text, 'harness'::text, 'harness-catalog'::text, 'tab'::text, 'tab-layout'::text, 'browser-profile'::text, 'browser-placement'::text, 'browser-home'::text, 'browser-availability'::text, 'plugin'::text, 'team-replies'::text]) AND ((resource_revisions - ARRAY['settings'::text, 'identity'::text, 'owner-profile'::text, 'environment'::text, 'machine'::text, 'harness'::text, 'harness-catalog'::text, 'tab'::text, 'tab-layout'::text, 'browser-profile'::text, 'browser-placement'::text, 'browser-home'::text, 'browser-availability'::text, 'plugin'::text, 'team-replies'::text]) = '{}'::jsonb) AND (jsonb_typeof((resource_revisions -> 'settings'::text)) = 'string'::text) AND ((resource_revisions ->> 'settings'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'settings'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'identity'::text)) = 'string'::text) AND ((resource_revisions ->> 'identity'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'identity'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'owner-profile'::text)) = 'string'::text) AND ((resource_revisions ->> 'owner-profile'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'owner-profile'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'environment'::text)) = 'string'::text) AND ((resource_revisions ->> 'environment'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'environment'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'machine'::text)) = 'string'::text) AND ((resource_revisions ->> 'machine'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'machine'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'harness'::text)) = 'string'::text) AND ((resource_revisions ->> 'harness'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'harness'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'harness-catalog'::text)) = 'string'::text) AND ((resource_revisions ->> 'harness-catalog'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'harness-catalog'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'tab'::text)) = 'string'::text) AND ((resource_revisions ->> 'tab'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'tab'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'tab-layout'::text)) = 'string'::text) AND ((resource_revisions ->> 'tab-layout'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'tab-layout'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'browser-profile'::text)) = 'string'::text) AND ((resource_revisions ->> 'browser-profile'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'browser-profile'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'browser-placement'::text)) = 'string'::text) AND ((resource_revisions ->> 'browser-placement'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'browser-placement'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'browser-home'::text)) = 'string'::text) AND ((resource_revisions ->> 'browser-home'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'browser-home'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'browser-availability'::text)) = 'string'::text) AND ((resource_revisions ->> 'browser-availability'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'browser-availability'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'plugin'::text)) = 'string'::text) AND ((resource_revisions ->> 'plugin'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'plugin'::text))::numeric <= (sequence)::numeric) AND (jsonb_typeof((resource_revisions -> 'team-replies'::text)) = 'string'::text) AND ((resource_revisions ->> 'team-replies'::text) ~ '^(0|[1-9][0-9]{0,18})$'::text) AND (((resource_revisions ->> 'team-replies'::text))::numeric <= (sequence)::numeric))),
    CONSTRAINT client_sync_state_pending_request_count_check CHECK ((pending_request_count >= 0)),
    CONSTRAINT client_sync_state_retained_change_count_check CHECK (((retained_change_count >= 0) AND (retained_change_count <= 4096))),
    CONSTRAINT client_sync_state_unread_task_count_check CHECK ((unread_task_count >= 0)),
    CONSTRAINT deployment_event_state_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commands (
    id text NOT NULL,
    environment_id text,
    thread_id text,
    run_id text,
    requested_by text NOT NULL,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    idempotency_key text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    encrypted_request_response bytea,
    request_response_key_version integer,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    dispatcher_id text,
    last_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: computer_app_setup_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_app_setup_requests (
    kind text NOT NULL,
    policy_app_approval text,
    thread_id text,
    reason text,
    thread_title text,
    id text NOT NULL,
    deployment_id text NOT NULL,
    owner_user_id text NOT NULL,
    runner_id text NOT NULL,
    definition_id text NOT NULL,
    definition_digest text NOT NULL,
    access text NOT NULL,
    app jsonb,
    app_key text,
    server jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT computer_app_setup_requests_access_check CHECK ((access = ANY (ARRAY['read'::text, 'read-write'::text]))),
    CONSTRAINT computer_app_setup_requests_kind_check CHECK ((kind = ANY (ARRAY['app'::text, 'policy'::text, 'server'::text]))),
    CONSTRAINT computer_app_setup_requests_policy_app_approval_check CHECK ((policy_app_approval = 'automatic'::text))
);


--
-- Name: computer_use_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_policies (
    deployment_id text NOT NULL,
    runner_id text NOT NULL,
    owner_user_id text NOT NULL,
    app_approval text NOT NULL,
    revision integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT computer_use_policies_app_approval_check CHECK ((app_approval = ANY (ARRAY['ask'::text, 'automatic'::text])))
);


--
-- Name: computer_use_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_stops (
    run_id text NOT NULL,
    runner_id text NOT NULL,
    stopped_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credential_access_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential_access_audit (
    actor_id text NOT NULL,
    id text NOT NULL,
    credential_id text NOT NULL,
    connection_id text NOT NULL,
    runner_id text,
    purpose text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credential_access_audit_purpose_check CHECK ((purpose = ANY (ARRAY['channel-delivery'::text, 'channel-transport'::text, 'channel-webhook'::text])))
);


--
-- Name: credential_vault_canaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential_vault_canaries (
    key_version integer NOT NULL,
    encrypted_payload bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credentials (
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    encrypted_payload bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegations (
    initial_input_message_id text NOT NULL,
    objective text NOT NULL,
    origin text NOT NULL,
    parent_assignment_id text,
    status text NOT NULL,
    result_text text,
    result_waits jsonb DEFAULT '[]'::jsonb NOT NULL,
    result_run_id text,
    finished_at timestamp with time zone,
    revision integer DEFAULT 1 NOT NULL,
    child_run_id text NOT NULL,
    child_thread_id text NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id text NOT NULL,
    parent_occurrence_id text,
    parent_watch_activation_id text,
    parent_run_id text,
    parent_thread_id text NOT NULL,
    reply_target jsonb,
    result_attempted_at timestamp with time zone,
    result_message_id text,
    result_reason text,
    result_status text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cancellation_root_id text,
    CONSTRAINT delegations_check CHECK (((cancellation_root_id IS NULL) OR (status = 'cancelled'::text))),
    CONSTRAINT delegations_revision_check CHECK ((revision >= 1))
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id text NOT NULL,
    singleton_key text NOT NULL,
    active_host_instance_id text NOT NULL,
    canonical_origin text NOT NULL,
    lifecycle text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deployment_shape jsonb NOT NULL,
    CONSTRAINT deployments_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['active'::text, 'transferring'::text, 'sealed'::text]))),
    CONSTRAINT deployments_shape CHECK ((deployment_shape = ANY (ARRAY['{"kind": "personal"}'::jsonb, '{"kind": "team"}'::jsonb]))),
    CONSTRAINT deployments_singleton_key_check CHECK ((singleton_key = 'primary'::text))
);


--
-- Name: device_drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_drivers (
    device_id text NOT NULL,
    role text NOT NULL,
    runner_id text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    detached_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_drivers_generation_check CHECK (((generation > 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT device_drivers_role_check CHECK ((role = ANY (ARRAY['self'::text, 'screen'::text])))
);


--
-- Name: device_setup_retirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_setup_retirements (
    runner_id text NOT NULL,
    public_key_pem text NOT NULL
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id text NOT NULL,
    deployment_id text NOT NULL,
    owner_kind text NOT NULL,
    owner_user_id text,
    name text NOT NULL,
    kind text NOT NULL,
    platform text,
    form text,
    access_policy jsonb NOT NULL,
    access_policy_revision integer DEFAULT 1 NOT NULL,
    removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT devices_access_policy_revision_check CHECK ((access_policy_revision >= 0)),
    CONSTRAINT devices_check CHECK (((owner_kind = 'user'::text) = (owner_user_id IS NOT NULL))),
    CONSTRAINT devices_form_check CHECK ((form = ANY (ARRAY['laptop'::text, 'desktop'::text, 'compact'::text, 'server'::text, 'phone'::text]))),
    CONSTRAINT devices_kind_check CHECK ((kind = ANY (ARRAY['home'::text, 'computer'::text, 'phone'::text, 'agent-phone'::text, 'server'::text, 'unknown'::text]))),
    CONSTRAINT devices_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['deployment'::text, 'user'::text]))),
    CONSTRAINT devices_platform_check CHECK ((platform = ANY (ARRAY['macos'::text, 'linux'::text, 'windows'::text, 'android'::text, 'ios'::text])))
);


--
-- Name: execution_environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_environments (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    runner_id text,
    capabilities jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_environments_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text])))
);


--
-- Name: execution_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_nodes (
    stop_supported boolean DEFAULT false NOT NULL,
    stopping boolean DEFAULT false NOT NULL,
    id text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    parent_node_id text,
    kind text NOT NULL,
    effort text,
    phase_index integer,
    phases jsonb NOT NULL,
    title text NOT NULL,
    prompt text,
    model text,
    native_ref text NOT NULL,
    session_ref text,
    origin_call_id text,
    status text NOT NULL,
    result text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    cost_usd numeric(18,8),
    CONSTRAINT execution_nodes_kind_check CHECK ((kind = ANY (ARRAY['subagent'::text, 'task'::text, 'workflow'::text]))),
    CONSTRAINT execution_nodes_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'interrupted'::text])))
);


--
-- Name: grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grants (
    id text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    binding_generation integer NOT NULL,
    runner_id text NOT NULL,
    runner_boot_id text NOT NULL,
    status text NOT NULL,
    revoked_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT grants_revoked_reason_check CHECK ((revoked_reason = ANY (ARRAY['stopped'::text, 'assignment-cancelled'::text, 'binding-replaced'::text, 'superseded'::text]))),
    CONSTRAINT grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: harness_catalogs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_catalogs (
    environment_id text NOT NULL,
    harness_instance_id text NOT NULL,
    catalog jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: harness_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_instances (
    id text NOT NULL,
    environment_id text NOT NULL,
    driver_kind text NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    runtime_revision integer NOT NULL,
    state_kind text NOT NULL,
    enabled boolean NOT NULL,
    is_default boolean NOT NULL,
    source_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone
);


--
-- Name: host_account_adoption_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_account_adoption_proofs (
    id text NOT NULL,
    credential_hash text NOT NULL,
    deployment_id text NOT NULL,
    host_instance_id text NOT NULL,
    host_key_fingerprint text NOT NULL,
    canonical_origin text NOT NULL,
    authorized_by_user_id text NOT NULL,
    authorized_by_session_id text NOT NULL,
    expected_issuer text,
    expected_subject text,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: host_oauth_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_access_tokens (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text NOT NULL,
    user_id text,
    reference_id text,
    refresh_id text,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scopes jsonb NOT NULL,
    authorization_code_id text,
    resources jsonb,
    requested_user_info_claims jsonb,
    revoked timestamp with time zone,
    confirmation jsonb
);


--
-- Name: host_oauth_client_assertions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_client_assertions (
    id text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: host_oauth_client_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_client_resources (
    id text NOT NULL,
    client_id text NOT NULL,
    resource_id text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone
);


--
-- Name: host_oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_clients (
    id text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    disabled boolean NOT NULL,
    skip_consent boolean,
    enable_end_session boolean,
    subject_type text,
    scopes jsonb,
    user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    software_id text,
    software_version text,
    software_statement text,
    redirect_uris jsonb NOT NULL,
    post_logout_redirect_uris jsonb,
    token_endpoint_auth_method text,
    grant_types jsonb,
    response_types jsonb,
    require_pkce boolean,
    reference_id text,
    metadata jsonb,
    client_discovery_id text,
    client_credentials_scopes jsonb,
    backchannel_logout_uri text,
    backchannel_logout_session_required boolean,
    application_type text,
    jwks text,
    jwks_uri text,
    dpop_bound_access_tokens boolean
);


--
-- Name: host_oauth_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_consents (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text,
    reference_id text,
    scopes jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resources jsonb,
    requested_user_info_claims jsonb
);


--
-- Name: host_oauth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_refresh_tokens (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text NOT NULL,
    user_id text NOT NULL,
    reference_id text,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked timestamp with time zone,
    auth_time timestamp with time zone,
    scopes jsonb NOT NULL,
    authorization_code_id text,
    resources jsonb,
    requested_user_info_claims jsonb,
    rotated_at timestamp with time zone,
    rotation_replay_response text,
    rotation_replay_expires_at timestamp with time zone,
    confirmation jsonb
);


--
-- Name: host_oauth_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_resources (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    access_token_ttl integer,
    refresh_token_ttl integer,
    signing_algorithm text,
    signing_key_id text,
    allowed_scopes jsonb,
    custom_claims jsonb,
    dpop_bound_access_tokens_required boolean,
    disabled boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    policy_version integer,
    metadata jsonb
);


--
-- Name: integration_auth_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_auth_attempts (
    id text NOT NULL,
    flow text NOT NULL,
    owner_user_id text NOT NULL,
    state_hash text NOT NULL,
    launch_ticket_hash text NOT NULL,
    browser_binding_hash text,
    encrypted_payload bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    status text NOT NULL,
    surface text NOT NULL,
    failure_reason text,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    launched_at timestamp with time zone,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_auth_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'launched'::text, 'claimed'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT integration_auth_attempts_surface_check CHECK ((surface = ANY (ARRAY['desktop'::text, 'native'::text, 'web'::text])))
);


--
-- Name: integration_authority_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_authority_generations (
    owner_user_id text NOT NULL,
    generation integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_authority_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_authority_pending (
    transaction_id xid8 NOT NULL,
    owner_user_id text NOT NULL
);


--
-- Name: integration_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_connections (
    account_identifier text,
    id text NOT NULL,
    owner_user_id text NOT NULL,
    credential_id text,
    credential_generation integer DEFAULT 1 NOT NULL,
    connection_kind text NOT NULL,
    computer_access text,
    computer_app jsonb,
    computer_app_key text,
    computer_blocked_at timestamp with time zone,
    computer_policy_revision integer,
    provider text NOT NULL,
    integration_server_id text,
    connection_method text NOT NULL,
    status text NOT NULL,
    display_name text NOT NULL,
    external_identity_id text,
    external_tenant_id text,
    capabilities jsonb NOT NULL,
    integration_definition_id text,
    runner_id text,
    source_connection_id text,
    status_detail text,
    status_reason text,
    transport_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    CONSTRAINT integration_connections_connection_kind_check CHECK ((connection_kind = ANY (ARRAY['channel'::text, 'computer'::text]))),
    CONSTRAINT integration_connections_credential_generation_check CHECK ((credential_generation > 0)),
    CONSTRAINT integration_connections_device_target CHECK ((((connection_kind = 'computer'::text) AND ((device_id IS NOT NULL) OR (runner_id IS NOT NULL)) AND ((device_id IS NULL) OR (runner_id IS NULL) OR (device_id = runner_id))) OR ((connection_kind <> 'computer'::text) AND (device_id IS NULL)))),
    CONSTRAINT integration_connections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text, 'needs-attention'::text, 'paused'::text, 'revoked'::text])))
);


--
-- Name: integration_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_grants (
    access text NOT NULL,
    id text NOT NULL,
    owner_user_id text NOT NULL,
    installation_id text NOT NULL,
    connection_id text,
    alias text NOT NULL,
    is_default boolean NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    status text NOT NULL,
    CONSTRAINT integration_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: integration_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_installations (
    id text NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    version text,
    plugin_id text,
    source_kind text NOT NULL,
    trust text NOT NULL,
    manifest jsonb NOT NULL,
    provenance jsonb NOT NULL,
    status text NOT NULL,
    revision integer NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_installations_source_kind_check CHECK ((source_kind = ANY (ARRAY['plugin'::text, 'built-in'::text]))),
    CONSTRAINT integration_installations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'needs-attention'::text]))),
    CONSTRAINT integration_installations_trust_check CHECK ((trust = ANY (ARRAY['built-in'::text, 'verified-publisher'::text, 'administrator-approved'::text])))
);


--
-- Name: integration_request_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_request_details (
    access text,
    request_id text NOT NULL,
    installation_id text,
    requested_connection_id text,
    requested_server_id text,
    manifest jsonb
);


--
-- Name: integration_server_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_server_secrets (
    server_id text NOT NULL,
    runner_id text NOT NULL,
    encrypted_payload bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_servers (
    connection_requirement jsonb NOT NULL,
    id text NOT NULL,
    installation_id text NOT NULL,
    name text NOT NULL,
    transport jsonb NOT NULL,
    status text NOT NULL,
    status_detail text,
    tool_generation integer NOT NULL,
    approved_launch_digest text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_servers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'needs-attention'::text])))
);


--
-- Name: integration_tool_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_tool_definitions (
    server_id text NOT NULL,
    connection_id text,
    definitions jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_tools (
    id text NOT NULL,
    server_id text NOT NULL,
    connection_id text,
    name text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    input_schema jsonb NOT NULL,
    output_schema jsonb,
    annotations jsonb NOT NULL,
    schema_digest text NOT NULL,
    definition_names text[] DEFAULT '{}'::text[] NOT NULL,
    target jsonb,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_tools_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: kysely_migration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kysely_migration (
    name character varying(255) NOT NULL,
    "timestamp" character varying(255) NOT NULL
);


--
-- Name: kysely_migration_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kysely_migration_lock (
    id character varying(255) NOT NULL,
    is_locked integer DEFAULT 0 NOT NULL
);


--
-- Name: machine_access_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_access_events (
    id bigint NOT NULL,
    session_id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    event jsonb NOT NULL
);


--
-- Name: machine_access_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.machine_access_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.machine_access_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: machine_access_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_access_sessions (
    id text NOT NULL,
    runner_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    requested_by text NOT NULL,
    caller_runner_id text NOT NULL,
    caller_machine_name text NOT NULL,
    thread_title text NOT NULL,
    policy_revision integer NOT NULL,
    state text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    bytes_in bigint NOT NULL,
    bytes_out bigint NOT NULL,
    CONSTRAINT machine_access_sessions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'ended'::text])))
);


--
-- Name: message_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_revisions (
    message_id text NOT NULL,
    revision integer NOT NULL,
    content jsonb NOT NULL,
    author jsonb NOT NULL,
    device_label text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT message_revisions_revision_check CHECK ((revision >= 0))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    addressed_to_user_id text,
    quote jsonb,
    author jsonb NOT NULL,
    id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    sequence bigint NOT NULL,
    kind text NOT NULL,
    actor_principal_id text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    edited_at timestamp with time zone,
    origin jsonb,
    published boolean DEFAULT false NOT NULL,
    CONSTRAINT messages_edit CHECK (((revision = 0) = (edited_at IS NULL))),
    CONSTRAINT messages_revision_check CHECK ((revision >= 0))
);


--
-- Name: notification_preview_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preview_keys (
    user_id text NOT NULL,
    installation_id text NOT NULL,
    auth_session_id text NOT NULL,
    account_id text NOT NULL,
    key_id text NOT NULL,
    encrypted_key bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: owner_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owner_enrollments (
    id text NOT NULL,
    token_hash text NOT NULL,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT owner_enrollments_kind_check CHECK ((kind = ANY (ARRAY['initial'::text, 'recovery'::text])))
);


--
-- Name: personal_account_link_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_account_link_keys (
    challenge_id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_attention; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_attention (
    id text NOT NULL,
    kind text NOT NULL,
    request_id text,
    team_deployment_id text,
    team_request_id text,
    thread_id text,
    sort_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT personal_attention_check CHECK (
CASE
    WHEN (kind = 'request'::text) THEN ((request_id IS NOT NULL) AND (team_request_id IS NULL))
    ELSE ((request_id IS NULL) AND (team_request_id IS NOT NULL))
END),
    CONSTRAINT personal_attention_check1 CHECK (((kind = 'team-ask'::text) = (expires_at IS NOT NULL))),
    CONSTRAINT personal_attention_kind_check CHECK ((kind = ANY (ARRAY['request'::text, 'team-ask'::text, 'failed-ask'::text]))),
    CONSTRAINT personal_attention_revision_check CHECK ((revision >= 0))
);


--
-- Name: personal_desktop_update; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_desktop_update (
    "position" bigint NOT NULL,
    id text NOT NULL,
    requested_by text NOT NULL,
    idempotency_key text NOT NULL,
    intent jsonb NOT NULL,
    state text NOT NULL,
    from_version text,
    target_version text,
    incarnation_id text,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_desktop_update_position_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.personal_desktop_update ALTER COLUMN "position" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.personal_desktop_update_position_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: personal_remote_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_access (
    singleton_key text NOT NULL,
    generation bigint NOT NULL,
    mode text NOT NULL,
    route_origin text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_access_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'connect'::text, 'private'::text]))),
    CONSTRAINT personal_remote_access_singleton_key_check CHECK ((singleton_key = 'personal'::text))
);


--
-- Name: personal_remote_account_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_account_link (
    account_operation jsonb,
    singleton_key text NOT NULL,
    challenge_id text NOT NULL,
    grant_id text NOT NULL,
    issuer text NOT NULL,
    host_credential text NOT NULL,
    link_generation text NOT NULL,
    state text NOT NULL,
    subject text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_account_link_singleton_key_check CHECK ((singleton_key = 'opensteer-account'::text)),
    CONSTRAINT personal_remote_account_link_state_check CHECK ((state = ANY (ARRAY['activating'::text, 'active'::text])))
);


--
-- Name: personal_remote_administration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_administration (
    "position" bigint NOT NULL,
    execution_id text NOT NULL,
    requested_intent jsonb NOT NULL,
    id text NOT NULL,
    requested_by text NOT NULL,
    idempotency_key text NOT NULL,
    intent jsonb NOT NULL,
    state text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_administration_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: personal_remote_administration_position_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.personal_remote_administration ALTER COLUMN "position" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.personal_remote_administration_position_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: personal_remote_pairing_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_pairing_codes (
    credential_hash text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    generation bigint NOT NULL,
    id text NOT NULL,
    issued_by_session_id text NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_remote_session_grant_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_session_grant_uses (
    grant_id text NOT NULL,
    generation bigint NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_remote_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_sessions (
    auth_session_id text NOT NULL,
    delivery text NOT NULL,
    route_generation bigint NOT NULL,
    route_kind text NOT NULL,
    route_origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_sessions_route_kind_check CHECK ((route_kind = ANY (ARRAY['connect'::text, 'private'::text])))
);


--
-- Name: personal_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_settings (
    singleton_key text NOT NULL,
    owner_id text NOT NULL,
    agent_home_computer_id text NOT NULL,
    agent_home_path text NOT NULL,
    voice_thread_id text,
    time_zone text,
    quiet_task_days integer NOT NULL,
    execution_preferences jsonb NOT NULL,
    idle_compaction_policy jsonb DEFAULT '{"mode": "onReturn"}'::jsonb NOT NULL,
    owner_name text,
    owner_name_set_at timestamp with time zone,
    owner_name_revision bigint,
    owner_name_account jsonb,
    CONSTRAINT personal_settings_check CHECK (((singleton_key = 'personal'::text) AND (agent_home_path <> ''::text))),
    CONSTRAINT personal_settings_owner_name_account_named CHECK (((owner_name_account IS NULL) OR (owner_name IS NOT NULL))),
    CONSTRAINT personal_settings_owner_name_revision_check CHECK ((owner_name_revision >= 1)),
    CONSTRAINT personal_settings_owner_name_source CHECK (((owner_name_revision IS NULL) = (owner_name_account IS NULL))),
    CONSTRAINT personal_settings_singleton_key_check CHECK ((singleton_key = 'personal'::text))
);


--
-- Name: personal_tabs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_tabs (
    id text NOT NULL,
    owner_id text NOT NULL,
    kind text NOT NULL,
    computer_id text NOT NULL,
    title text NOT NULL,
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
    opened_by jsonb NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    closed_position jsonb,
    CONSTRAINT personal_tabs_check CHECK ((((kind = 'page'::text) AND (url IS NOT NULL) AND (app_id IS NULL) AND (window_id IS NULL) AND (window_app IS NULL) AND ((profile_id IS NULL) = (profile_name IS NULL))) OR ((kind = 'window'::text) AND (window_id IS NOT NULL) AND (window_app IS NOT NULL) AND (url IS NULL) AND (profile_id IS NULL) AND (profile_name IS NULL) AND (app_id IS NULL) AND (page_binding IS NULL)) OR ((kind = 'phone'::text) AND (url IS NULL) AND (profile_id IS NULL) AND (profile_name IS NULL) AND (app_id IS NULL) AND (window_id IS NULL) AND (window_app IS NULL) AND (page_binding IS NULL)) OR ((kind = 'app'::text) AND (app_id IS NOT NULL) AND (url IS NULL) AND (profile_id IS NULL) AND (profile_name IS NULL) AND (window_id IS NULL) AND (window_app IS NULL) AND (page_binding IS NULL)))),
    CONSTRAINT personal_tabs_generation_check CHECK ((generation > 0)),
    CONSTRAINT personal_tabs_kind_check CHECK ((kind = ANY (ARRAY['page'::text, 'window'::text, 'phone'::text, 'app'::text])))
);


--
-- Name: personal_team_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_team_links (
    id text NOT NULL,
    team_deployment_id text NOT NULL,
    team_host_instance_id text NOT NULL,
    host_key_fingerprint text NOT NULL,
    approved_origin text NOT NULL,
    authority_envelope jsonb NOT NULL,
    remote_link_id text,
    remote_owner_user_id text,
    state text NOT NULL,
    credential_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_contact_at timestamp with time zone,
    approval_attention_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT personal_team_links_approval_attention_count_check CHECK ((approval_attention_count >= 0)),
    CONSTRAINT personal_team_links_state_check CHECK ((state = ANY (ARRAY['joining'::text, 'active'::text, 'unreachable'::text, 'leaving'::text, 'revoked'::text, 'needs_update'::text])))
);


--
-- Name: personal_team_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_team_posts (
    team_deployment_id text NOT NULL,
    client_message_id uuid NOT NULL,
    local_link_id text NOT NULL,
    remote_link_id text NOT NULL,
    run_id text NOT NULL,
    message_id bigint,
    channel_id text NOT NULL,
    thread_root_id bigint,
    target_bindings jsonb NOT NULL,
    mentioned_agent_handles text[] NOT NULL,
    body_markdown text NOT NULL,
    attachment_ids jsonb NOT NULL,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_team_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_team_requests (
    team_deployment_id text NOT NULL,
    request_id text NOT NULL,
    trigger_message_id bigint NOT NULL,
    local_task_id text,
    local_input_id text,
    run_id text,
    publication_state text NOT NULL,
    terminal_state text,
    accepted_message_id bigint,
    explicit_reply boolean DEFAULT false NOT NULL,
    source jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    answer_message_id text,
    answer_payload jsonb,
    client_message_id text,
    delivery_via text,
    blocked_reason text,
    kind text DEFAULT 'self'::text NOT NULL,
    remote_state text DEFAULT 'queued'::text NOT NULL,
    presentation jsonb,
    return_payload jsonb,
    consent_expires_at timestamp with time zone,
    local_decision text,
    decision_at timestamp with time zone,
    return_admission text,
    approved_revision integer,
    released_at timestamp with time zone,
    CONSTRAINT personal_team_requests_approved_revision_check CHECK ((approved_revision >= 0)),
    CONSTRAINT personal_team_requests_ask CHECK ((((kind = 'ask'::text) = ((presentation IS NOT NULL) AND (consent_expires_at IS NOT NULL))) AND ((kind = 'ask'::text) OR ((presentation IS NULL) AND (consent_expires_at IS NULL))))),
    CONSTRAINT personal_team_requests_decision CHECK ((((local_decision IS NULL) = (decision_at IS NULL)) AND ((kind = 'ask'::text) OR (local_decision IS NULL)))),
    CONSTRAINT personal_team_requests_delivery_via_check CHECK ((delivery_via = ANY (ARRAY['final'::text, 'tool'::text]))),
    CONSTRAINT personal_team_requests_input CHECK ((((local_task_id IS NULL) = (local_input_id IS NULL)) AND ((kind <> 'self'::text) OR (local_task_id IS NOT NULL)))),
    CONSTRAINT personal_team_requests_kind_check CHECK ((kind = ANY (ARRAY['self'::text, 'ask'::text, 'return'::text]))),
    CONSTRAINT personal_team_requests_local_decision_check CHECK ((local_decision = ANY (ARRAY['approve'::text, 'decline'::text]))),
    CONSTRAINT personal_team_requests_publication_state_check CHECK ((publication_state = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text]))),
    CONSTRAINT personal_team_requests_release CHECK ((((approved_revision IS NULL) OR ((kind = 'ask'::text) AND (local_decision = 'approve'::text))) AND ((released_at IS NULL) OR (approved_revision IS NOT NULL)))),
    CONSTRAINT personal_team_requests_remote_state_check CHECK ((remote_state = ANY (ARRAY['awaiting_approval'::text, 'declined'::text, 'queued'::text, 'working'::text, 'needs_you'::text, 'done'::text, 'failed'::text, 'cancelled'::text, 'stopped'::text]))),
    CONSTRAINT personal_team_requests_return CHECK ((((kind = 'return'::text) = (return_payload IS NOT NULL)) AND ((kind = 'return'::text) OR (return_admission IS NULL)) AND ((return_admission IS DISTINCT FROM 'admitted'::text) OR (local_input_id IS NOT NULL)) AND ((return_payload IS NULL) OR ((jsonb_typeof(return_payload) = 'object'::text) AND (NULLIF((return_payload ->> 'originAskId'::text), ''::text) IS NOT NULL) AND (NULLIF((return_payload ->> 'resumeRunId'::text), ''::text) IS NOT NULL))))),
    CONSTRAINT personal_team_requests_return_admission_check CHECK ((return_admission = ANY (ARRAY['admitted'::text, 'undeliverable'::text]))),
    CONSTRAINT personal_team_requests_terminal_state_check CHECK ((terminal_state = ANY (ARRAY['done'::text, 'failed'::text, 'stopped'::text, 'cancelled'::text])))
);


--
-- Name: plugin_agent_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_agent_settings (
    owner_user_id text NOT NULL,
    plugin_id text NOT NULL,
    access text DEFAULT 'all'::text NOT NULL,
    author text NOT NULL,
    version_authors jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT plugin_agent_settings_access_check CHECK ((access = ANY (ARRAY['all'::text, 'read-only'::text, 'off'::text]))),
    CONSTRAINT plugin_agent_settings_author_check CHECK ((author = ANY (ARRAY['catalog'::text, 'agent'::text])))
);


--
-- Name: plugin_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_executions (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    occurrence_id text,
    watch_activation_id text,
    caller text NOT NULL,
    mode text NOT NULL,
    state text NOT NULL,
    request_id text,
    interaction_id text,
    handoff boolean DEFAULT false NOT NULL,
    result jsonb,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugin_executions_check CHECK ((num_nonnulls(run_id, occurrence_id, watch_activation_id) = 1)),
    CONSTRAINT plugin_executions_mode_check CHECK ((mode = ANY (ARRAY['ask'::text, 'automatic'::text]))),
    CONSTRAINT plugin_executions_state_check CHECK ((state = ANY (ARRAY['running'::text, 'waiting'::text, 'answered'::text, 'completed'::text, 'cancelled'::text, 'expired'::text, 'interrupted'::text, 'failed'::text])))
);


--
-- Name: plugin_oauth_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_oauth_records (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    expires_at timestamp with time zone,
    begun_at timestamp with time zone,
    encrypted_payload bytea NOT NULL
);


--
-- Name: plugin_owner_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_owner_settings (
    owner_user_id text NOT NULL,
    target_key text NOT NULL,
    target jsonb NOT NULL,
    enabled boolean NOT NULL,
    revision integer NOT NULL
);


--
-- Name: plugin_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_versions (
    id text NOT NULL,
    plugin_id text NOT NULL,
    digest text NOT NULL,
    manifest jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    package_format text
);


--
-- Name: plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugins (
    id text NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    source jsonb NOT NULL,
    installed_by text,
    current_version_id text,
    setup_thread_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugins_scope_check CHECK ((scope = 'deployment'::text))
);


--
-- Name: principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.principals (
    id text NOT NULL,
    kind text NOT NULL,
    user_id text,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'channel-identity'::text, 'system'::text])))
);


--
-- Name: provider_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_sessions (
    personal_context boolean DEFAULT true NOT NULL,
    active boolean NOT NULL,
    state_layout text NOT NULL,
    id text NOT NULL,
    thread_id text NOT NULL,
    harness_instance_id text NOT NULL,
    continuation_identity jsonb,
    provider_session_reference text,
    runner_id text,
    runner_boot_id text,
    binding_generation integer NOT NULL,
    lease_token_hash text,
    lease_expires_at timestamp with time zone,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_snapshot jsonb,
    CONSTRAINT provider_sessions_state_layout_check CHECK ((state_layout = ANY (ARRAY['thread'::text, 'session'::text]))),
    CONSTRAINT provider_sessions_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'ready'::text, 'running'::text, 'stopped'::text, 'broken'::text])))
);


--
-- Name: request_call_joins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_call_joins (
    originating_run_id text NOT NULL,
    call_id text NOT NULL,
    request_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: request_continuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_continuations (
    request_id text NOT NULL,
    status text NOT NULL,
    attempted_at timestamp with time zone,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_continuations_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'queued'::text, 'undeliverable'::text, 'delivered'::text])))
);


--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requests (
    id text NOT NULL,
    kind text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    originating_thread_id text NOT NULL,
    originating_run_id text,
    originating_occurrence_id text,
    originating_node_id text,
    call_id text NOT NULL,
    requested_by text NOT NULL,
    required_actor text NOT NULL,
    presentation jsonb NOT NULL,
    payload jsonb NOT NULL,
    response jsonb,
    response_command_id text,
    cancellation_reason text,
    resolved_at timestamp with time zone,
    resolved_by text,
    settlement_provenance jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    originating_watch_activation_id text,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT requests_origin_check CHECK (((num_nonnulls(originating_run_id, originating_occurrence_id, originating_watch_activation_id) = 1) AND ((mode <> 'live'::text) OR (originating_run_id IS NOT NULL)))),
    CONSTRAINT requests_revision_check CHECK ((revision >= 0))
);


--
-- Name: run_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_attempts (
    id text NOT NULL,
    run_id text NOT NULL,
    ordinal integer NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    superseded_by text,
    binding_generation integer,
    runner_id text,
    runner_boot_id text,
    model_selection jsonb,
    dispatched_at timestamp with time zone,
    engine_start text,
    first_event_at timestamp with time zone,
    ended_at timestamp with time zone,
    outcome text,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    cost_usd numeric(18,8),
    CONSTRAINT run_attempts_engine_start_check CHECK ((engine_start = ANY (ARRAY['cold'::text, 'warm'::text]))),
    CONSTRAINT run_attempts_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'cancelled'::text]))),
    CONSTRAINT run_attempts_reason_check CHECK ((reason = ANY (ARRAY['initial'::text, 'steer_restart'::text, 'recovery'::text]))),
    CONSTRAINT run_attempts_status_check CHECK ((status = ANY (ARRAY['current'::text, 'superseded'::text])))
);


--
-- Name: runner_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_enrollments (
    issuance_modules jsonb,
    device_profile text,
    id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    allowed_modules jsonb NOT NULL,
    created_by text,
    owner_kind text NOT NULL,
    owner_user_id text,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    runner_kind text NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    runner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    initial_access jsonb,
    prepared_identity jsonb,
    CONSTRAINT runner_enrollments_device_profile_check CHECK ((device_profile = 'iphone'::text)),
    CONSTRAINT runner_enrollments_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['deployment'::text, 'user'::text]))),
    CONSTRAINT runner_enrollments_runner_kind_check CHECK ((runner_kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text])))
);


--
-- Name: runner_event_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_event_receipts (
    run_id text NOT NULL,
    ordinal bigint NOT NULL,
    runner_id text NOT NULL,
    runner_boot_id text NOT NULL,
    binding_generation integer NOT NULL,
    reported_digest bytea NOT NULL,
    disposition text NOT NULL,
    committed_head bigint NOT NULL,
    CONSTRAINT runner_event_receipts_binding_generation_check CHECK ((binding_generation > 0)),
    CONSTRAINT runner_event_receipts_committed_head_check CHECK ((committed_head >= 0)),
    CONSTRAINT runner_event_receipts_disposition_check CHECK ((disposition = ANY (ARRAY['applied'::text, 'absorbed'::text, 'terminal-noop'::text]))),
    CONSTRAINT runner_event_receipts_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT runner_event_receipts_reported_digest_check CHECK ((octet_length(reported_digest) = 32))
);


--
-- Name: runner_plugin_data_removals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_plugin_data_removals (
    runner_id text NOT NULL,
    plugin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runners (
    device_profile text,
    id text NOT NULL,
    owner_kind text NOT NULL,
    owner_user_id text,
    name text NOT NULL,
    update_required text,
    kind text NOT NULL,
    public_key_pem text NOT NULL,
    public_key_fingerprint text NOT NULL,
    enrollment_token_hash text NOT NULL,
    capabilities jsonb NOT NULL,
    allowed_modules jsonb NOT NULL,
    module_descriptors jsonb NOT NULL,
    access_policy jsonb DEFAULT '{"apps": false, "reach": "nobody", "shares": [], "browser": false, "commands": false, "forwarding": false}'::jsonb NOT NULL,
    access_policy_revision integer DEFAULT 1 NOT NULL,
    device jsonb,
    connection_generation bigint NOT NULL,
    max_concurrent_runs integer,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runners_device_profile_check CHECK ((device_profile = 'iphone'::text)),
    CONSTRAINT runners_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text]))),
    CONSTRAINT runners_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['deployment'::text, 'user'::text]))),
    CONSTRAINT runners_update_required_check CHECK ((update_required = ANY (ARRAY['agent-phone-outdated'::text, 'runner-outdated'::text])))
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    person_waited boolean DEFAULT false NOT NULL,
    done_when_finished boolean DEFAULT false NOT NULL,
    assignment_id text,
    initial_context jsonb,
    provider_session_id text,
    report_context jsonb,
    access_mode text NOT NULL,
    activation_input_id text NOT NULL,
    causal_chain_id text NOT NULL,
    id text NOT NULL,
    thread_id text NOT NULL,
    environment_id text NOT NULL,
    failure jsonb,
    harness_instance_id text NOT NULL,
    model_selection jsonb NOT NULL,
    reply_target jsonb,
    requested_by text NOT NULL,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    run_ordinal integer NOT NULL,
    seed_input_id text NOT NULL,
    voice_session_id text,
    next_runner_ordinal integer DEFAULT 0 NOT NULL,
    binding_generation integer,
    phase text DEFAULT 'turn'::text NOT NULL,
    background_deadline_at timestamp with time zone,
    turn_reply_message_id text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    cost_usd numeric(18,8),
    maintenance jsonb,
    revision bigint DEFAULT 0 NOT NULL,
    latest_place jsonb,
    terminal_reply_message_id text,
    runner_safety_terminal boolean DEFAULT false NOT NULL,
    execute_claim_state text DEFAULT 'not-created'::text NOT NULL,
    last_runner_digest bytea,
    finish_intent jsonb,
    provider_retry jsonb,
    CONSTRAINT runs_check CHECK (((terminal_reply_message_id IS NULL) OR (status = 'completed'::text))),
    CONSTRAINT runs_cost_usd_check CHECK (((cost_usd IS NULL) OR (cost_usd >= (0)::numeric))),
    CONSTRAINT runs_execute_claim_state_check CHECK ((execute_claim_state = ANY (ARRAY['not-created'::text, 'unclaimed'::text, 'claimed'::text]))),
    CONSTRAINT runs_finish_intent_check CHECK (((jsonb_typeof(finish_intent) = 'object'::text) AND (octet_length((finish_intent)::text) <= 8192))),
    CONSTRAINT runs_last_runner_digest_check CHECK ((octet_length(last_runner_digest) = 32)),
    CONSTRAINT runs_latest_place_check CHECK (public.opensteer_valid_place(latest_place)),
    CONSTRAINT runs_phase_check CHECK ((phase = ANY (ARRAY['turn'::text, 'background'::text]))),
    CONSTRAINT runs_revision_check CHECK ((revision >= 0)),
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text, 'completed'::text, 'failed'::text, 'interrupted'::text]))),
    CONSTRAINT runs_usage_tokens_check CHECK ((((input_tokens IS NULL) = (output_tokens IS NULL)) AND ((input_tokens IS NOT NULL) OR ((cached_input_tokens IS NULL) AND (cache_write_tokens IS NULL) AND (reasoning_tokens IS NULL) AND (cost_usd IS NULL))) AND ((input_tokens IS NULL) OR ((input_tokens >= 0) AND (input_tokens <= '9007199254740991'::bigint))) AND ((output_tokens IS NULL) OR ((output_tokens >= 0) AND (output_tokens <= '9007199254740991'::bigint))) AND ((cached_input_tokens IS NULL) OR ((cached_input_tokens >= 0) AND (cached_input_tokens <= '9007199254740991'::bigint))) AND ((cache_write_tokens IS NULL) OR ((cache_write_tokens >= 0) AND (cache_write_tokens <= '9007199254740991'::bigint))) AND ((reasoning_tokens IS NULL) OR ((reasoning_tokens >= 0) AND (reasoning_tokens <= '9007199254740991'::bigint)))))
);


--
-- Name: security_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_audit (
    id text NOT NULL,
    actor_user_id text,
    actor_session_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    request_id text,
    metadata jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tab_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tab_layouts (
    owner_id text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT tab_layouts_items_check CHECK ((jsonb_typeof(items) = 'array'::text)),
    CONSTRAINT tab_layouts_revision_check CHECK ((revision >= 0))
);


--
-- Name: task_question_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_question_notices (
    request_id text NOT NULL,
    message_id text
);


--
-- Name: team_access_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_access_changes (
    revision bigint NOT NULL,
    effects jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_access_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_access_state (
    singleton_key text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    directory_revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_access_state_check CHECK (((singleton_key = 'team'::text) AND (revision >= 0) AND (directory_revision >= 0))),
    CONSTRAINT team_access_state_singleton_key_check CHECK ((singleton_key = 'team'::text))
);


--
-- Name: team_agent_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_agent_recipients (
    user_id text NOT NULL,
    channel_id text NOT NULL,
    root_id bigint NOT NULL,
    enabled boolean NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_agent_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_agent_requests (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    thread_root_id bigint NOT NULL,
    trigger_message_id bigint NOT NULL,
    link_id text NOT NULL,
    state text NOT NULL,
    steps jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    expires_at timestamp with time zone,
    finished_at timestamp with time zone,
    reply_message_id bigint,
    failure_code text,
    change_seq bigint NOT NULL,
    kind text DEFAULT 'self'::text NOT NULL,
    target_agent_handle text,
    presentation jsonb,
    return_payload jsonb,
    consent_expires_at timestamp with time zone,
    share_id uuid,
    CONSTRAINT team_agent_requests_ask CHECK ((((kind = 'ask'::text) = ((presentation IS NOT NULL) AND (consent_expires_at IS NOT NULL))) AND ((kind = 'ask'::text) OR ((presentation IS NULL) AND (consent_expires_at IS NULL))) AND ((kind = 'ask'::text) OR (state <> ALL (ARRAY['awaiting_approval'::text, 'declined'::text]))))),
    CONSTRAINT team_agent_requests_check1 CHECK ((((accepted_at IS NULL) AND (expires_at IS NULL)) OR ((accepted_at IS NOT NULL) AND (expires_at = (accepted_at + '7 days'::interval))))),
    CONSTRAINT team_agent_requests_kind_check CHECK ((kind = ANY (ARRAY['self'::text, 'ask'::text, 'return'::text]))),
    CONSTRAINT team_agent_requests_return CHECK ((((kind = 'return'::text) = (return_payload IS NOT NULL)) AND ((return_payload IS NULL) OR ((jsonb_typeof(return_payload) = 'object'::text) AND (NULLIF((return_payload ->> 'originAskId'::text), ''::text) IS NOT NULL) AND (NULLIF((return_payload ->> 'resumeRunId'::text), ''::text) IS NOT NULL))))),
    CONSTRAINT team_agent_requests_state CHECK (((state = ANY (ARRAY['awaiting_approval'::text, 'declined'::text, 'queued'::text, 'working'::text, 'needs_you'::text, 'done'::text, 'failed'::text, 'cancelled'::text, 'stopped'::text])) AND (change_seq > 0))),
    CONSTRAINT team_agent_requests_steps_check CHECK (((jsonb_typeof(steps) = 'array'::text) AND (jsonb_array_length(steps) <= 8))),
    CONSTRAINT team_agent_requests_terminal CHECK (((state = ANY (ARRAY['declined'::text, 'done'::text, 'failed'::text, 'cancelled'::text, 'stopped'::text])) = (finished_at IS NOT NULL)))
);


--
-- Name: team_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_audit (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_user_id text,
    actor_kind text NOT NULL,
    link_id text,
    agent_request_id text,
    action text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text,
    channel_id text,
    outcome text NOT NULL,
    metadata jsonb NOT NULL,
    caller_run_id text,
    operation_id text,
    CONSTRAINT team_audit_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['human'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT team_audit_outcome_check CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text])))
);


--
-- Name: team_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.team_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.team_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: team_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_blobs (
    id text NOT NULL,
    channel_id text NOT NULL,
    uploader_user_id text NOT NULL,
    uploader_kind text NOT NULL,
    agent_request_id text,
    client_upload_id text NOT NULL,
    storage_key text NOT NULL,
    filename text NOT NULL,
    declared_type text NOT NULL,
    verified_type text,
    size_bytes bigint NOT NULL,
    sha256 text,
    state text NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    preview_storage_key text,
    preview_media_type text,
    preview_size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    agent_link_id text,
    personal_deployment_id text,
    caller_run_id text,
    operation_id text,
    public_id uuid DEFAULT gen_random_uuid() NOT NULL,
    remote_share_id uuid,
    preview_sha256 text,
    cache_original_reserved boolean DEFAULT false NOT NULL,
    cache_preview_reserved boolean DEFAULT false NOT NULL,
    generation bigint,
    preview_generation bigint,
    upload_lease text,
    upload_lease_expires_at timestamp with time zone,
    CONSTRAINT team_blobs_check CHECK ((((size_bytes >= 1) AND (size_bytes <= 104857600)) AND ((received_bytes >= 0) AND (received_bytes <= size_bytes)))),
    CONSTRAINT team_blobs_check1 CHECK ((((preview_storage_key IS NULL) AND (preview_media_type IS NULL) AND (preview_size_bytes IS NULL)) OR ((preview_storage_key IS NOT NULL) AND (preview_media_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])) AND ((preview_size_bytes >= 1) AND (preview_size_bytes <= 65536))))),
    CONSTRAINT team_blobs_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'ready'::text, 'deleting'::text]))),
    CONSTRAINT team_blobs_upload_lease CHECK (((upload_lease IS NULL) = (upload_lease_expires_at IS NULL))),
    CONSTRAINT team_blobs_uploader_kind_check CHECK ((uploader_kind = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: team_channel_member_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_channel_member_state (
    channel_id text NOT NULL,
    user_id text NOT NULL,
    last_read_message_id bigint,
    notification_level text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_channel_member_state_notification_level_check CHECK ((notification_level = ANY (ARRAY['mentions'::text, 'all'::text, 'muted'::text])))
);


--
-- Name: team_channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_channel_members (
    channel_id text NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    level text NOT NULL,
    manage boolean NOT NULL,
    added_by text NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    member_user_id text GENERATED ALWAYS AS (
CASE
    WHEN (subject_kind = 'person'::text) THEN subject_id
    ELSE NULL::text
END) STORED,
    CONSTRAINT team_channel_members_level_check CHECK ((level = ANY (ARRAY['read'::text, 'post'::text]))),
    CONSTRAINT team_channel_members_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['person'::text, 'group'::text])))
);


--
-- Name: team_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_channels (
    id text NOT NULL,
    kind text NOT NULL,
    name text,
    normalized_name text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    people_only boolean NOT NULL,
    instructions_markdown text NOT NULL,
    instructions_revision bigint DEFAULT 0 NOT NULL,
    change_seq bigint DEFAULT 0 NOT NULL,
    latest_message_id bigint,
    dm_key text,
    CONSTRAINT team_channels_check CHECK (((change_seq >= 0) AND (instructions_revision >= 0) AND (octet_length(instructions_markdown) <= 16384))),
    CONSTRAINT team_channels_check1 CHECK ((((kind = ANY (ARRAY['public'::text, 'private'::text])) AND (name IS NOT NULL) AND (normalized_name IS NOT NULL) AND (dm_key IS NULL)) OR ((kind = ANY (ARRAY['dm'::text, 'group_dm'::text])) AND (dm_key IS NOT NULL))))
);


--
-- Name: team_group_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_group_edges (
    parent_group_id text NOT NULL,
    child_group_id text NOT NULL,
    added_by text NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_group_edges_check CHECK ((parent_group_id <> child_group_id))
);


--
-- Name: team_group_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_group_people (
    group_id text NOT NULL,
    user_id text NOT NULL,
    added_by text NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_groups (
    id text NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: team_installation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_installation (
    singleton_key text NOT NULL,
    sealed_account_bundle bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_installation_singleton_key_check CHECK ((singleton_key = 'team'::text))
);


--
-- Name: team_invite_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invite_uses (
    invite_id text NOT NULL,
    user_id text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    member_generation bigint NOT NULL
);


--
-- Name: team_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invites (
    id text NOT NULL,
    selector text NOT NULL,
    verifier_hash text NOT NULL,
    max_uses integer,
    used_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sealed_verifier bytea,
    CONSTRAINT team_invites_uses CHECK ((((max_uses IS NULL) OR ((max_uses >= 1) AND (max_uses <= 1000))) AND (used_count >= 0) AND ((max_uses IS NULL) OR (used_count <= max_uses))))
);


--
-- Name: team_link_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_link_connections (
    link_id text NOT NULL,
    epoch bigint NOT NULL,
    process_id text NOT NULL,
    seen_at timestamp with time zone NOT NULL
);


--
-- Name: team_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_links (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    personal_deployment_id text,
    installation_label text,
    state text NOT NULL,
    code_hash text NOT NULL,
    code_expires_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_hash text,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    connection_epoch bigint DEFAULT 0 NOT NULL,
    CONSTRAINT team_links_check CHECK (((state <> 'active'::text) OR ((personal_deployment_id IS NOT NULL) AND (credential_hash IS NOT NULL)))),
    CONSTRAINT team_links_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text])))
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    user_id text NOT NULL,
    handle text NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by text,
    CONSTRAINT team_members_check CHECK (((generation >= 1) AND (length(handle) <= 48) AND (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (handle !~ '-agent$'::text))),
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT team_members_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text])))
);


--
-- Name: team_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_mentions (
    message_id bigint NOT NULL,
    channel_id text NOT NULL,
    target_user_id text NOT NULL,
    target_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_mentions_target_kind_check CHECK ((target_kind = ANY (ARRAY['person'::text, 'agent'::text])))
);


--
-- Name: team_message_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_message_attachments (
    message_id bigint NOT NULL,
    "position" integer NOT NULL,
    blob_id text NOT NULL,
    channel_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_message_attachments_position_check CHECK ((("position" >= 0) AND ("position" <= 9)))
);


--
-- Name: team_message_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_message_pins (
    message_id bigint NOT NULL,
    channel_id text NOT NULL,
    pinned_by text NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_messages (
    id bigint NOT NULL,
    channel_id text NOT NULL,
    thread_root_id bigint,
    author_user_id text NOT NULL,
    author_kind text NOT NULL,
    agent_request_id text,
    client_message_id text NOT NULL,
    body_markdown text NOT NULL,
    plain_text text NOT NULL,
    search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, plain_text)) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    change_seq bigint NOT NULL,
    agent_link_id text,
    personal_deployment_id text,
    caller_run_id text,
    operation_id text,
    public_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_seq bigint DEFAULT 0 NOT NULL,
    owner_change_seq bigint,
    CONSTRAINT team_messages_agent_author CHECK (((author_kind = 'agent'::text) OR (agent_request_id IS NULL))),
    CONSTRAINT team_messages_author_kind_check CHECK ((author_kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT team_messages_check CHECK (((id > 0) AND (change_seq > 0) AND (thread_root_id IS DISTINCT FROM id) AND (octet_length(body_markdown) <= 16384)))
);


--
-- Name: team_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.team_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.team_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: team_note_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_note_versions (
    note_id text NOT NULL,
    version integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    deleted boolean NOT NULL,
    writer_kind text NOT NULL,
    writer_user_id text NOT NULL,
    link_id text,
    request_id text,
    written_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT team_note_versions_body_check CHECK ((octet_length(body) <= 65536)),
    CONSTRAINT team_note_versions_check CHECK (((writer_kind = 'agent'::text) OR ((link_id IS NULL) AND (request_id IS NULL)))),
    CONSTRAINT team_note_versions_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT team_note_versions_version_check CHECK ((version >= 1)),
    CONSTRAINT team_note_versions_writer_kind_check CHECK ((writer_kind = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: team_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_notes (
    id text NOT NULL,
    topic_id text NOT NULL,
    version integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    search tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('simple'::regconfig, title), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, body), 'B'::"char"))) STORED NOT NULL,
    CONSTRAINT team_notes_body_check CHECK ((octet_length(body) <= 65536)),
    CONSTRAINT team_notes_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT team_notes_version_check CHECK ((version >= 1))
);


--
-- Name: team_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_notices (
    id text NOT NULL,
    recipient_user_id text NOT NULL,
    kind text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    audit_id bigint NOT NULL,
    dedupe_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT team_notices_kind_check CHECK ((kind = 'admin-self-added'::text)),
    CONSTRAINT team_notices_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['channel'::text, 'topic'::text])))
);


--
-- Name: team_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_outbox (
    id bigint NOT NULL,
    kind text NOT NULL,
    channel_id text,
    message_id bigint,
    notice_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_outbox_kind_check CHECK ((kind = ANY (ARRAY['message'::text, 'agent-status'::text, 'notice'::text])))
);


--
-- Name: team_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.team_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.team_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: team_partner_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_partner_calls (
    id uuid NOT NULL,
    link_id uuid NOT NULL,
    operation jsonb NOT NULL,
    state text NOT NULL,
    claimed_by text,
    result jsonb,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT team_partner_calls_check CHECK (((state = 'queued'::text) = (claimed_by IS NULL))),
    CONSTRAINT team_partner_calls_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'claimed'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: team_partner_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_partner_invites (
    id uuid NOT NULL,
    verifier_hash text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: team_partner_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_partner_links (
    id uuid NOT NULL,
    partner_team_id text NOT NULL,
    partner_origin text NOT NULL,
    partner_host_key_fingerprint text NOT NULL,
    partner_host_instance_id text NOT NULL,
    partner_authority jsonb NOT NULL,
    partner_name text NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    local_approved boolean NOT NULL,
    partner_approved boolean NOT NULL,
    created_by text NOT NULL,
    approved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    last_error text,
    revoked_at timestamp with time zone,
    revoked_by text,
    sealed_offer bytea,
    CONSTRAINT team_partner_links_check CHECK (((state <> 'active'::text) OR (local_approved AND partner_approved))),
    CONSTRAINT team_partner_links_check1 CHECK (((state = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT team_partner_links_last_error_check CHECK ((last_error = ANY (ARRAY['identity-mismatch'::text, 'unsupported-partner-version'::text, 'unreachable'::text]))),
    CONSTRAINT team_partner_links_revoked_by_check CHECK ((revoked_by = ANY (ARRAY['local'::text, 'partner'::text]))),
    CONSTRAINT team_partner_links_role_check CHECK ((role = ANY (ARRAY['dialer'::text, 'listener'::text]))),
    CONSTRAINT team_partner_links_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text])))
);


--
-- Name: team_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_presence (
    connection_id text NOT NULL,
    process_id text NOT NULL,
    user_id text NOT NULL,
    visible boolean NOT NULL,
    channel_ids text[] DEFAULT '{}'::text[] NOT NULL,
    seen_at timestamp with time zone NOT NULL
);


--
-- Name: team_principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_principals (
    id text NOT NULL,
    home_team_id text NOT NULL,
    home_user_id text NOT NULL,
    member_user_id text,
    display_name text,
    handle text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_principals_identity CHECK ((((member_user_id IS NOT NULL) AND (id = member_user_id) AND (home_user_id = member_user_id) AND (display_name IS NULL) AND (handle IS NULL)) OR ((member_user_id IS NULL) AND (display_name IS NOT NULL) AND (handle IS NOT NULL))))
);


--
-- Name: team_share_asks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_share_asks (
    id text NOT NULL,
    share_id uuid NOT NULL,
    channel_id text NOT NULL,
    trigger_message_id bigint NOT NULL,
    thread_root_id bigint NOT NULL,
    target_principal_id text NOT NULL,
    target_agent_handle text NOT NULL,
    local_request_id text,
    status jsonb,
    outcome text,
    reply_message_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    change_seq bigint NOT NULL,
    CONSTRAINT team_share_asks_outcome_check CHECK ((outcome = ANY (ARRAY['answered'::text, 'declined'::text, 'expired'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: team_request_statuses; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.team_request_statuses AS
 SELECT r.target_agent_handle,
    r.kind,
    r.presentation,
    r.return_payload,
    r.consent_expires_at,
    r.id,
    r.owner_user_id,
    r.channel_id,
    r.thread_root_id,
    r.trigger_message_id,
    r.link_id,
    r.state,
    r.steps,
    r.created_at,
    r.accepted_at,
    r.expires_at,
    r.finished_at,
    r.reply_message_id,
    r.failure_code,
    r.change_seq,
    r.share_id,
    false AS pending_remote,
    NULL::text AS ask_refusal
   FROM public.team_agent_requests r
  WHERE (r.kind <> 'return'::text)
UNION ALL
 SELECT a.target_agent_handle,
    'ask'::text AS kind,
    NULL::jsonb AS presentation,
    NULL::jsonb AS return_payload,
    ((a.status ->> 'consentExpiresAt'::text))::timestamp with time zone AS consent_expires_at,
    a.id,
    a.target_principal_id AS owner_user_id,
    a.channel_id,
    a.thread_root_id,
    a.trigger_message_id,
    NULL::text AS link_id,
    COALESCE((a.status ->> 'state'::text), 'queued'::text) AS state,
    '[]'::jsonb AS steps,
    a.created_at,
    ((a.status ->> 'acceptedAt'::text))::timestamp with time zone AS accepted_at,
    ((a.status ->> 'expiresAt'::text))::timestamp with time zone AS expires_at,
    ((a.status ->> 'finishedAt'::text))::timestamp with time zone AS finished_at,
    a.reply_message_id,
    (a.status ->> 'failureCode'::text) AS failure_code,
    a.change_seq,
    a.share_id,
    (a.status IS NULL) AS pending_remote,
    (a.status ->> 'refusal'::text) AS ask_refusal
   FROM public.team_share_asks a
  WHERE (a.local_request_id IS NULL);


--
-- Name: team_share_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_share_participants (
    share_id uuid NOT NULL,
    principal_id text NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    handle text NOT NULL,
    level text NOT NULL,
    state text NOT NULL,
    CONSTRAINT team_share_participants_level_check CHECK ((level = ANY (ARRAY['read'::text, 'post'::text]))),
    CONSTRAINT team_share_participants_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text])))
);


--
-- Name: team_share_relays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_share_relays (
    share_id uuid NOT NULL,
    author_user_id text NOT NULL,
    author_kind text NOT NULL,
    agent_link_id text,
    personal_deployment_id text,
    caller_run_id text,
    client_message_id uuid NOT NULL,
    body_markdown text NOT NULL,
    thread_root_public_id uuid,
    public_id uuid,
    attachment_public_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    agent_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    publication boolean DEFAULT false NOT NULL,
    admitted boolean DEFAULT false NOT NULL,
    pending_bodies text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT team_share_relays_author_kind_check CHECK ((author_kind = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: team_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_shares (
    id uuid NOT NULL,
    channel_id text,
    history_from_share_id uuid,
    partner_link_id uuid NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    name text NOT NULL,
    people_only boolean NOT NULL,
    offered_by text,
    accepted_by text,
    local_approved boolean NOT NULL,
    cursor bigint DEFAULT 0 NOT NULL,
    creation_cursor bigint DEFAULT 0 NOT NULL,
    cursor_public_id text DEFAULT ''::text NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    sync_error text,
    stored_rows integer DEFAULT 0 NOT NULL,
    stored_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    agents_enabled boolean DEFAULT true NOT NULL,
    policy_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT team_shares_generation_check CHECK ((generation > 0)),
    CONSTRAINT team_shares_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'follower'::text]))),
    CONSTRAINT team_shares_state_check CHECK ((state = ANY (ARRAY['offered'::text, 'active'::text, 'ended'::text]))),
    CONSTRAINT team_shares_sync_error_check CHECK ((sync_error = 'update-required'::text))
);


--
-- Name: team_sharing_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_sharing_settings (
    singleton_key text NOT NULL,
    policy text DEFAULT 'admins'::text NOT NULL,
    CONSTRAINT team_sharing_settings_policy_check CHECK ((policy = ANY (ARRAY['off'::text, 'admins'::text, 'members-propose'::text, 'members'::text]))),
    CONSTRAINT team_sharing_settings_singleton_key_check CHECK ((singleton_key = 'team'::text))
);


--
-- Name: team_topic_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_topic_grants (
    topic_id text NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    level text NOT NULL,
    added_by text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    member_user_id text GENERATED ALWAYS AS (
CASE
    WHEN (subject_kind = 'person'::text) THEN subject_id
    ELSE NULL::text
END) STORED,
    CONSTRAINT team_topic_grants_check CHECK (((subject_kind <> 'everyone'::text) OR ((subject_id = 'team'::text) AND (level <> 'manage'::text)))),
    CONSTRAINT team_topic_grants_level_check CHECK ((level = ANY (ARRAY['read'::text, 'write'::text, 'manage'::text]))),
    CONSTRAINT team_topic_grants_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['person'::text, 'group'::text, 'everyone'::text])))
);


--
-- Name: team_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_topics (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    access_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT team_topics_access_revision_check CHECK ((access_revision >= 0)),
    CONSTRAINT team_topics_description_check CHECK ((char_length(description) <= 500)),
    CONSTRAINT team_topics_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160)))
);


--
-- Name: thread_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_inputs (
    team_request_id text,
    team_source jsonb,
    assignment_id text,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    cancel_reason text,
    causal_chain_id text NOT NULL,
    delivered_at timestamp with time zone,
    idempotency_key text NOT NULL,
    message_id text NOT NULL,
    policy text NOT NULL,
    queue_rank bigint NOT NULL,
    reply_target jsonb,
    request_fingerprint text NOT NULL,
    requested_by text NOT NULL,
    run_id text,
    state text NOT NULL,
    steer_command_id text,
    thread_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fresh_context boolean DEFAULT false NOT NULL,
    edit_lease_id text,
    edit_lease_session_id text,
    edit_lease_device_label text,
    edit_lease_expires_at timestamp with time zone,
    approval_sort smallint GENERATED ALWAYS AS (
CASE
    WHEN (state = 'awaiting-approval'::text) THEN 1
    ELSE 0
END) STORED,
    CONSTRAINT thread_inputs_check CHECK (((team_request_id IS NULL) OR ((policy = 'queue'::text) AND (team_source IS NOT NULL)))),
    CONSTRAINT thread_inputs_edit_lease CHECK ((((edit_lease_id IS NULL) = (edit_lease_expires_at IS NULL)) AND ((edit_lease_id IS NULL) = (edit_lease_device_label IS NULL)) AND ((edit_lease_id IS NULL) = (edit_lease_session_id IS NULL))))
);


--
-- Name: thread_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_visits (
    thread_id text NOT NULL,
    user_id text NOT NULL,
    last_visited_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: thread_work_inputs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.thread_work_inputs AS
 SELECT team_request_id,
    team_source,
    assignment_id,
    actor_principal_id,
    authority_source,
    cancel_reason,
    causal_chain_id,
    delivered_at,
    idempotency_key,
    message_id,
    policy,
    queue_rank,
    reply_target,
    request_fingerprint,
    requested_by,
    run_id,
    state,
    steer_command_id,
    thread_id,
    created_at,
    updated_at,
    fresh_context,
    edit_lease_id,
    edit_lease_session_id,
    edit_lease_device_label,
    edit_lease_expires_at
   FROM public.thread_inputs
  WHERE (policy = ANY (ARRAY['queue'::text, 'steer'::text]));


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone,
    done_reason text,
    pending_request_count integer DEFAULT 0 NOT NULL,
    input_queue_paused boolean DEFAULT false NOT NULL,
    input_queue_paused_by text,
    access_mode text DEFAULT 'full-access'::text NOT NULL,
    purpose text NOT NULL,
    team_id text,
    channel_id text,
    thread_root_id bigint,
    id text NOT NULL,
    lineage_root_thread_id text NOT NULL,
    parent_thread_id text,
    listed boolean NOT NULL,
    title text NOT NULL,
    title_source text DEFAULT 'provisional'::text NOT NULL,
    icon text,
    icon_source text NOT NULL,
    color text NOT NULL,
    environment_id text NOT NULL,
    harness_instance_id text NOT NULL,
    model_selection jsonb NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    created_by text NOT NULL,
    created_by_principal_id text NOT NULL,
    next_message_sequence bigint DEFAULT 0 NOT NULL,
    next_run_ordinal integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    team_ask_origin boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    next_transcript_position bigint DEFAULT 0 NOT NULL,
    input_queue_revision bigint DEFAULT 0 NOT NULL,
    last_reply_message_id text,
    last_reply_preview text,
    failure_preview text,
    latest_run_completed_at timestamp with time zone,
    latest_place jsonb,
    removed_at timestamp with time zone,
    done_by text,
    CONSTRAINT threads_check CHECK ((((team_id IS NULL) AND (channel_id IS NULL) AND (thread_root_id IS NULL)) OR ((team_id IS NOT NULL) AND (channel_id IS NOT NULL) AND (thread_root_id IS NOT NULL) AND (purpose = 'task'::text)))),
    CONSTRAINT threads_failure_preview_check CHECK ((octet_length(failure_preview) <= 1120)),
    CONSTRAINT threads_input_queue_revision_check CHECK ((input_queue_revision >= 0)),
    CONSTRAINT threads_last_reply_preview_check CHECK ((octet_length(last_reply_preview) <= 1120)),
    CONSTRAINT threads_latest_place_check CHECK (public.opensteer_valid_place(latest_place)),
    CONSTRAINT threads_next_transcript_position_check CHECK ((next_transcript_position >= 0)),
    CONSTRAINT threads_purpose_check CHECK ((purpose = ANY (ARRAY['task'::text, 'voice'::text, 'background-job'::text]))),
    CONSTRAINT threads_revision_check CHECK ((revision >= 0)),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'waiting'::text, 'failed'::text, 'archived'::text])))
);


--
-- Name: tool_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_calls (
    id text NOT NULL,
    thread_id text NOT NULL,
    run_id text NOT NULL,
    attempt_id text,
    binding_generation integer,
    node_id text,
    call_id text NOT NULL,
    origin text NOT NULL,
    tool jsonb,
    integration jsonb,
    arguments jsonb,
    argument_digest bytea,
    provisional boolean DEFAULT false NOT NULL,
    status text NOT NULL,
    output jsonb,
    is_error boolean,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    completion_order bigint,
    CONSTRAINT tool_calls_binding_generation_check CHECK ((binding_generation >= 0)),
    CONSTRAINT tool_calls_call_id_check CHECK ((length(call_id) > 0)),
    CONSTRAINT tool_calls_check CHECK (((argument_digest IS NULL) OR ((octet_length(argument_digest) = 32) AND (origin <> 'runner'::text)))),
    CONSTRAINT tool_calls_check1 CHECK (((NOT provisional) OR ((origin = 'runner'::text) AND (started_at IS NOT NULL)))),
    CONSTRAINT tool_calls_completion_order_check CHECK ((completion_order > 0)),
    CONSTRAINT tool_calls_integration_check CHECK ((jsonb_typeof(integration) = 'object'::text)),
    CONSTRAINT tool_calls_node_attempt CHECK (((node_id IS NULL) OR (attempt_id IS NOT NULL))),
    CONSTRAINT tool_calls_origin_check CHECK ((origin = ANY (ARRAY['runner'::text, 'host-harness'::text, 'host-computer'::text]))),
    CONSTRAINT tool_calls_outcome CHECK ((((status = 'open'::text) AND (started_at IS NOT NULL) AND (num_nonnulls(output, is_error, completed_at, completion_order) = 0)) OR ((status = 'completed'::text) AND (num_nonnulls(output, is_error, completed_at, completion_order) = 4)) OR ((status = 'interrupted'::text) AND (started_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (num_nonnulls(output, is_error, completion_order) = 0)))),
    CONSTRAINT tool_calls_output_check CHECK (((jsonb_typeof(output) = 'object'::text) AND (octet_length((output)::text) <= 360448))),
    CONSTRAINT tool_calls_runner_binding CHECK (((origin <> 'runner'::text) OR ((attempt_id IS NOT NULL) AND (binding_generation IS NOT NULL)))),
    CONSTRAINT tool_calls_start CHECK ((((started_at IS NULL) = (tool IS NULL)) AND ((started_at IS NULL) = (arguments IS NULL)))),
    CONSTRAINT tool_calls_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'interrupted'::text]))),
    CONSTRAINT tool_calls_tool_check CHECK ((jsonb_typeof(tool) = 'object'::text))
);


--
-- Name: tool_output_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_output_images (
    id text NOT NULL,
    tool_call_id text NOT NULL,
    image_index smallint NOT NULL,
    thread_id text NOT NULL,
    node_id text,
    path text NOT NULL,
    path_hash bytea NOT NULL,
    media_type text NOT NULL,
    generated boolean NOT NULL,
    completion_order bigint NOT NULL,
    CONSTRAINT tool_output_images_completion_order_check CHECK ((completion_order > 0)),
    CONSTRAINT tool_output_images_image_index_check CHECK (((image_index >= 0) AND (image_index <= 7))),
    CONSTRAINT tool_output_images_media_type_check CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/gif'::text, 'image/avif'::text, 'image/svg+xml'::text]))),
    CONSTRAINT tool_output_images_path_check CHECK (((length(path) >= 1) AND (length(path) <= 1024))),
    CONSTRAINT tool_output_images_path_hash_check CHECK ((octet_length(path_hash) = 32))
);


--
-- Name: transcript_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_items (
    id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    attempt_id text,
    node_id text,
    kind text NOT NULL,
    "position" bigint,
    revision bigint DEFAULT 0 NOT NULL,
    visible boolean NOT NULL,
    is_turn_start boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    message_id text,
    tool_call_id text,
    request_id text,
    execution_node_id text,
    delegation_id text,
    app_id text,
    binding_generation integer,
    block_id text,
    body jsonb,
    view jsonb NOT NULL,
    refs jsonb,
    CONSTRAINT transcript_items_binding_generation_check CHECK ((binding_generation >= 0)),
    CONSTRAINT transcript_items_check CHECK (((NOT visible) OR ("position" IS NOT NULL))),
    CONSTRAINT transcript_items_check1 CHECK (((NOT is_turn_start) OR (visible AND (kind = 'message'::text) AND (node_id IS NULL)))),
    CONSTRAINT transcript_items_check2 CHECK (((refs IS NULL) OR ((kind = 'message'::text) AND (jsonb_typeof(refs) = 'object'::text) AND (octet_length((refs)::text) <= 5120)))),
    CONSTRAINT transcript_items_check3 CHECK (((attempt_id IS NULL) OR (run_id IS NOT NULL))),
    CONSTRAINT transcript_items_check4 CHECK (((node_id IS NULL) OR (attempt_id IS NOT NULL))),
    CONSTRAINT transcript_items_check5 CHECK (((kind = 'reasoning'::text) = (block_id IS NOT NULL))),
    CONSTRAINT transcript_items_check6 CHECK ((num_nonnulls(message_id, tool_call_id, request_id, execution_node_id, delegation_id, app_id, body) =
CASE
    WHEN (kind = 'run'::text) THEN 0
    ELSE 1
END)),
    CONSTRAINT transcript_items_check7 CHECK (
CASE kind
    WHEN 'message'::text THEN ((id = message_id) AND (message_id IS NOT NULL) AND (node_id IS NULL))
    WHEN 'tool'::text THEN ((id = ('tool:'::text || tool_call_id)) AND (tool_call_id IS NOT NULL) AND (run_id IS NOT NULL))
    WHEN 'run'::text THEN ((id = ('run:'::text || run_id)) AND (run_id IS NOT NULL) AND (node_id IS NULL))
    WHEN 'request'::text THEN ((id = ('request:'::text || request_id)) AND (request_id IS NOT NULL))
    WHEN 'node'::text THEN ((id = ('node:'::text || execution_node_id)) AND (execution_node_id IS NOT NULL) AND (execution_node_id IS DISTINCT FROM node_id) AND (attempt_id IS NOT NULL))
    WHEN 'assignment'::text THEN (delegation_id IS NOT NULL)
    WHEN 'delegation'::text THEN (delegation_id IS NOT NULL)
    WHEN 'app'::text THEN (app_id IS NOT NULL)
    WHEN 'reasoning'::text THEN ((run_id IS NOT NULL) AND (body IS NOT NULL) AND (jsonb_typeof(body) = 'string'::text) AND (octet_length((body #>> '{}'::text[])) <= 900000))
    WHEN 'node-message'::text THEN ((node_id IS NOT NULL) AND (body IS NOT NULL) AND (jsonb_typeof(body) = 'string'::text) AND (octet_length((body #>> '{}'::text[])) <= 491520))
    WHEN 'place'::text THEN ((run_id IS NOT NULL) AND (body IS NOT NULL) AND public.opensteer_valid_place(body))
    ELSE false
END),
    CONSTRAINT transcript_items_position_check CHECK (("position" > 0)),
    CONSTRAINT transcript_items_revision_check CHECK ((revision >= 0)),
    CONSTRAINT transcript_items_view_check CHECK (((jsonb_typeof(view) = 'object'::text) AND (octet_length((view)::text) <= 2048)))
);


--
-- Name: trigger_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_control_requests (
    occurrence_id text NOT NULL,
    request_id text NOT NULL,
    action text NOT NULL,
    action_class text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trigger_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_occurrences (
    causal_chain_id text,
    id text NOT NULL,
    trigger_id text NOT NULL,
    revision_id text NOT NULL,
    command_id text NOT NULL,
    environment_id text NOT NULL,
    source_key text NOT NULL,
    event jsonb NOT NULL,
    status text NOT NULL,
    execution_generation integer DEFAULT 0 NOT NULL,
    runner_id text,
    runner_boot_id text,
    result jsonb,
    error jsonb,
    stdout text NOT NULL,
    stderr text NOT NULL,
    exit_code integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_occurrences_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: trigger_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_revisions (
    id text NOT NULL,
    trigger_id text NOT NULL,
    ordinal integer NOT NULL,
    source jsonb NOT NULL,
    program jsonb NOT NULL,
    created_by text NOT NULL,
    created_by_thread_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trigger_watch_activations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_watch_activations (
    id text NOT NULL,
    trigger_id text NOT NULL,
    revision_id text NOT NULL,
    environment_id text NOT NULL,
    anchor_thread_id text NOT NULL,
    created_by text NOT NULL,
    desired text NOT NULL,
    observed text NOT NULL,
    execution_generation bigint NOT NULL,
    runner_id text,
    runner_boot_id text,
    runner_connection_generation bigint,
    restart_count integer NOT NULL,
    consecutive_failures integer NOT NULL,
    healthy_since timestamp with time zone,
    last_exit_code integer,
    last_error text,
    stdout_tail text NOT NULL,
    stderr_tail text NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_watch_activations_desired_check CHECK ((desired = ANY (ARRAY['active'::text, 'stopped'::text]))),
    CONSTRAINT trigger_watch_activations_observed_check CHECK ((observed = ANY (ARRAY['starting'::text, 'running'::text, 'backoff'::text, 'expired'::text, 'stopped'::text])))
);


--
-- Name: trigger_watch_reconcile_generation; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trigger_watch_reconcile_generation
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.triggers (
    system_role text,
    id text NOT NULL,
    anchor_thread_id text NOT NULL,
    created_by text NOT NULL,
    created_by_thread_id text,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    current_revision_id text NOT NULL,
    next_fire_at timestamp with time zone,
    consecutive_failures integer NOT NULL,
    pause_reason text,
    waiting_reason text,
    webhook_route_key text,
    webhook_secret_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT triggers_kind_check CHECK ((kind = ANY (ARRAY['schedule'::text, 'webhook'::text, 'watch'::text]))),
    CONSTRAINT triggers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text]))),
    CONSTRAINT triggers_system_role_check CHECK ((system_role = ANY (ARRAY['memory-light'::text, 'memory-nightly'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    display_name text NOT NULL,
    email text NOT NULL,
    email_verified boolean NOT NULL,
    image text,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT users_name_revision_check CHECK ((name_revision >= 0))
);


--
-- Name: watch_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_control_requests (
    activation_id text NOT NULL,
    action text NOT NULL,
    observation_id text NOT NULL,
    request_fingerprint text NOT NULL,
    request_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watch_control_requests_action_check CHECK ((action = ANY (ARRAY['thread.delegate'::text, 'thread.message'::text])))
);


--
-- Name: account_directory_projections account_directory_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_directory_projections
    ADD CONSTRAINT account_directory_projections_pkey PRIMARY KEY (provider_id, account_id);


--
-- Name: account_directory_provider account_directory_provider_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_directory_provider
    ADD CONSTRAINT account_directory_provider_pkey PRIMARY KEY (singleton_key);


--
-- Name: account_directory_provider account_directory_provider_provider_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_directory_provider
    ADD CONSTRAINT account_directory_provider_provider_id_key UNIQUE (provider_id);


--
-- Name: agent_connections agent_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connections
    ADD CONSTRAINT agent_connections_pkey PRIMARY KEY (id);


--
-- Name: agent_control_requests agent_control_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_control_requests
    ADD CONSTRAINT agent_control_requests_pkey PRIMARY KEY (run_id, request_id);


--
-- Name: agent_home_settings agent_home_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_settings
    ADD CONSTRAINT agent_home_settings_pkey PRIMARY KEY (computer_id);


--
-- Name: agent_home_skill_inventory agent_home_skill_inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_skill_inventory
    ADD CONSTRAINT agent_home_skill_inventory_pkey PRIMARY KEY (computer_id);


--
-- Name: app_servers app_servers_computer_id_port_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_servers
    ADD CONSTRAINT app_servers_computer_id_port_key UNIQUE (computer_id, port);


--
-- Name: app_servers app_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_servers
    ADD CONSTRAINT app_servers_pkey PRIMARY KEY (app_id);


--
-- Name: app_versions app_versions_created_by_run_publish_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_created_by_run_publish_key_key UNIQUE (created_by_run, publish_key);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (app_id, version);


--
-- Name: apps apps_id_computer; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_id_computer UNIQUE (id, computer_id);


--
-- Name: apps apps_owner_creation; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_owner_creation UNIQUE (owner_id, creation_key);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_provider_account_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_provider_account_unique UNIQUE (provider_id, account_id);


--
-- Name: auth_admissions auth_admissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_admissions
    ADD CONSTRAINT auth_admissions_pkey PRIMARY KEY (id);


--
-- Name: auth_jwks auth_jwks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_jwks
    ADD CONSTRAINT auth_jwks_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limits auth_rate_limits_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_key_key UNIQUE (key);


--
-- Name: auth_rate_limits auth_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_key UNIQUE (token);


--
-- Name: auth_sso_providers auth_sso_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sso_providers
    ADD CONSTRAINT auth_sso_providers_pkey PRIMARY KEY (id);


--
-- Name: auth_sso_providers auth_sso_providers_provider_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sso_providers
    ADD CONSTRAINT auth_sso_providers_provider_id_key UNIQUE (provider_id);


--
-- Name: auth_verifications auth_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);


--
-- Name: automation_failure_notices automation_failure_notices_occurrence_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_failure_notices
    ADD CONSTRAINT automation_failure_notices_occurrence_id_key UNIQUE (occurrence_id);


--
-- Name: automation_failure_notices automation_failure_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_failure_notices
    ADD CONSTRAINT automation_failure_notices_pkey PRIMARY KEY (id);


--
-- Name: browser_history_entries browser_history_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_history_entries
    ADD CONSTRAINT browser_history_entries_pkey PRIMARY KEY (profile_id, url);


--
-- Name: browser_history_icons browser_history_icons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_history_icons
    ADD CONSTRAINT browser_history_icons_pkey PRIMARY KEY (profile_id, origin);


--
-- Name: browser_profile_deletions browser_profile_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_deletions
    ADD CONSTRAINT browser_profile_deletions_pkey PRIMARY KEY (deletion_id);


--
-- Name: browser_profile_deletions browser_profile_deletions_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_deletions
    ADD CONSTRAINT browser_profile_deletions_profile_id_key UNIQUE (profile_id);


--
-- Name: browser_profiles browser_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profiles
    ADD CONSTRAINT browser_profiles_pkey PRIMARY KEY (id);


--
-- Name: browser_session_attachments browser_session_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_attachments
    ADD CONSTRAINT browser_session_attachments_pkey PRIMARY KEY (session_id, agent_binding_id);


--
-- Name: browser_session_uses browser_session_uses_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_uses
    ADD CONSTRAINT browser_session_uses_identity UNIQUE NULLS NOT DISTINCT (session_id, thread_id, run_id, tab_id);


--
-- Name: browser_session_uses browser_session_uses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_uses
    ADD CONSTRAINT browser_session_uses_pkey PRIMARY KEY (id);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: browser_sign_ins browser_sign_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sign_ins
    ADD CONSTRAINT browser_sign_ins_pkey PRIMARY KEY (id);


--
-- Name: browser_site_grants browser_site_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_site_grants
    ADD CONSTRAINT browser_site_grants_pkey PRIMARY KEY (id);


--
-- Name: browser_source_pairings browser_source_pairings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_source_pairings
    ADD CONSTRAINT browser_source_pairings_pkey PRIMARY KEY (code_hash);


--
-- Name: browser_sources browser_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sources
    ADD CONSTRAINT browser_sources_pkey PRIMARY KEY (id);


--
-- Name: browser_tab_opens browser_tab_opens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_tab_opens
    ADD CONSTRAINT browser_tab_opens_pkey PRIMARY KEY (owner_id, idempotency_key);


--
-- Name: causal_chains causal_chains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.causal_chains
    ADD CONSTRAINT causal_chains_pkey PRIMARY KEY (id);


--
-- Name: channel_access_grants channel_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_access_grants
    ADD CONSTRAINT channel_access_grants_pkey PRIMARY KEY (account_id, binding_id, external_user_id);


--
-- Name: channel_accounts channel_accounts_connection_id_external_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_accounts
    ADD CONSTRAINT channel_accounts_connection_id_external_account_id_key UNIQUE (connection_id, external_account_id);


--
-- Name: channel_accounts channel_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_accounts
    ADD CONSTRAINT channel_accounts_pkey PRIMARY KEY (id);


--
-- Name: channel_bindings channel_bindings_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_id_account_id_key UNIQUE (id, account_id);


--
-- Name: channel_bindings channel_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_pkey PRIMARY KEY (id);


--
-- Name: channel_conversations channel_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversations
    ADD CONSTRAINT channel_conversations_pkey PRIMARY KEY (id);


--
-- Name: channel_deliveries channel_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_deliveries
    ADD CONSTRAINT channel_deliveries_pkey PRIMARY KEY (id);


--
-- Name: channel_identities channel_identities_account_id_external_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_account_id_external_user_id_key UNIQUE (account_id, external_user_id);


--
-- Name: channel_identities channel_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_pkey PRIMARY KEY (id);


--
-- Name: channel_identities channel_identities_principal_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_principal_id_key UNIQUE (principal_id);


--
-- Name: channel_ingress_events channel_ingress_events_account_id_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_account_id_provider_event_id_key UNIQUE (account_id, provider_event_id);


--
-- Name: channel_ingress_events channel_ingress_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_pkey PRIMARY KEY (id);


--
-- Name: channel_link_codes channel_link_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: channel_link_codes channel_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_pkey PRIMARY KEY (id);


--
-- Name: client_changes client_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_changes
    ADD CONSTRAINT client_changes_pkey PRIMARY KEY (deployment_id, sequence, ordinal);


--
-- Name: commands commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_pkey PRIMARY KEY (id);


--
-- Name: commands commands_request_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_request_idempotency_unique UNIQUE (requested_by, idempotency_key);


--
-- Name: computer_app_setup_requests computer_app_setup_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_app_setup_requests
    ADD CONSTRAINT computer_app_setup_requests_pkey PRIMARY KEY (id);


--
-- Name: computer_use_policies computer_use_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_policies
    ADD CONSTRAINT computer_use_policies_pkey PRIMARY KEY (deployment_id, runner_id, owner_user_id);


--
-- Name: computer_use_stops computer_use_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_stops
    ADD CONSTRAINT computer_use_stops_pkey PRIMARY KEY (run_id, runner_id);


--
-- Name: credential_access_audit credential_access_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_access_audit
    ADD CONSTRAINT credential_access_audit_pkey PRIMARY KEY (id);


--
-- Name: credential_vault_canaries credential_vault_canaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_vault_canaries
    ADD CONSTRAINT credential_vault_canaries_pkey PRIMARY KEY (key_version);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (id);


--
-- Name: delegations delegations_child_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_child_run_id_key UNIQUE (child_run_id);


--
-- Name: delegations delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_pkey PRIMARY KEY (id);


--
-- Name: client_sync_state deployment_event_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sync_state
    ADD CONSTRAINT deployment_event_state_pkey PRIMARY KEY (deployment_id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_singleton; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_singleton UNIQUE (singleton_key);


--
-- Name: deployments deployments_singleton_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_singleton_key_key UNIQUE (singleton_key);


--
-- Name: device_drivers device_drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_drivers
    ADD CONSTRAINT device_drivers_pkey PRIMARY KEY (device_id, role);


--
-- Name: device_setup_retirements device_setup_retirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_setup_retirements
    ADD CONSTRAINT device_setup_retirements_pkey PRIMARY KEY (runner_id, public_key_pem);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: execution_environments execution_environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_environments
    ADD CONSTRAINT execution_environments_pkey PRIMARY KEY (id);


--
-- Name: execution_nodes execution_nodes_id_run_id_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_nodes
    ADD CONSTRAINT execution_nodes_id_run_id_attempt_id_key UNIQUE (id, run_id, attempt_id);


--
-- Name: execution_nodes execution_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_nodes
    ADD CONSTRAINT execution_nodes_pkey PRIMARY KEY (id);


--
-- Name: grants grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_pkey PRIMARY KEY (id);


--
-- Name: harness_catalogs harness_catalogs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_catalogs
    ADD CONSTRAINT harness_catalogs_pkey PRIMARY KEY (environment_id, harness_instance_id);


--
-- Name: harness_instances harness_instances_id_environment_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instances
    ADD CONSTRAINT harness_instances_id_environment_key UNIQUE (id, environment_id);


--
-- Name: harness_instances harness_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instances
    ADD CONSTRAINT harness_instances_pkey PRIMARY KEY (id);


--
-- Name: host_account_adoption_proofs host_account_adoption_proofs_credential_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_account_adoption_proofs
    ADD CONSTRAINT host_account_adoption_proofs_credential_hash_key UNIQUE (credential_hash);


--
-- Name: host_account_adoption_proofs host_account_adoption_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_account_adoption_proofs
    ADD CONSTRAINT host_account_adoption_proofs_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_access_tokens host_oauth_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_client_assertions host_oauth_client_assertions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_client_assertions
    ADD CONSTRAINT host_oauth_client_assertions_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_client_resources host_oauth_client_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_client_resources
    ADD CONSTRAINT host_oauth_client_resources_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_clients host_oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_clients
    ADD CONSTRAINT host_oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_consents host_oauth_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_consents
    ADD CONSTRAINT host_oauth_consents_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_resources host_oauth_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_resources
    ADD CONSTRAINT host_oauth_resources_pkey PRIMARY KEY (id);


--
-- Name: integration_auth_attempts integration_auth_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_auth_attempts
    ADD CONSTRAINT integration_auth_attempts_pkey PRIMARY KEY (id);


--
-- Name: integration_auth_attempts integration_auth_attempts_state_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_auth_attempts
    ADD CONSTRAINT integration_auth_attempts_state_hash_key UNIQUE (state_hash);


--
-- Name: integration_authority_generations integration_authority_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_authority_generations
    ADD CONSTRAINT integration_authority_generations_pkey PRIMARY KEY (owner_user_id);


--
-- Name: integration_authority_pending integration_authority_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_authority_pending
    ADD CONSTRAINT integration_authority_pending_pkey PRIMARY KEY (transaction_id, owner_user_id);


--
-- Name: integration_connections integration_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);


--
-- Name: integration_grants integration_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_pkey PRIMARY KEY (id);


--
-- Name: integration_installations integration_installations_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_installations
    ADD CONSTRAINT integration_installations_name_key UNIQUE (name);


--
-- Name: integration_installations integration_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_installations
    ADD CONSTRAINT integration_installations_pkey PRIMARY KEY (id);


--
-- Name: integration_request_details integration_request_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_pkey PRIMARY KEY (request_id);


--
-- Name: integration_server_secrets integration_server_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_server_secrets
    ADD CONSTRAINT integration_server_secrets_pkey PRIMARY KEY (server_id);


--
-- Name: integration_servers integration_servers_installation_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_servers
    ADD CONSTRAINT integration_servers_installation_id_name_key UNIQUE (installation_id, name);


--
-- Name: integration_servers integration_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_servers
    ADD CONSTRAINT integration_servers_pkey PRIMARY KEY (id);


--
-- Name: integration_tool_definitions integration_tool_definitions_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tool_definitions
    ADD CONSTRAINT integration_tool_definitions_scope UNIQUE NULLS NOT DISTINCT (server_id, connection_id);


--
-- Name: integration_tool_definitions integration_tool_definitions_server_id_connection_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tool_definitions
    ADD CONSTRAINT integration_tool_definitions_server_id_connection_id_key UNIQUE NULLS NOT DISTINCT (server_id, connection_id);


--
-- Name: integration_tools integration_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tools
    ADD CONSTRAINT integration_tools_pkey PRIMARY KEY (id);


--
-- Name: kysely_migration_lock kysely_migration_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kysely_migration_lock
    ADD CONSTRAINT kysely_migration_lock_pkey PRIMARY KEY (id);


--
-- Name: kysely_migration kysely_migration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kysely_migration
    ADD CONSTRAINT kysely_migration_pkey PRIMARY KEY (name);


--
-- Name: machine_access_events machine_access_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_access_events
    ADD CONSTRAINT machine_access_events_pkey PRIMARY KEY (id);


--
-- Name: machine_access_sessions machine_access_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_access_sessions
    ADD CONSTRAINT machine_access_sessions_pkey PRIMARY KEY (id);


--
-- Name: message_revisions message_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_revisions
    ADD CONSTRAINT message_revisions_pkey PRIMARY KEY (message_id, revision);


--
-- Name: messages messages_id_run_id_thread_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_id_run_id_thread_id_key UNIQUE (id, run_id, thread_id);


--
-- Name: messages messages_id_thread_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_id_thread_unique UNIQUE (id, thread_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notification_preview_keys notification_preview_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preview_keys
    ADD CONSTRAINT notification_preview_keys_pkey PRIMARY KEY (user_id, installation_id);


--
-- Name: owner_enrollments owner_enrollments_kind_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_enrollments
    ADD CONSTRAINT owner_enrollments_kind_idempotency_unique UNIQUE (kind, idempotency_key);


--
-- Name: owner_enrollments owner_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_enrollments
    ADD CONSTRAINT owner_enrollments_pkey PRIMARY KEY (id);


--
-- Name: owner_enrollments owner_enrollments_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_enrollments
    ADD CONSTRAINT owner_enrollments_token_hash_key UNIQUE (token_hash);


--
-- Name: personal_account_link_keys personal_account_link_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_account_link_keys
    ADD CONSTRAINT personal_account_link_keys_pkey PRIMARY KEY (challenge_id);


--
-- Name: personal_attention personal_attention_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_pkey PRIMARY KEY (id);


--
-- Name: personal_attention personal_attention_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_request_id_key UNIQUE (request_id);


--
-- Name: personal_attention personal_attention_team_deployment_id_team_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_team_deployment_id_team_request_id_key UNIQUE (team_deployment_id, team_request_id);


--
-- Name: personal_desktop_update personal_desktop_update_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_desktop_update
    ADD CONSTRAINT personal_desktop_update_pkey PRIMARY KEY (id);


--
-- Name: personal_remote_access personal_remote_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_access
    ADD CONSTRAINT personal_remote_access_pkey PRIMARY KEY (singleton_key);


--
-- Name: personal_remote_account_link personal_remote_account_link_grant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_account_link
    ADD CONSTRAINT personal_remote_account_link_grant_id_key UNIQUE (grant_id);


--
-- Name: personal_remote_account_link personal_remote_account_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_account_link
    ADD CONSTRAINT personal_remote_account_link_pkey PRIMARY KEY (singleton_key);


--
-- Name: personal_remote_administration personal_remote_administration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_administration
    ADD CONSTRAINT personal_remote_administration_pkey PRIMARY KEY (id);


--
-- Name: personal_remote_pairing_codes personal_remote_pairing_codes_credential_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_pairing_codes
    ADD CONSTRAINT personal_remote_pairing_codes_credential_hash_key UNIQUE (credential_hash);


--
-- Name: personal_remote_pairing_codes personal_remote_pairing_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_pairing_codes
    ADD CONSTRAINT personal_remote_pairing_codes_pkey PRIMARY KEY (id);


--
-- Name: personal_remote_session_grant_uses personal_remote_session_grant_uses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_session_grant_uses
    ADD CONSTRAINT personal_remote_session_grant_uses_pkey PRIMARY KEY (grant_id);


--
-- Name: personal_remote_sessions personal_remote_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_sessions
    ADD CONSTRAINT personal_remote_sessions_pkey PRIMARY KEY (auth_session_id);


--
-- Name: personal_settings personal_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_settings
    ADD CONSTRAINT personal_settings_pkey PRIMARY KEY (singleton_key);


--
-- Name: personal_tabs personal_tabs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_tabs
    ADD CONSTRAINT personal_tabs_pkey PRIMARY KEY (id);


--
-- Name: personal_team_links personal_team_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_links
    ADD CONSTRAINT personal_team_links_pkey PRIMARY KEY (id);


--
-- Name: personal_team_links personal_team_links_team_deployment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_links
    ADD CONSTRAINT personal_team_links_team_deployment_id_key UNIQUE (team_deployment_id);


--
-- Name: personal_team_posts personal_team_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_posts
    ADD CONSTRAINT personal_team_posts_pkey PRIMARY KEY (team_deployment_id, client_message_id);


--
-- Name: personal_team_requests personal_team_requests_local_input_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_local_input_id_key UNIQUE (local_input_id);


--
-- Name: personal_team_requests personal_team_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_pkey PRIMARY KEY (team_deployment_id, request_id);


--
-- Name: plugin_agent_settings plugin_agent_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_agent_settings
    ADD CONSTRAINT plugin_agent_settings_pkey PRIMARY KEY (owner_user_id, plugin_id);


--
-- Name: plugin_executions plugin_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_pkey PRIMARY KEY (id);


--
-- Name: plugin_oauth_records plugin_oauth_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_oauth_records
    ADD CONSTRAINT plugin_oauth_records_pkey PRIMARY KEY (id);


--
-- Name: plugin_owner_settings plugin_owner_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_owner_settings
    ADD CONSTRAINT plugin_owner_settings_pkey PRIMARY KEY (owner_user_id, target_key);


--
-- Name: plugin_versions plugin_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_versions
    ADD CONSTRAINT plugin_versions_pkey PRIMARY KEY (id);


--
-- Name: plugins plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_pkey PRIMARY KEY (id);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: provider_sessions provider_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sessions
    ADD CONSTRAINT provider_sessions_pkey PRIMARY KEY (id);


--
-- Name: request_call_joins request_call_joins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_call_joins
    ADD CONSTRAINT request_call_joins_pkey PRIMARY KEY (originating_run_id, call_id);


--
-- Name: request_continuations request_continuations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_continuations
    ADD CONSTRAINT request_continuations_pkey PRIMARY KEY (request_id);


--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);


--
-- Name: run_attempts run_attempts_id_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_attempts
    ADD CONSTRAINT run_attempts_id_run_id_key UNIQUE (id, run_id);


--
-- Name: run_attempts run_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_attempts
    ADD CONSTRAINT run_attempts_pkey PRIMARY KEY (id);


--
-- Name: runner_enrollments runner_enrollments_owner_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_owner_idempotency_unique UNIQUE (created_by, idempotency_key);


--
-- Name: runner_enrollments runner_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_pkey PRIMARY KEY (id);


--
-- Name: runner_enrollments runner_enrollments_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_token_hash_key UNIQUE (token_hash);


--
-- Name: runner_event_receipts runner_event_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_event_receipts
    ADD CONSTRAINT runner_event_receipts_pkey PRIMARY KEY (run_id, ordinal);


--
-- Name: runner_plugin_data_removals runner_plugin_data_removals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_plugin_data_removals
    ADD CONSTRAINT runner_plugin_data_removals_pkey PRIMARY KEY (runner_id, plugin_id);


--
-- Name: runners runners_enrollment_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runners
    ADD CONSTRAINT runners_enrollment_token_hash_key UNIQUE (enrollment_token_hash);


--
-- Name: runners runners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runners
    ADD CONSTRAINT runners_pkey PRIMARY KEY (id);


--
-- Name: runners runners_public_key_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runners
    ADD CONSTRAINT runners_public_key_fingerprint_key UNIQUE (public_key_fingerprint);


--
-- Name: runs runs_id_thread_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_id_thread_unique UNIQUE (id, thread_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: runs runs_thread_run_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_thread_run_ordinal_unique UNIQUE (thread_id, run_ordinal);


--
-- Name: security_audit security_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_audit
    ADD CONSTRAINT security_audit_pkey PRIMARY KEY (id);


--
-- Name: tab_layouts tab_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_layouts
    ADD CONSTRAINT tab_layouts_pkey PRIMARY KEY (owner_id);


--
-- Name: task_question_notices task_question_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_question_notices
    ADD CONSTRAINT task_question_notices_pkey PRIMARY KEY (request_id);


--
-- Name: team_access_changes team_access_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_access_changes
    ADD CONSTRAINT team_access_changes_pkey PRIMARY KEY (revision);


--
-- Name: team_access_state team_access_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_access_state
    ADD CONSTRAINT team_access_state_pkey PRIMARY KEY (singleton_key);


--
-- Name: team_agent_recipients team_agent_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_recipients
    ADD CONSTRAINT team_agent_recipients_pkey PRIMARY KEY (user_id, channel_id, root_id);


--
-- Name: team_agent_requests team_agent_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_pkey PRIMARY KEY (id);


--
-- Name: team_audit team_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_audit
    ADD CONSTRAINT team_audit_pkey PRIMARY KEY (id);


--
-- Name: team_blobs team_blobs_channel_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_channel_id_id_key UNIQUE (channel_id, id);


--
-- Name: team_blobs team_blobs_channel_id_uploader_user_id_client_upload_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_channel_id_uploader_user_id_client_upload_id_key UNIQUE (channel_id, uploader_user_id, client_upload_id);


--
-- Name: team_blobs team_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_pkey PRIMARY KEY (id);


--
-- Name: team_channel_member_state team_channel_member_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_member_state
    ADD CONSTRAINT team_channel_member_state_pkey PRIMARY KEY (channel_id, user_id);


--
-- Name: team_channel_members team_channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_pkey PRIMARY KEY (channel_id, subject_kind, subject_id);


--
-- Name: team_channels team_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channels
    ADD CONSTRAINT team_channels_pkey PRIMARY KEY (id);


--
-- Name: team_group_edges team_group_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_edges
    ADD CONSTRAINT team_group_edges_pkey PRIMARY KEY (parent_group_id, child_group_id);


--
-- Name: team_group_people team_group_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_people
    ADD CONSTRAINT team_group_people_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: team_groups team_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_groups
    ADD CONSTRAINT team_groups_pkey PRIMARY KEY (id);


--
-- Name: team_installation team_installation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_installation
    ADD CONSTRAINT team_installation_pkey PRIMARY KEY (singleton_key);


--
-- Name: team_invite_uses team_invite_uses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invite_uses
    ADD CONSTRAINT team_invite_uses_pkey PRIMARY KEY (invite_id, user_id);


--
-- Name: team_invites team_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_selector_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_selector_key UNIQUE (selector);


--
-- Name: team_invites team_invites_verifier_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_verifier_hash_key UNIQUE (verifier_hash);


--
-- Name: team_link_connections team_link_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_link_connections
    ADD CONSTRAINT team_link_connections_pkey PRIMARY KEY (link_id, epoch);


--
-- Name: team_links team_links_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_links
    ADD CONSTRAINT team_links_code_hash_key UNIQUE (code_hash);


--
-- Name: team_links team_links_id_owner_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_links
    ADD CONSTRAINT team_links_id_owner_user_id_key UNIQUE (id, owner_user_id);


--
-- Name: team_links team_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_links
    ADD CONSTRAINT team_links_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_handle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_handle_key UNIQUE (handle);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (user_id);


--
-- Name: team_mentions team_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_mentions
    ADD CONSTRAINT team_mentions_pkey PRIMARY KEY (message_id, target_user_id, target_kind);


--
-- Name: team_message_attachments team_message_attachments_blob_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_attachments
    ADD CONSTRAINT team_message_attachments_blob_id_key UNIQUE (blob_id);


--
-- Name: team_message_attachments team_message_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_attachments
    ADD CONSTRAINT team_message_attachments_pkey PRIMARY KEY (message_id, "position");


--
-- Name: team_message_pins team_message_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_pins
    ADD CONSTRAINT team_message_pins_pkey PRIMARY KEY (message_id);


--
-- Name: team_messages team_messages_channel_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_channel_id_id_key UNIQUE (channel_id, id);


--
-- Name: team_messages team_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_pkey PRIMARY KEY (id);


--
-- Name: team_note_versions team_note_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_note_versions
    ADD CONSTRAINT team_note_versions_pkey PRIMARY KEY (note_id, version);


--
-- Name: team_notes team_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notes
    ADD CONSTRAINT team_notes_pkey PRIMARY KEY (id);


--
-- Name: team_notices team_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notices
    ADD CONSTRAINT team_notices_pkey PRIMARY KEY (id);


--
-- Name: team_notices team_notices_recipient_user_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notices
    ADD CONSTRAINT team_notices_recipient_user_id_dedupe_key_key UNIQUE (recipient_user_id, dedupe_key);


--
-- Name: team_outbox team_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_outbox
    ADD CONSTRAINT team_outbox_pkey PRIMARY KEY (id);


--
-- Name: team_partner_calls team_partner_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_calls
    ADD CONSTRAINT team_partner_calls_pkey PRIMARY KEY (id);


--
-- Name: team_partner_invites team_partner_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_invites
    ADD CONSTRAINT team_partner_invites_pkey PRIMARY KEY (id);


--
-- Name: team_partner_links team_partner_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_links
    ADD CONSTRAINT team_partner_links_pkey PRIMARY KEY (id);


--
-- Name: team_presence team_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_presence
    ADD CONSTRAINT team_presence_pkey PRIMARY KEY (connection_id);


--
-- Name: team_principals team_principals_home_team_id_home_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_principals
    ADD CONSTRAINT team_principals_home_team_id_home_user_id_key UNIQUE (home_team_id, home_user_id);


--
-- Name: team_principals team_principals_member_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_principals
    ADD CONSTRAINT team_principals_member_user_id_key UNIQUE (member_user_id);


--
-- Name: team_principals team_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_principals
    ADD CONSTRAINT team_principals_pkey PRIMARY KEY (id);


--
-- Name: team_share_asks team_share_asks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_pkey PRIMARY KEY (id);


--
-- Name: team_share_asks team_share_asks_share_id_trigger_message_id_target_principa_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_share_id_trigger_message_id_target_principa_key UNIQUE (share_id, trigger_message_id, target_principal_id);


--
-- Name: team_share_participants team_share_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_participants
    ADD CONSTRAINT team_share_participants_pkey PRIMARY KEY (share_id, principal_id);


--
-- Name: team_share_participants team_share_participants_share_id_handle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_participants
    ADD CONSTRAINT team_share_participants_share_id_handle_key UNIQUE (share_id, handle) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: team_share_relays team_share_relays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_relays
    ADD CONSTRAINT team_share_relays_pkey PRIMARY KEY (share_id, author_user_id, author_kind, client_message_id);


--
-- Name: team_shares team_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_pkey PRIMARY KEY (id);


--
-- Name: team_sharing_settings team_sharing_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_sharing_settings
    ADD CONSTRAINT team_sharing_settings_pkey PRIMARY KEY (singleton_key);


--
-- Name: team_topic_grants team_topic_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topic_grants
    ADD CONSTRAINT team_topic_grants_pkey PRIMARY KEY (topic_id, subject_kind, subject_id);


--
-- Name: team_topics team_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topics
    ADD CONSTRAINT team_topics_pkey PRIMARY KEY (id);


--
-- Name: thread_inputs thread_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_pkey PRIMARY KEY (message_id);


--
-- Name: thread_inputs thread_inputs_request_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_request_idempotency_unique UNIQUE (requested_by, idempotency_key);


--
-- Name: thread_visits thread_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_visits
    ADD CONSTRAINT thread_visits_pkey PRIMARY KEY (thread_id, user_id);


--
-- Name: threads threads_id_lineage_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_id_lineage_unique UNIQUE (id, lineage_root_thread_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: tool_calls tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (id);


--
-- Name: tool_calls tool_calls_run_id_attempt_id_binding_generation_node_id_cal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_run_id_attempt_id_binding_generation_node_id_cal_key UNIQUE NULLS NOT DISTINCT (run_id, attempt_id, binding_generation, node_id, call_id);


--
-- Name: tool_output_images tool_output_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_output_images
    ADD CONSTRAINT tool_output_images_pkey PRIMARY KEY (id);


--
-- Name: tool_output_images tool_output_images_tool_call_id_image_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_output_images
    ADD CONSTRAINT tool_output_images_tool_call_id_image_index_key UNIQUE (tool_call_id, image_index);


--
-- Name: transcript_items transcript_items_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_message_id_key UNIQUE (message_id);


--
-- Name: transcript_items transcript_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_pkey PRIMARY KEY (id);


--
-- Name: trigger_control_requests trigger_control_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_control_requests
    ADD CONSTRAINT trigger_control_requests_pkey PRIMARY KEY (occurrence_id, request_id);


--
-- Name: trigger_occurrences trigger_occurrences_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_command_id_key UNIQUE (command_id);


--
-- Name: trigger_occurrences trigger_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_pkey PRIMARY KEY (id);


--
-- Name: trigger_occurrences trigger_occurrences_source_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_source_unique UNIQUE (trigger_id, source_key);


--
-- Name: trigger_revisions trigger_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_pkey PRIMARY KEY (id);


--
-- Name: trigger_revisions trigger_revisions_trigger_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_trigger_id_unique UNIQUE (trigger_id, id);


--
-- Name: trigger_revisions trigger_revisions_trigger_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_trigger_ordinal_unique UNIQUE (trigger_id, ordinal);


--
-- Name: trigger_watch_activations trigger_watch_activations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_pkey PRIMARY KEY (id);


--
-- Name: triggers triggers_creator_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_creator_idempotency_unique UNIQUE (created_by, idempotency_key);


--
-- Name: triggers triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_pkey PRIMARY KEY (id);


--
-- Name: triggers triggers_webhook_route_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_webhook_route_key_key UNIQUE (webhook_route_key);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: watch_control_requests watch_control_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_control_requests
    ADD CONSTRAINT watch_control_requests_pkey PRIMARY KEY (activation_id, request_id);


--
-- Name: account_directory_projections_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_directory_projections_pending ON public.account_directory_projections USING btree (provider_id, next_attempt_at, updated_at) WHERE (published_generation < generation);


--
-- Name: agent_control_requests_run_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_control_requests_run_class ON public.agent_control_requests USING btree (run_id, action_class);


--
-- Name: apps_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apps_run ON public.apps USING btree (run_id);


--
-- Name: apps_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apps_task ON public.apps USING btree (thread_id);


--
-- Name: auth_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_accounts_user ON public.auth_accounts USING btree (user_id);


--
-- Name: auth_admissions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_admissions_expiry ON public.auth_admissions USING btree (expires_at);


--
-- Name: auth_sessions_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_device_id_idx ON public.auth_sessions USING btree (device_id);


--
-- Name: auth_sessions_user_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_expiry ON public.auth_sessions USING btree (user_id, expires_at DESC);


--
-- Name: auth_verifications_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verifications_identifier ON public.auth_verifications USING btree (identifier);


--
-- Name: browser_session_attachments_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_session_attachments_session ON public.browser_session_attachments USING btree (session_id);


--
-- Name: browser_sessions_active_profile_placement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_active_profile_placement ON public.browser_sessions USING btree (profile_id, placement_key) WHERE (state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text]));


--
-- Name: browser_sessions_runner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_runner ON public.browser_sessions USING btree (runner_id, state);


--
-- Name: browser_sessions_tab_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_tab_group ON public.browser_sessions USING btree (tab_group_id, created_at DESC);


--
-- Name: browser_tab_opens_preference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_tab_opens_preference ON public.browser_tab_opens USING btree (owner_id, identity_key, created_at DESC) WHERE (identity_key IS NOT NULL);


--
-- Name: browser_tab_opens_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_tab_opens_retention ON public.browser_tab_opens USING btree (owner_id, created_at);


--
-- Name: causal_chains_root_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX causal_chains_root_message ON public.causal_chains USING btree (root_message_id);


--
-- Name: causal_chains_watch_observation_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX causal_chains_watch_observation_unique ON public.causal_chains USING btree (root_watch_activation_id, root_watch_observation_id) WHERE (root_watch_activation_id IS NOT NULL);


--
-- Name: channel_access_grants_account_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_access_grants_account_status ON public.channel_access_grants USING btree (account_id, status, requested_at DESC);


--
-- Name: channel_accounts_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_accounts_connection ON public.channel_accounts USING btree (connection_id, updated_at DESC);


--
-- Name: channel_bindings_account_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_bindings_account_status ON public.channel_bindings USING btree (account_id, status, updated_at DESC);


--
-- Name: channel_conversations_active_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_conversations_active_task ON public.channel_conversations USING btree (active_thread_id);


--
-- Name: channel_conversations_external_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_conversations_external_unique ON public.channel_conversations USING btree (provider, external_account_id, external_scope_id, external_conversation_id, external_thread_id) NULLS NOT DISTINCT;


--
-- Name: channel_deliveries_attention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_attention ON public.channel_deliveries USING btree (account_id, status) WHERE (status = ANY (ARRAY['unknown'::text, 'dead'::text]));


--
-- Name: channel_deliveries_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_claimable ON public.channel_deliveries USING btree (COALESCE(conversation_id, ingress_id), created_at, part) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text, 'attempt-started'::text, 'retryable-failed'::text, 'unknown'::text]));


--
-- Name: channel_deliveries_message_reply_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_deliveries_message_reply_unique ON public.channel_deliveries USING btree (message_id, part) WHERE ((kind = 'reply'::text) AND (message_id IS NOT NULL));


--
-- Name: channel_deliveries_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_retention ON public.channel_deliveries USING btree (updated_at) WHERE (status = ANY (ARRAY['sent'::text, 'dead'::text]));


--
-- Name: channel_identities_linked_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_identities_linked_user ON public.channel_identities USING btree (linked_user_id) WHERE (linked_user_id IS NOT NULL);


--
-- Name: channel_ingress_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_ingress_claimable ON public.channel_ingress_events USING btree (next_attempt_at, received_at) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text]));


--
-- Name: channel_ingress_events_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_ingress_events_message ON public.channel_ingress_events USING btree (message_id);


--
-- Name: channel_ingress_lane; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_ingress_lane ON public.channel_ingress_events USING btree (lane_key, status);


--
-- Name: channel_ingress_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_ingress_retention ON public.channel_ingress_events USING btree (processed_at) WHERE (status = ANY (ARRAY['adopted'::text, 'ignored'::text, 'dead'::text]));


--
-- Name: channel_link_codes_account_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_link_codes_account_expiry ON public.channel_link_codes USING btree (account_id, expires_at);


--
-- Name: channel_link_codes_identity_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_link_codes_identity_live ON public.channel_link_codes USING btree (identity_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: client_changes_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_changes_scope ON public.client_changes USING btree (deployment_id, scope_key, sequence, ordinal);


--
-- Name: commands_current_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_current_run ON public.commands USING btree (run_id, id) WHERE ((run_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'unknown'::text])));


--
-- Name: commands_environment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_environment_active ON public.commands USING btree (environment_id) WHERE (status = ANY (ARRAY['pending'::text, 'dispatched'::text]));


--
-- Name: commands_execution_proof; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_execution_proof ON public.commands USING btree (run_id, type, id) WHERE (run_id IS NOT NULL);


--
-- Name: commands_task_adoption; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_task_adoption ON public.commands USING btree (thread_id, id) WHERE (type = ANY (ARRAY['thread.rename'::text, 'thread.done.set'::text, 'thread.archive'::text]));


--
-- Name: commands_thread_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_thread_fk ON public.commands USING btree (thread_id);


--
-- Name: commands_unclaimed_execute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_unclaimed_execute ON public.commands USING btree (run_id, id) WHERE ((type = 'run.execute'::text) AND (attempts = 0));


--
-- Name: computer_app_setup_requests_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX computer_app_setup_requests_deadline ON public.computer_app_setup_requests USING btree (expires_at, id);


--
-- Name: computer_app_setup_requests_device_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX computer_app_setup_requests_device_expiry ON public.computer_app_setup_requests USING btree (runner_id, expires_at);


--
-- Name: computer_app_setup_requests_owner_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX computer_app_setup_requests_owner_expiry ON public.computer_app_setup_requests USING btree (owner_user_id, expires_at);


--
-- Name: computer_use_stops_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX computer_use_stops_device ON public.computer_use_stops USING btree (runner_id, run_id);


--
-- Name: credential_access_audit_credential_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credential_access_audit_credential_created ON public.credential_access_audit USING btree (credential_id, created_at DESC);


--
-- Name: delegations_current_parent_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegations_current_parent_run ON public.delegations USING btree (parent_run_id, id) WHERE (status = 'open'::text);


--
-- Name: delegations_open_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegations_open_child ON public.delegations USING btree (parent_assignment_id, id) WHERE (status = 'open'::text);


--
-- Name: delegations_pending_cancellation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegations_pending_cancellation ON public.delegations USING btree (cancellation_root_id, id) WHERE (cancellation_root_id IS NOT NULL);


--
-- Name: delegations_result_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegations_result_message ON public.delegations USING btree (result_message_id) WHERE (result_message_id IS NOT NULL);


--
-- Name: device_drivers_runner_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_drivers_runner_live ON public.device_drivers USING btree (runner_id, device_id, role) WHERE (detached_at IS NULL);


--
-- Name: device_drivers_self_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_drivers_self_live ON public.device_drivers USING btree (runner_id) WHERE ((role = 'self'::text) AND (detached_at IS NULL));


--
-- Name: devices_deployment_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_deployment_live ON public.devices USING btree (deployment_id, id) WHERE (removed_at IS NULL);


--
-- Name: devices_owner_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_owner_live ON public.devices USING btree (owner_user_id, id) WHERE (removed_at IS NULL);


--
-- Name: execution_nodes_current_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_nodes_current_parent ON public.execution_nodes USING btree (parent_node_id, id) WHERE (status = 'running'::text);


--
-- Name: execution_nodes_current_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_nodes_current_root ON public.execution_nodes USING btree (run_id, id) WHERE ((status = 'running'::text) AND (parent_node_id IS NULL));


--
-- Name: execution_nodes_current_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_nodes_current_run ON public.execution_nodes USING btree (run_id, id) WHERE (status = 'running'::text);


--
-- Name: grants_current_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grants_current_run ON public.grants USING btree (run_id, id) WHERE (status = 'active'::text);


--
-- Name: harness_instances_environment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_instances_environment ON public.harness_instances USING btree (environment_id, created_at) WHERE (removed_at IS NULL);


--
-- Name: harness_instances_one_ambient_per_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_instances_one_ambient_per_driver ON public.harness_instances USING btree (environment_id, driver_kind) WHERE ((state_kind = 'ambient'::text) AND (removed_at IS NULL));


--
-- Name: harness_instances_one_default_per_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_instances_one_default_per_driver ON public.harness_instances USING btree (environment_id, driver_kind) WHERE ((removed_at IS NULL) AND is_default);


--
-- Name: host_account_adoption_proofs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_account_adoption_proofs_pending ON public.host_account_adoption_proofs USING btree (authorized_by_user_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: host_oauth_access_tokens_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_access_tokens_session ON public.host_oauth_access_tokens USING btree (session_id);


--
-- Name: host_oauth_refresh_tokens_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_refresh_tokens_session ON public.host_oauth_refresh_tokens USING btree (session_id);


--
-- Name: inputs_team_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inputs_team_request ON public.thread_inputs USING btree (thread_id, team_request_id) WHERE (team_request_id IS NOT NULL);


--
-- Name: integration_auth_attempts_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_auth_attempts_expiry ON public.integration_auth_attempts USING btree (expires_at);


--
-- Name: integration_auth_attempts_launch_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_auth_attempts_launch_ticket ON public.integration_auth_attempts USING btree (launch_ticket_hash);


--
-- Name: integration_auth_attempts_owner_flow_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_auth_attempts_owner_flow_status ON public.integration_auth_attempts USING btree (owner_user_id, flow, status, created_at DESC);


--
-- Name: integration_connections_computer_live_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_connections_computer_live_unique ON public.integration_connections USING btree (integration_definition_id, runner_id, COALESCE(computer_app_key, ''::text)) WHERE ((connection_kind = 'computer'::text) AND (status <> 'revoked'::text));


--
-- Name: integration_connections_device_live_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_connections_device_live_unique ON public.integration_connections USING btree (integration_definition_id, COALESCE(device_id, runner_id), COALESCE(computer_app_key, ''::text)) WHERE ((connection_kind = 'computer'::text) AND (status <> 'revoked'::text));


--
-- Name: integration_connections_kind_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_connections_kind_owner_updated ON public.integration_connections USING btree (connection_kind, owner_user_id, updated_at DESC);


--
-- Name: integration_connections_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_connections_owner_updated ON public.integration_connections USING btree (owner_user_id, updated_at DESC);


--
-- Name: integration_connections_runtime_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_connections_runtime_status ON public.integration_connections USING btree (runner_id, status, updated_at);


--
-- Name: integration_servers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_servers_active ON public.integration_servers USING btree (installation_id, status);


--
-- Name: integration_tools_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_tools_active ON public.integration_tools USING btree (server_id, status, name);


--
-- Name: integration_tools_server_connection_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_tools_server_connection_name ON public.integration_tools USING btree (server_id, connection_id, name) NULLS NOT DISTINCT WHERE (status = 'active'::text);


--
-- Name: machine_access_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machine_access_events_session ON public.machine_access_events USING btree (session_id, id);


--
-- Name: machine_access_sessions_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machine_access_sessions_history ON public.machine_access_sessions USING btree (runner_id, started_at DESC, id DESC);


--
-- Name: machine_access_sessions_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machine_access_sessions_open ON public.machine_access_sessions USING btree (runner_id) WHERE (ended_at IS NULL);


--
-- Name: machine_access_sessions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machine_access_sessions_run ON public.machine_access_sessions USING btree (run_id);


--
-- Name: messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_created_at ON public.messages USING btree (created_at);


--
-- Name: messages_current_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_current_published ON public.messages USING btree (thread_id, sequence DESC) WHERE published;


--
-- Name: messages_run_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_run_sequence ON public.messages USING btree (run_id, sequence DESC);


--
-- Name: messages_thread_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_thread_recent ON public.messages USING btree (thread_id, created_at DESC, id DESC);


--
-- Name: messages_thread_sequence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_thread_sequence_unique ON public.messages USING btree (thread_id, sequence);


--
-- Name: personal_attention_direct; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_attention_direct ON public.personal_attention USING btree (sort_at DESC, id DESC) WHERE (kind = ANY (ARRAY['request'::text, 'failed-ask'::text]));


--
-- Name: personal_attention_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_attention_expiry ON public.personal_attention USING btree (expires_at, id) WHERE (kind = 'team-ask'::text);


--
-- Name: personal_attention_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_attention_team ON public.personal_attention USING btree (team_deployment_id, sort_at DESC, id DESC) WHERE (kind = 'team-ask'::text);


--
-- Name: personal_attention_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_attention_thread ON public.personal_attention USING btree (thread_id) WHERE (thread_id IS NOT NULL);


--
-- Name: personal_remote_pairing_codes_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_remote_pairing_codes_pending ON public.personal_remote_pairing_codes USING btree (generation, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: personal_remote_sessions_generation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_remote_sessions_generation ON public.personal_remote_sessions USING btree (route_kind, route_generation);


--
-- Name: personal_tabs_app; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personal_tabs_app ON public.personal_tabs USING btree (owner_id, app_id) WHERE (kind = 'app'::text);


--
-- Name: personal_tabs_closed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_tabs_closed ON public.personal_tabs USING btree (owner_id, closed_at DESC, id) WHERE (closed_at IS NOT NULL);


--
-- Name: personal_tabs_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_tabs_open ON public.personal_tabs USING btree (owner_id, created_at, id) WHERE (closed_at IS NULL);


--
-- Name: personal_tabs_open_page_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_tabs_open_page_session ON public.personal_tabs USING btree (owner_id, ((page_binding ->> 'sessionId'::text))) WHERE ((kind = 'page'::text) AND (closed_at IS NULL));


--
-- Name: personal_tabs_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personal_tabs_phone ON public.personal_tabs USING btree (owner_id, computer_id) WHERE (kind = 'phone'::text);


--
-- Name: personal_tabs_window; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personal_tabs_window ON public.personal_tabs USING btree (owner_id, computer_id, window_id) WHERE (kind = 'window'::text);


--
-- Name: personal_team_links_approval_buckets; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_links_approval_buckets ON public.personal_team_links USING btree (team_deployment_id) WHERE ((approval_attention_count > 0) AND (state = ANY (ARRAY['active'::text, 'unreachable'::text, 'needs_update'::text])));


--
-- Name: personal_team_posts_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_posts_expiry ON public.personal_team_posts USING btree (created_at);


--
-- Name: personal_team_requests_consent_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_consent_deadline ON public.personal_team_requests USING btree (consent_expires_at, team_deployment_id, request_id) WHERE ((kind = 'ask'::text) AND (terminal_state IS NULL) AND (local_decision IS NULL) AND (consent_expires_at IS NOT NULL));


--
-- Name: personal_team_requests_local_input; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_local_input ON public.personal_team_requests USING btree (local_input_id) WHERE (local_input_id IS NOT NULL);


--
-- Name: personal_team_requests_local_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_local_run ON public.personal_team_requests USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: personal_team_requests_local_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_local_task ON public.personal_team_requests USING btree (local_task_id, request_id);


--
-- Name: personal_team_requests_pending_consent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_pending_consent ON public.personal_team_requests USING btree (created_at DESC, request_id DESC) WHERE ((kind = 'ask'::text) AND (remote_state = 'awaiting_approval'::text) AND (local_decision IS NULL));


--
-- Name: personal_team_requests_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_reply ON public.personal_team_requests USING btree (team_deployment_id, accepted_message_id) WHERE ((publication_state = 'accepted'::text) AND (accepted_message_id IS NOT NULL));


--
-- Name: personal_team_requests_return_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personal_team_requests_return_origin ON public.personal_team_requests USING btree (team_deployment_id, ((return_payload ->> 'originAskId'::text))) WHERE ((kind = 'return'::text) AND (return_admission IS DISTINCT FROM 'undeliverable'::text));


--
-- Name: personal_team_requests_unpublished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_team_requests_unpublished ON public.personal_team_requests USING btree (team_deployment_id, created_at, request_id) WHERE (publication_state = 'pending'::text);


--
-- Name: personal_team_returns_post_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personal_team_returns_post_target ON public.personal_team_requests USING btree (team_deployment_id, ((return_payload ->> 'triggerClientMessageId'::text)), (((return_payload -> 'author'::text) ->> 'handle'::text))) WHERE ((return_admission = 'admitted'::text) AND ((return_payload ->> 'triggerClientMessageId'::text) IS NOT NULL));


--
-- Name: plugin_executions_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plugin_executions_request ON public.plugin_executions USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: plugin_executions_unfinished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plugin_executions_unfinished ON public.plugin_executions USING btree (state) WHERE (state = ANY (ARRAY['running'::text, 'waiting'::text, 'answered'::text]));


--
-- Name: plugin_oauth_records_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plugin_oauth_records_expiry ON public.plugin_oauth_records USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: plugins_owner_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plugins_owner_name ON public.plugins USING btree (installed_by, name);


--
-- Name: principals_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX principals_user_unique ON public.principals USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: provider_sessions_one_active_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_sessions_one_active_per_thread ON public.provider_sessions USING btree (thread_id) WHERE active;


--
-- Name: provider_sessions_prior_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_sessions_prior_reference ON public.provider_sessions USING btree (thread_id, id) WHERE (provider_session_reference IS NOT NULL);


--
-- Name: request_continuations_waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_continuations_waiting ON public.request_continuations USING btree (attempted_at NULLS FIRST, created_at, request_id) WHERE (status = 'waiting'::text);


--
-- Name: requests_current_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_current_node ON public.requests USING btree (originating_node_id, id) WHERE ((status = 'pending'::text) AND (originating_node_id IS NOT NULL));


--
-- Name: requests_current_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_current_run ON public.requests USING btree (originating_run_id, id) WHERE (status = 'pending'::text);


--
-- Name: requests_current_run_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_current_run_end ON public.requests USING btree (originating_run_id, id) WHERE ((status = 'pending'::text) AND ((mode = 'live'::text) OR (kind = ANY (ARRAY['plugin.approval'::text, 'plugin.input'::text]))));


--
-- Name: requests_current_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_current_thread ON public.requests USING btree (originating_thread_id, id) WHERE ((status = 'pending'::text) AND (originating_node_id IS NULL));


--
-- Name: requests_needs_you; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_needs_you ON public.requests USING btree (created_at, id) WHERE (status = 'pending'::text);


--
-- Name: requests_occurrence_call_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX requests_occurrence_call_identity_unique ON public.requests USING btree (originating_occurrence_id, call_id) WHERE (originating_occurrence_id IS NOT NULL);


--
-- Name: requests_originating_thread_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_originating_thread_history ON public.requests USING btree (originating_thread_id, created_at, id);


--
-- Name: requests_originating_thread_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_originating_thread_pending ON public.requests USING btree (originating_thread_id, created_at, id) WHERE (status = 'pending'::text);


--
-- Name: requests_password_sign_in_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_password_sign_in_deadline ON public.requests USING btree (((payload ->> 'expiresAt'::text)), id) WHERE ((kind = 'browser.password-sign-in'::text) AND (status = 'pending'::text));


--
-- Name: requests_pending_origin_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX requests_pending_origin_thread ON public.requests USING btree (originating_thread_id, id) WHERE (status = 'pending'::text);


--
-- Name: requests_run_call_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX requests_run_call_identity_unique ON public.requests USING btree (originating_run_id, call_id) WHERE (originating_run_id IS NOT NULL);


--
-- Name: requests_watch_call_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX requests_watch_call_identity ON public.requests USING btree (originating_watch_activation_id, call_id) WHERE (originating_watch_activation_id IS NOT NULL);


--
-- Name: run_attempts_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_attempts_binding ON public.run_attempts USING btree (run_id, binding_generation, id);


--
-- Name: run_attempts_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_attempts_open ON public.run_attempts USING btree (run_id, id) WHERE (ended_at IS NULL);


--
-- Name: run_attempts_recent_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_attempts_recent_recovery ON public.run_attempts USING btree (run_id, started_at DESC) WHERE (reason = 'recovery'::text);


--
-- Name: runners_single_main; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runners_single_main ON public.runners USING btree (kind) WHERE ((kind = 'main'::text) AND (revoked_at IS NULL));


--
-- Name: runs_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_chain ON public.runs USING btree (causal_chain_id);


--
-- Name: runs_compaction_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_compaction_source_idx ON public.runs USING btree (thread_id, ((maintenance ->> 'providerSessionId'::text)), ((maintenance ->> 'sourceRunId'::text))) WHERE (maintenance IS NOT NULL);


--
-- Name: runs_current_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_current_latest ON public.runs USING btree (thread_id, run_ordinal DESC) WHERE (maintenance IS NULL);


--
-- Name: runs_current_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_current_queue ON public.runs USING btree (thread_id, run_ordinal) WHERE (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_current_seed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_current_seed ON public.runs USING btree (seed_input_id) WHERE (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_environment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_environment_active ON public.runs USING btree (environment_id) WHERE (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_finishing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_finishing ON public.runs USING btree (id) WHERE (finish_intent IS NOT NULL);


--
-- Name: runs_one_executing_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_one_executing_per_thread ON public.runs USING btree (thread_id) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_one_queued_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_one_queued_per_thread ON public.runs USING btree (thread_id) WHERE (status = 'queued'::text);


--
-- Name: runs_seed_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_seed_source ON public.runs USING btree (seed_input_id, run_ordinal DESC);


--
-- Name: runs_session_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_session_started ON public.runs USING btree (provider_session_id, run_ordinal) WHERE (started_at IS NOT NULL);


--
-- Name: runs_session_uncertain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_session_uncertain ON public.runs USING btree (provider_session_id, run_ordinal) WHERE ((started_at IS NULL) AND (binding_generation IS NOT NULL) AND (NOT runner_safety_terminal) AND (execute_claim_state <> 'unclaimed'::text));


--
-- Name: runs_team_reply_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_team_reply_target ON public.runs USING btree (thread_id, ((reply_target ->> 'teamId'::text)), ((reply_target ->> 'requestId'::text))) WHERE ((reply_target ->> 'kind'::text) = 'team-thread'::text);


--
-- Name: runs_terminal_reply_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_terminal_reply_source ON public.runs USING btree (terminal_reply_message_id) WHERE (terminal_reply_message_id IS NOT NULL);


--
-- Name: runs_thread_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_thread_started ON public.runs USING btree (thread_id, run_ordinal) WHERE (started_at IS NOT NULL);


--
-- Name: runs_thread_uncertain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_thread_uncertain ON public.runs USING btree (thread_id, run_ordinal) WHERE ((started_at IS NULL) AND (binding_generation IS NOT NULL) AND (NOT runner_safety_terminal) AND (execute_claim_state <> 'unclaimed'::text));


--
-- Name: security_audit_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_audit_actor_created ON public.security_audit USING btree (actor_user_id, created_at DESC, id DESC);


--
-- Name: team_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_audit_action ON public.team_audit USING btree (action, id DESC);


--
-- Name: team_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_audit_actor ON public.team_audit USING btree (actor_user_id, id DESC);


--
-- Name: team_audit_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_audit_channel ON public.team_audit USING btree (channel_id, id DESC);


--
-- Name: team_audit_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_audit_page ON public.team_audit USING btree (occurred_at DESC, id DESC);


--
-- Name: team_blobs_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_blobs_cleanup ON public.team_blobs USING btree (state, expires_at, id);


--
-- Name: team_blobs_public_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_blobs_public_id ON public.team_blobs USING btree (channel_id, public_id);


--
-- Name: team_channel_member_state_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_channel_member_state_user ON public.team_channel_member_state USING btree (user_id, channel_id);


--
-- Name: team_channel_members_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_channel_members_subject ON public.team_channel_members USING btree (subject_kind, subject_id, channel_id);


--
-- Name: team_channels_directory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_channels_directory ON public.team_channels USING btree (kind, normalized_name, id);


--
-- Name: team_channels_dm; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_channels_dm ON public.team_channels USING btree (dm_key) WHERE (dm_key IS NOT NULL);


--
-- Name: team_channels_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_channels_name ON public.team_channels USING btree (normalized_name) WHERE ((normalized_name IS NOT NULL) AND (archived_at IS NULL));


--
-- Name: team_files_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_files_page ON public.team_message_attachments USING btree (channel_id, message_id DESC, "position");


--
-- Name: team_group_edges_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_group_edges_child ON public.team_group_edges USING btree (child_group_id, parent_group_id);


--
-- Name: team_group_people_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_group_people_person ON public.team_group_people USING btree (user_id, group_id);


--
-- Name: team_groups_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_groups_name ON public.team_groups USING btree (normalized_name) WHERE (deleted_at IS NULL);


--
-- Name: team_invites_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_invites_current ON public.team_invites USING btree ((true)) WHERE ((sealed_verifier IS NOT NULL) AND (revoked_at IS NULL));


--
-- Name: team_invites_expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_invites_expiring ON public.team_invites USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: team_link_connections_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_link_connections_process ON public.team_link_connections USING btree (process_id);


--
-- Name: team_links_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_links_active ON public.team_links USING btree (owner_user_id) WHERE (state = 'active'::text);


--
-- Name: team_links_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_links_credential ON public.team_links USING btree (credential_hash) WHERE (credential_hash IS NOT NULL);


--
-- Name: team_links_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_links_pending ON public.team_links USING btree (owner_user_id) WHERE (state = 'pending'::text);


--
-- Name: team_members_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_active ON public.team_members USING btree (state, user_id);


--
-- Name: team_members_roles; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_roles ON public.team_members USING btree (role, state);


--
-- Name: team_mentions_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_mentions_channel ON public.team_mentions USING btree (channel_id, message_id);


--
-- Name: team_mentions_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_mentions_person ON public.team_mentions USING btree (target_user_id, channel_id, message_id);


--
-- Name: team_messages_agent_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_messages_agent_reply ON public.team_messages USING btree (agent_request_id) WHERE (agent_request_id IS NOT NULL);


--
-- Name: team_messages_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_author ON public.team_messages USING btree (author_user_id, id DESC);


--
-- Name: team_messages_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_messages_client_id ON public.team_messages USING btree (channel_id, author_user_id, author_kind, client_message_id);


--
-- Name: team_messages_creation_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_messages_creation_seq ON public.team_messages USING btree (channel_id, created_seq);


--
-- Name: team_messages_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_history ON public.team_messages USING btree (channel_id, id DESC);


--
-- Name: team_messages_public_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_messages_public_id ON public.team_messages USING btree (channel_id, public_id);


--
-- Name: team_messages_replies; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_replies ON public.team_messages USING btree (channel_id, thread_root_id, id) WHERE (thread_root_id IS NOT NULL);


--
-- Name: team_messages_resume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_resume ON public.team_messages USING btree (channel_id, change_seq);


--
-- Name: team_messages_roots; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_roots ON public.team_messages USING btree (channel_id, id DESC) WHERE (thread_root_id IS NULL);


--
-- Name: team_messages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_search ON public.team_messages USING gin (search_document);


--
-- Name: team_note_versions_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_note_versions_writer ON public.team_note_versions USING btree (writer_user_id, written_at DESC);


--
-- Name: team_notes_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_notes_recent ON public.team_notes USING btree (topic_id, updated_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: team_notes_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_notes_search ON public.team_notes USING gin (search);


--
-- Name: team_notices_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_notices_page ON public.team_notices USING btree (recipient_user_id, created_at DESC, id DESC);


--
-- Name: team_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_outbox_pending ON public.team_outbox USING btree (created_at, id);


--
-- Name: team_partner_calls_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_partner_calls_created ON public.team_partner_calls USING btree (created_at);


--
-- Name: team_partner_calls_queued; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_partner_calls_queued ON public.team_partner_calls USING btree (link_id, created_at) WHERE (state = 'queued'::text);


--
-- Name: team_partner_links_live_team; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_partner_links_live_team ON public.team_partner_links USING btree (partner_team_id) WHERE (state <> 'revoked'::text);


--
-- Name: team_pins_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_pins_page ON public.team_message_pins USING btree (channel_id, pinned_at DESC, message_id);


--
-- Name: team_presence_process; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_presence_process ON public.team_presence USING btree (process_id);


--
-- Name: team_presence_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_presence_user ON public.team_presence USING btree (user_id);


--
-- Name: team_requests_consent_expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_consent_expiring ON public.team_agent_requests USING btree (consent_expires_at, id) WHERE (state = 'awaiting_approval'::text);


--
-- Name: team_requests_expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_expiring ON public.team_agent_requests USING btree (expires_at) WHERE (state = ANY (ARRAY['working'::text, 'needs_you'::text]));


--
-- Name: team_requests_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_link ON public.team_agent_requests USING btree (link_id, state);


--
-- Name: team_requests_queued; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_queued ON public.team_agent_requests USING btree (owner_user_id, created_at, id) WHERE ((state = ANY (ARRAY['awaiting_approval'::text, 'queued'::text])) AND (kind <> 'return'::text));


--
-- Name: team_requests_resume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_resume ON public.team_agent_requests USING btree (channel_id, change_seq);


--
-- Name: team_requests_return_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_requests_return_origin ON public.team_agent_requests USING btree (((return_payload ->> 'originAskId'::text))) WHERE (kind = 'return'::text);


--
-- Name: team_requests_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_requests_thread ON public.team_agent_requests USING btree (channel_id, thread_root_id, created_at, id);


--
-- Name: team_requests_trigger_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_requests_trigger_owner ON public.team_agent_requests USING btree (trigger_message_id, owner_user_id) WHERE (kind = ANY (ARRAY['self'::text, 'ask'::text]));


--
-- Name: team_share_asks_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_share_asks_pending ON public.team_share_asks USING btree (share_id, created_at) WHERE (outcome IS NULL);


--
-- Name: team_share_relays_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_share_relays_client ON public.team_share_relays USING btree (share_id, client_message_id);


--
-- Name: team_shares_follower_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_shares_follower_channel ON public.team_shares USING btree (channel_id) WHERE (role = 'follower'::text);


--
-- Name: team_shares_live_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_shares_live_channel ON public.team_shares USING btree (channel_id) WHERE (state <> 'ended'::text);


--
-- Name: team_topic_grants_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_topic_grants_subject ON public.team_topic_grants USING btree (subject_kind, subject_id, topic_id);


--
-- Name: team_topics_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_topics_name ON public.team_topics USING btree (lower(name), id);


--
-- Name: thread_inputs_awaiting_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_awaiting_approval ON public.thread_inputs USING btree (thread_id, created_at, message_id) WHERE (state = 'awaiting-approval'::text);


--
-- Name: thread_inputs_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_chain ON public.thread_inputs USING btree (causal_chain_id);


--
-- Name: thread_inputs_channel_authority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_channel_authority ON public.thread_inputs USING btree (thread_id) WHERE ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'unknown'::text])) AND ((authority_source ->> 'kind'::text) = 'channel-ingress'::text));


--
-- Name: thread_inputs_current_channel_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_current_channel_binding ON public.thread_inputs USING btree (((authority_source ->> 'bindingId'::text)), message_id) WHERE ((state = ANY (ARRAY['pending'::text, 'unknown'::text])) AND ((authority_source ->> 'kind'::text) = 'channel-ingress'::text));


--
-- Name: thread_inputs_current_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_current_queue ON public.thread_inputs USING btree (thread_id, approval_sort, queue_rank, message_id) WHERE ((policy = 'queue'::text) AND (state = ANY (ARRAY['pending'::text, 'awaiting-approval'::text])));


--
-- Name: thread_inputs_current_steer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_current_steer ON public.thread_inputs USING btree (run_id, message_id) WHERE ((steer_command_id IS NOT NULL) AND (state = 'claimed'::text));


--
-- Name: thread_inputs_edit_lease_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_edit_lease_expiry ON public.thread_inputs USING btree (edit_lease_expires_at) WHERE (edit_lease_id IS NOT NULL);


--
-- Name: thread_inputs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_pending ON public.thread_inputs USING btree (thread_id, created_at, message_id) WHERE (state = 'pending'::text);


--
-- Name: thread_inputs_pending_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_pending_assignment ON public.thread_inputs USING btree (assignment_id, message_id) WHERE (state = 'pending'::text);


--
-- Name: thread_inputs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_run ON public.thread_inputs USING btree (run_id, created_at, message_id) WHERE (run_id IS NOT NULL);


--
-- Name: thread_inputs_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_updated_at ON public.thread_inputs USING btree (updated_at);


--
-- Name: threads_creator_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_creator_created ON public.threads USING btree (created_by, created_at DESC, id DESC) INCLUDE (color);


--
-- Name: threads_current_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_current_active ON public.threads USING btree (created_by, asked_at DESC, id DESC) WHERE (listed AND (removed_at IS NULL) AND (done_at IS NULL) AND (status = ANY (ARRAY['running'::text, 'waiting'::text])));


--
-- Name: threads_current_done; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_current_done ON public.threads USING btree (created_by, done_at DESC, id DESC) WHERE (listed AND (removed_at IS NULL) AND (done_at IS NOT NULL) AND (status <> 'archived'::text));


--
-- Name: threads_current_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_current_recent ON public.threads USING btree (created_by, asked_at DESC, id DESC) WHERE (listed AND (removed_at IS NULL) AND (done_at IS NULL) AND (status <> ALL (ARRAY['archived'::text, 'running'::text, 'waiting'::text])));


--
-- Name: threads_environment_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_environment_live ON public.threads USING btree (environment_id) WHERE (status <> 'archived'::text);


--
-- Name: threads_last_reply_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_last_reply_source ON public.threads USING btree (last_reply_message_id) WHERE (last_reply_message_id IS NOT NULL);


--
-- Name: threads_lineage_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_lineage_page ON public.threads USING btree (lineage_root_thread_id, updated_at DESC, id DESC);


--
-- Name: threads_parent_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_parent_thread ON public.threads USING btree (parent_thread_id) WHERE (parent_thread_id IS NOT NULL);


--
-- Name: threads_removed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_removed ON public.threads USING btree (id) WHERE (removed_at IS NOT NULL);


--
-- Name: threads_team_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX threads_team_origin ON public.threads USING btree (team_id, channel_id, thread_root_id) WHERE (team_id IS NOT NULL);


--
-- Name: tool_calls_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_attempt ON public.tool_calls USING btree (attempt_id);


--
-- Name: tool_calls_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_node ON public.tool_calls USING btree (node_id);


--
-- Name: tool_calls_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_open ON public.tool_calls USING btree (id) WHERE (status = 'open'::text);


--
-- Name: tool_calls_open_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_open_binding ON public.tool_calls USING btree (run_id, binding_generation, id) WHERE (status = 'open'::text);


--
-- Name: tool_calls_open_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_open_origin ON public.tool_calls USING btree (origin, run_id, id) WHERE (status = 'open'::text);


--
-- Name: tool_calls_open_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_open_run ON public.tool_calls USING btree (run_id, id) WHERE (status = 'open'::text);


--
-- Name: tool_calls_open_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_open_scope ON public.tool_calls USING btree (thread_id, node_id, id) WHERE (status = 'open'::text);


--
-- Name: tool_calls_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_calls_thread ON public.tool_calls USING btree (thread_id);


--
-- Name: tool_output_images_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_output_images_node ON public.tool_output_images USING btree (node_id) WHERE (node_id IS NOT NULL);


--
-- Name: tool_output_images_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_output_images_path ON public.tool_output_images USING btree (thread_id, path_hash, completion_order DESC, image_index DESC);


--
-- Name: tool_output_images_scope_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_output_images_scope_path ON public.tool_output_images USING btree (thread_id, node_id, path_hash, completion_order DESC, image_index DESC);


--
-- Name: transcript_app; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_app ON public.transcript_items USING btree (thread_id, app_id) WHERE (app_id IS NOT NULL);


--
-- Name: transcript_app_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_app_source ON public.transcript_items USING btree (app_id) WHERE (app_id IS NOT NULL);


--
-- Name: transcript_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_attempt ON public.transcript_items USING btree (attempt_id);


--
-- Name: transcript_delegation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_delegation ON public.transcript_items USING btree (thread_id, kind, delegation_id) WHERE (delegation_id IS NOT NULL);


--
-- Name: transcript_delegation_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_delegation_source ON public.transcript_items USING btree (delegation_id) WHERE (delegation_id IS NOT NULL);


--
-- Name: transcript_execution_node; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_execution_node ON public.transcript_items USING btree (execution_node_id) WHERE (execution_node_id IS NOT NULL);


--
-- Name: transcript_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_node ON public.transcript_items USING btree (node_id, "position" DESC, id DESC) WHERE (visible AND (node_id IS NOT NULL));


--
-- Name: transcript_node_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_node_activity ON public.transcript_items USING btree (node_id, "position" DESC, id DESC) WHERE (visible AND (node_id IS NOT NULL) AND (kind = ANY (ARRAY['node-message'::text, 'tool'::text])));


--
-- Name: transcript_node_sources; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_node_sources ON public.transcript_items USING btree (node_id);


--
-- Name: transcript_reasoning; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_reasoning ON public.transcript_items USING btree (run_id, attempt_id, binding_generation, node_id, block_id) NULLS NOT DISTINCT WHERE (kind = 'reasoning'::text);


--
-- Name: transcript_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_request ON public.transcript_items USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: transcript_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_root ON public.transcript_items USING btree (thread_id, "position" DESC, id DESC) WHERE (visible AND (node_id IS NULL));


--
-- Name: transcript_root_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_root_activity ON public.transcript_items USING btree (thread_id, "position" DESC, id DESC) WHERE (visible AND (node_id IS NULL) AND (kind = ANY (ARRAY['message'::text, 'tool'::text, 'place'::text, 'app'::text, 'request'::text, 'node'::text])));


--
-- Name: transcript_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_run ON public.transcript_items USING btree (run_id) WHERE (kind = 'run'::text);


--
-- Name: transcript_run_place; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_run_place ON public.transcript_items USING btree (run_id, "position" DESC, id DESC) WHERE (visible AND (kind = 'place'::text));


--
-- Name: transcript_run_sources; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_run_sources ON public.transcript_items USING btree (run_id);


--
-- Name: transcript_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_task ON public.transcript_items USING btree (thread_id, "position" DESC, id DESC) WHERE (visible AND ((node_id IS NULL) OR ((kind = 'request'::text) AND ((view ->> 'requestKind'::text) = 'harness.approval'::text))));


--
-- Name: transcript_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_thread ON public.transcript_items USING btree (thread_id);


--
-- Name: transcript_tool_call; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_tool_call ON public.transcript_items USING btree (tool_call_id) WHERE (tool_call_id IS NOT NULL);


--
-- Name: trigger_control_requests_class_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_control_requests_class_count ON public.trigger_control_requests USING btree (occurrence_id, action_class);


--
-- Name: trigger_occurrences_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_occurrences_chain ON public.trigger_occurrences USING btree (causal_chain_id);


--
-- Name: trigger_occurrences_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_occurrences_recent ON public.trigger_occurrences USING btree (trigger_id, created_at DESC, id DESC);


--
-- Name: trigger_occurrences_running_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_occurrences_running_binding ON public.trigger_occurrences USING btree (runner_id, runner_boot_id) WHERE (status = 'running'::text);


--
-- Name: trigger_revisions_creator_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_revisions_creator_task ON public.trigger_revisions USING btree (created_by_thread_id);


--
-- Name: trigger_watch_activations_environment_desired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_watch_activations_environment_desired ON public.trigger_watch_activations USING btree (environment_id, desired, updated_at, id);


--
-- Name: trigger_watch_activations_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trigger_watch_activations_one_active ON public.trigger_watch_activations USING btree (trigger_id) WHERE (desired = 'active'::text);


--
-- Name: trigger_watch_activations_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_watch_activations_task ON public.trigger_watch_activations USING btree (anchor_thread_id);


--
-- Name: triggers_creator_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX triggers_creator_task ON public.triggers USING btree (created_by_thread_id);


--
-- Name: triggers_due_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX triggers_due_schedule ON public.triggers USING btree (next_fire_at, id) WHERE ((status = 'active'::text) AND (kind = 'schedule'::text) AND (next_fire_at IS NOT NULL));


--
-- Name: triggers_system_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX triggers_system_role ON public.triggers USING btree (system_role) WHERE (system_role IS NOT NULL);


--
-- Name: watch_control_requests_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX watch_control_requests_window ON public.watch_control_requests USING btree (activation_id, created_at);


--
-- Name: auth_accounts auth_accounts_account_directory_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_accounts_account_directory_projection AFTER INSERT OR DELETE OR UPDATE ON public.auth_accounts FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_auth_account_change();


--
-- Name: commands commands_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commands_execution_authority BEFORE INSERT OR UPDATE OF environment_id, thread_id, requested_by, type ON public.commands FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_command_execution_authority();


--
-- Name: harness_instances harness_instances_keep_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER harness_instances_keep_identity BEFORE UPDATE ON public.harness_instances FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_harness_instance_identity_change();


--
-- Name: thread_inputs input_task_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER input_task_immutable BEFORE UPDATE OF thread_id ON public.thread_inputs FOR EACH ROW EXECUTE FUNCTION public.opensteer_task_immutable();


--
-- Name: integration_authority_pending integration_authority_pending_flush; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER integration_authority_pending_flush AFTER INSERT ON public.integration_authority_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.opensteer_flush_integration_authority();


--
-- Name: integration_connections integration_connections_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_connections_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_connections FOR EACH ROW EXECUTE FUNCTION public.opensteer_bump_integration_owner_authority();


--
-- Name: integration_grants integration_grants_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_grants_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_grants FOR EACH ROW EXECUTE FUNCTION public.opensteer_bump_integration_owner_authority();


--
-- Name: integration_installations integration_installations_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_installations_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_installations FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: integration_servers integration_servers_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_servers_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_servers FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: integration_tools integration_tools_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_tools_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_tools FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: requests request_task_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER request_task_immutable BEFORE UPDATE OF originating_thread_id ON public.requests FOR EACH ROW EXECUTE FUNCTION public.opensteer_task_immutable();


--
-- Name: team_access_changes team_bus_access; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_access AFTER INSERT ON public.team_access_changes FOR EACH ROW EXECUTE FUNCTION public.team_bus_access();


--
-- Name: team_installation team_bus_account; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_account AFTER INSERT OR UPDATE ON public.team_installation FOR EACH ROW EXECUTE FUNCTION public.team_bus_account();


--
-- Name: team_channels team_bus_channel_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_channel_insert AFTER INSERT ON public.team_channels FOR EACH ROW EXECUTE FUNCTION public.team_bus_channel();


--
-- Name: team_channels team_bus_channel_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_channel_update AFTER UPDATE OF change_seq, archived_at ON public.team_channels FOR EACH ROW WHEN (((new.change_seq IS DISTINCT FROM old.change_seq) OR (new.archived_at IS DISTINCT FROM old.archived_at))) EXECUTE FUNCTION public.team_bus_channel();


--
-- Name: team_links team_bus_link; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_link AFTER UPDATE OF connection_epoch ON public.team_links FOR EACH ROW WHEN ((new.connection_epoch IS DISTINCT FROM old.connection_epoch)) EXECUTE FUNCTION public.team_bus_link();


--
-- Name: team_link_connections team_bus_link_presence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_link_presence AFTER INSERT OR DELETE ON public.team_link_connections FOR EACH ROW EXECUTE FUNCTION public.team_bus_link_presence();


--
-- Name: users team_bus_member; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_member AFTER UPDATE OF display_name, image, name_revision ON public.users FOR EACH ROW WHEN (((new.display_name IS DISTINCT FROM old.display_name) OR (new.image IS DISTINCT FROM old.image) OR (new.name_revision IS DISTINCT FROM old.name_revision))) EXECUTE FUNCTION public.team_bus_member();


--
-- Name: team_partner_calls team_bus_partner_call; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_partner_call AFTER INSERT OR UPDATE OF state ON public.team_partner_calls FOR EACH ROW EXECUTE FUNCTION public.team_bus_partner_call();


--
-- Name: team_partner_links team_bus_partner_link_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_partner_link_insert AFTER INSERT ON public.team_partner_links FOR EACH ROW EXECUTE FUNCTION public.team_bus_partner_link();


--
-- Name: team_partner_links team_bus_partner_link_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_partner_link_update AFTER UPDATE OF state, local_approved, partner_approved ON public.team_partner_links FOR EACH ROW WHEN (((new.state IS DISTINCT FROM old.state) OR (new.local_approved IS DISTINCT FROM old.local_approved) OR (new.partner_approved IS DISTINCT FROM old.partner_approved))) EXECUTE FUNCTION public.team_bus_partner_link();


--
-- Name: team_presence team_bus_presence_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_presence_change AFTER INSERT OR DELETE ON public.team_presence FOR EACH ROW EXECUTE FUNCTION public.team_bus_presence();


--
-- Name: team_presence team_bus_presence_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_presence_update AFTER UPDATE OF visible, channel_ids ON public.team_presence FOR EACH ROW WHEN (((new.visible IS DISTINCT FROM old.visible) OR (new.channel_ids IS DISTINCT FROM old.channel_ids))) EXECUTE FUNCTION public.team_bus_presence();


--
-- Name: team_agent_requests team_bus_request_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_request_insert AFTER INSERT ON public.team_agent_requests FOR EACH ROW EXECUTE FUNCTION public.team_bus_request();


--
-- Name: team_agent_requests team_bus_request_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_bus_request_update AFTER UPDATE OF change_seq, state ON public.team_agent_requests FOR EACH ROW WHEN (((new.change_seq IS DISTINCT FROM old.change_seq) OR (new.state IS DISTINCT FROM old.state))) EXECUTE FUNCTION public.team_bus_request();


--
-- Name: team_members team_members_principal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_members_principal AFTER INSERT ON public.team_members FOR EACH ROW EXECUTE FUNCTION public.opensteer_create_member_principal();


--
-- Name: team_messages team_message_ordinal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_message_ordinal BEFORE INSERT ON public.team_messages FOR EACH ROW EXECUTE FUNCTION public.opensteer_team_message_ordinal();


--
-- Name: team_principals team_principals_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_principals_identity BEFORE INSERT OR UPDATE ON public.team_principals FOR EACH ROW EXECUTE FUNCTION public.opensteer_check_team_principal();


--
-- Name: threads threads_keep_team_origin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER threads_keep_team_origin BEFORE UPDATE OF team_id, channel_id, thread_root_id ON public.threads FOR EACH ROW EXECUTE FUNCTION public.opensteer_keep_task_team_origin();


--
-- Name: users users_account_directory_projection_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_account_directory_projection_delete BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_user_change();


--
-- Name: users users_account_directory_projection_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_account_directory_projection_update AFTER UPDATE OF disabled_at ON public.users FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_user_change();


--
-- Name: agent_control_requests agent_control_requests_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_control_requests
    ADD CONSTRAINT agent_control_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: agent_control_requests agent_control_requests_source_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_control_requests
    ADD CONSTRAINT agent_control_requests_source_thread_id_fkey FOREIGN KEY (source_thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: agent_home_settings agent_home_settings_computer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_settings
    ADD CONSTRAINT agent_home_settings_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES public.runners(id) ON DELETE CASCADE;


--
-- Name: agent_home_settings agent_home_settings_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_settings
    ADD CONSTRAINT agent_home_settings_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE CASCADE;


--
-- Name: agent_home_skill_inventory agent_home_skill_inventory_computer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_skill_inventory
    ADD CONSTRAINT agent_home_skill_inventory_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES public.runners(id) ON DELETE CASCADE;


--
-- Name: agent_home_skill_inventory agent_home_skill_inventory_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_home_skill_inventory
    ADD CONSTRAINT agent_home_skill_inventory_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE CASCADE;


--
-- Name: app_servers app_servers_app_id_computer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_servers
    ADD CONSTRAINT app_servers_app_id_computer_id_fkey FOREIGN KEY (app_id, computer_id) REFERENCES public.apps(id, computer_id) ON DELETE CASCADE;


--
-- Name: app_versions app_versions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_versions app_versions_created_by_run_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_created_by_run_fkey FOREIGN KEY (created_by_run) REFERENCES public.runs(id) ON DELETE SET NULL;


--
-- Name: apps apps_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: apps apps_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;


--
-- Name: apps apps_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: auth_accounts auth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_admissions auth_admissions_consumed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_admissions
    ADD CONSTRAINT auth_admissions_consumed_by_fkey FOREIGN KEY (consumed_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: auth_sessions auth_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.runners(id);


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_sso_providers auth_sso_providers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sso_providers
    ADD CONSTRAINT auth_sso_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: browser_profiles browser_profiles_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profiles
    ADD CONSTRAINT browser_profiles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: browser_session_attachments browser_session_attachments_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_attachments
    ADD CONSTRAINT browser_session_attachments_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: browser_session_attachments browser_session_attachments_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_attachments
    ADD CONSTRAINT browser_session_attachments_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.browser_sessions(id) ON DELETE CASCADE;


--
-- Name: browser_sessions browser_sessions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.browser_profiles(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: causal_chains causal_chains_root_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.causal_chains
    ADD CONSTRAINT causal_chains_root_message_fk FOREIGN KEY (root_message_id) REFERENCES public.messages(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: causal_chains causal_chains_root_occurrence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.causal_chains
    ADD CONSTRAINT causal_chains_root_occurrence_fk FOREIGN KEY (root_occurrence_id) REFERENCES public.trigger_occurrences(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: causal_chains causal_chains_root_watch_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.causal_chains
    ADD CONSTRAINT causal_chains_root_watch_activation_id_fkey FOREIGN KEY (root_watch_activation_id) REFERENCES public.trigger_watch_activations(id) ON DELETE RESTRICT;


--
-- Name: channel_access_grants channel_access_grants_binding_account_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_access_grants
    ADD CONSTRAINT channel_access_grants_binding_account_fkey FOREIGN KEY (binding_id, account_id) REFERENCES public.channel_bindings(id, account_id) ON DELETE RESTRICT;


--
-- Name: channel_access_grants channel_access_grants_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_access_grants
    ADD CONSTRAINT channel_access_grants_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: channel_access_grants channel_access_grants_request_ingress_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_access_grants
    ADD CONSTRAINT channel_access_grants_request_ingress_id_fkey FOREIGN KEY (request_ingress_id) REFERENCES public.channel_ingress_events(id) ON DELETE SET NULL;


--
-- Name: channel_accounts channel_accounts_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_accounts
    ADD CONSTRAINT channel_accounts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


--
-- Name: channel_bindings channel_bindings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_bindings channel_bindings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: channel_conversations channel_conversations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversations
    ADD CONSTRAINT channel_conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_conversations channel_conversations_active_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversations
    ADD CONSTRAINT channel_conversations_active_thread_id_fkey FOREIGN KEY (active_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: channel_conversations channel_conversations_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversations
    ADD CONSTRAINT channel_conversations_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.channel_bindings(id) ON DELETE RESTRICT;


--
-- Name: channel_deliveries channel_deliveries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_deliveries
    ADD CONSTRAINT channel_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_deliveries channel_deliveries_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_deliveries
    ADD CONSTRAINT channel_deliveries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.channel_conversations(id) ON DELETE RESTRICT;


--
-- Name: channel_deliveries channel_deliveries_ingress_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_deliveries
    ADD CONSTRAINT channel_deliveries_ingress_id_fkey FOREIGN KEY (ingress_id) REFERENCES public.channel_ingress_events(id) ON DELETE RESTRICT;


--
-- Name: channel_deliveries channel_deliveries_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_deliveries
    ADD CONSTRAINT channel_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: channel_identities channel_identities_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_identities channel_identities_linked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: channel_identities channel_identities_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_identities
    ADD CONSTRAINT channel_identities_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: channel_ingress_events channel_ingress_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_ingress_events channel_ingress_events_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.channel_conversations(id) ON DELETE RESTRICT;


--
-- Name: channel_ingress_events channel_ingress_events_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: channel_ingress_events channel_ingress_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ingress_events
    ADD CONSTRAINT channel_ingress_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE RESTRICT;


--
-- Name: channel_link_codes channel_link_codes_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.channel_accounts(id) ON DELETE RESTRICT;


--
-- Name: channel_link_codes channel_link_codes_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.channel_identities(id) ON DELETE RESTRICT;


--
-- Name: channel_link_codes channel_link_codes_request_ingress_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_request_ingress_id_fkey FOREIGN KEY (request_ingress_id) REFERENCES public.channel_ingress_events(id) ON DELETE SET NULL;


--
-- Name: channel_link_codes channel_link_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_link_codes
    ADD CONSTRAINT channel_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: client_changes client_changes_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_changes
    ADD CONSTRAINT client_changes_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.client_sync_state(deployment_id) ON DELETE CASCADE;


--
-- Name: client_sync_state client_sync_state_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sync_state
    ADD CONSTRAINT client_sync_state_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;


--
-- Name: commands commands_actor_principal_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: commands commands_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: commands commands_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: commands commands_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: commands commands_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT commands_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: computer_app_setup_requests computer_app_setup_requests_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_app_setup_requests
    ADD CONSTRAINT computer_app_setup_requests_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE RESTRICT;


--
-- Name: computer_app_setup_requests computer_app_setup_requests_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_app_setup_requests
    ADD CONSTRAINT computer_app_setup_requests_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: computer_use_policies computer_use_policies_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_policies
    ADD CONSTRAINT computer_use_policies_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE RESTRICT;


--
-- Name: computer_use_policies computer_use_policies_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_policies
    ADD CONSTRAINT computer_use_policies_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: computer_use_stops computer_use_stops_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_stops
    ADD CONSTRAINT computer_use_stops_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: credential_access_audit credential_access_audit_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_access_audit
    ADD CONSTRAINT credential_access_audit_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


--
-- Name: credential_access_audit credential_access_audit_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_access_audit
    ADD CONSTRAINT credential_access_audit_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE RESTRICT;


--
-- Name: credential_access_audit credential_access_audit_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_access_audit
    ADD CONSTRAINT credential_access_audit_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: credentials credentials_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: delegations delegations_child_run_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_child_run_thread_fk FOREIGN KEY (child_run_id, child_thread_id) REFERENCES public.runs(id, thread_id) ON DELETE RESTRICT;


--
-- Name: delegations delegations_parent_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_parent_occurrence_id_fkey FOREIGN KEY (parent_occurrence_id) REFERENCES public.trigger_occurrences(id) ON DELETE RESTRICT;


--
-- Name: delegations delegations_parent_run_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_parent_run_thread_fk FOREIGN KEY (parent_run_id, parent_thread_id) REFERENCES public.runs(id, thread_id) ON DELETE RESTRICT;


--
-- Name: delegations delegations_parent_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_parent_thread_id_fkey FOREIGN KEY (parent_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: delegations delegations_parent_watch_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_parent_watch_activation_id_fkey FOREIGN KEY (parent_watch_activation_id) REFERENCES public.trigger_watch_activations(id) ON DELETE RESTRICT;


--
-- Name: delegations delegations_result_message_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_result_message_thread_fk FOREIGN KEY (result_message_id, parent_thread_id) REFERENCES public.messages(id, thread_id) ON DELETE RESTRICT;


--
-- Name: client_sync_state deployment_event_state_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sync_state
    ADD CONSTRAINT deployment_event_state_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id);


--
-- Name: device_drivers device_drivers_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_drivers
    ADD CONSTRAINT device_drivers_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: device_drivers device_drivers_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_drivers
    ADD CONSTRAINT device_drivers_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: devices devices_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE RESTRICT;


--
-- Name: devices devices_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: execution_environments execution_environments_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_environments
    ADD CONSTRAINT execution_environments_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE SET NULL;


--
-- Name: harness_catalogs harness_catalogs_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_catalogs
    ADD CONSTRAINT harness_catalogs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE CASCADE;


--
-- Name: harness_catalogs harness_catalogs_harness_instance_environment_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_catalogs
    ADD CONSTRAINT harness_catalogs_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES public.harness_instances(id, environment_id) ON DELETE CASCADE;


--
-- Name: harness_instances harness_instances_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instances
    ADD CONSTRAINT harness_instances_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: host_account_adoption_proofs host_account_adoption_proofs_authorized_by_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_account_adoption_proofs
    ADD CONSTRAINT host_account_adoption_proofs_authorized_by_session_id_fkey FOREIGN KEY (authorized_by_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: host_account_adoption_proofs host_account_adoption_proofs_authorized_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_account_adoption_proofs
    ADD CONSTRAINT host_account_adoption_proofs_authorized_by_user_id_fkey FOREIGN KEY (authorized_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: host_account_adoption_proofs host_account_adoption_proofs_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_account_adoption_proofs
    ADD CONSTRAINT host_account_adoption_proofs_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;


--
-- Name: host_oauth_access_tokens host_oauth_access_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: integration_auth_attempts integration_auth_attempts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_auth_attempts
    ADD CONSTRAINT integration_auth_attempts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_authority_generations integration_authority_generations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_authority_generations
    ADD CONSTRAINT integration_authority_generations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: integration_connections integration_connections_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE RESTRICT;


--
-- Name: integration_connections integration_connections_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: integration_connections integration_connections_integration_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_integration_server_id_fkey FOREIGN KEY (integration_server_id) REFERENCES public.integration_servers(id) ON DELETE RESTRICT;


--
-- Name: integration_connections integration_connections_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_connections integration_connections_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: integration_grants integration_grants_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


--
-- Name: integration_grants integration_grants_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_grants integration_grants_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;


--
-- Name: integration_grants integration_grants_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_installations integration_installations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_installations
    ADD CONSTRAINT integration_installations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_installations integration_installations_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_installations
    ADD CONSTRAINT integration_installations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_request_details integration_request_details_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;


--
-- Name: integration_request_details integration_request_details_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;


--
-- Name: integration_request_details integration_request_details_requested_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_requested_server_id_fkey FOREIGN KEY (requested_server_id) REFERENCES public.integration_servers(id) ON DELETE RESTRICT;


--
-- Name: integration_servers integration_servers_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_servers
    ADD CONSTRAINT integration_servers_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;


--
-- Name: integration_tool_definitions integration_tool_definitions_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tool_definitions
    ADD CONSTRAINT integration_tool_definitions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


--
-- Name: integration_tool_definitions integration_tool_definitions_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tool_definitions
    ADD CONSTRAINT integration_tool_definitions_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.integration_servers(id) ON DELETE RESTRICT;


--
-- Name: integration_tools integration_tools_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tools
    ADD CONSTRAINT integration_tools_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


--
-- Name: integration_tools integration_tools_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tools
    ADD CONSTRAINT integration_tools_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.integration_servers(id) ON DELETE RESTRICT;


--
-- Name: machine_access_events machine_access_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_access_events
    ADD CONSTRAINT machine_access_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.machine_access_sessions(id) ON DELETE CASCADE;


--
-- Name: machine_access_sessions machine_access_sessions_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_access_sessions
    ADD CONSTRAINT machine_access_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: message_revisions message_revisions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_revisions
    ADD CONSTRAINT message_revisions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: messages messages_actor_principal_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: messages messages_run_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_run_thread_fk FOREIGN KEY (run_id, thread_id) REFERENCES public.runs(id, thread_id);


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: notification_preview_keys notification_preview_keys_auth_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preview_keys
    ADD CONSTRAINT notification_preview_keys_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: owner_enrollments owner_enrollments_consumed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_enrollments
    ADD CONSTRAINT owner_enrollments_consumed_by_fkey FOREIGN KEY (consumed_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: personal_attention personal_attention_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;


--
-- Name: personal_attention personal_attention_team_deployment_id_team_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_team_deployment_id_team_request_id_fkey FOREIGN KEY (team_deployment_id, team_request_id) REFERENCES public.personal_team_requests(team_deployment_id, request_id) MATCH FULL ON DELETE CASCADE;


--
-- Name: personal_attention personal_attention_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_attention
    ADD CONSTRAINT personal_attention_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: personal_remote_pairing_codes personal_remote_pairing_codes_issued_by_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_pairing_codes
    ADD CONSTRAINT personal_remote_pairing_codes_issued_by_session_id_fkey FOREIGN KEY (issued_by_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: personal_remote_sessions personal_remote_sessions_auth_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_remote_sessions
    ADD CONSTRAINT personal_remote_sessions_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: personal_settings personal_settings_agent_home_computer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_settings
    ADD CONSTRAINT personal_settings_agent_home_computer_id_fkey FOREIGN KEY (agent_home_computer_id) REFERENCES public.runners(id);


--
-- Name: personal_settings personal_settings_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_settings
    ADD CONSTRAINT personal_settings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: personal_settings personal_settings_voice_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_settings
    ADD CONSTRAINT personal_settings_voice_thread_id_fkey FOREIGN KEY (voice_thread_id) REFERENCES public.threads(id);


--
-- Name: personal_tabs personal_tabs_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_tabs
    ADD CONSTRAINT personal_tabs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: personal_team_posts personal_team_posts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_posts
    ADD CONSTRAINT personal_team_posts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: personal_team_posts personal_team_posts_team_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_posts
    ADD CONSTRAINT personal_team_posts_team_deployment_id_fkey FOREIGN KEY (team_deployment_id) REFERENCES public.personal_team_links(team_deployment_id) ON DELETE CASCADE;


--
-- Name: personal_team_requests personal_team_requests_answer_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_answer_message_id_fkey FOREIGN KEY (answer_message_id) REFERENCES public.messages(id);


--
-- Name: personal_team_requests personal_team_requests_local_input_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_local_input_id_fkey FOREIGN KEY (local_input_id) REFERENCES public.thread_inputs(message_id);


--
-- Name: personal_team_requests personal_team_requests_local_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_local_task_id_fkey FOREIGN KEY (local_task_id) REFERENCES public.threads(id);


--
-- Name: personal_team_requests personal_team_requests_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: personal_team_requests personal_team_requests_team_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_team_requests
    ADD CONSTRAINT personal_team_requests_team_deployment_id_fkey FOREIGN KEY (team_deployment_id) REFERENCES public.personal_team_links(team_deployment_id);


--
-- Name: plugin_agent_settings plugin_agent_settings_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_agent_settings
    ADD CONSTRAINT plugin_agent_settings_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: plugin_executions plugin_executions_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES public.trigger_occurrences(id);


--
-- Name: plugin_executions plugin_executions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: plugin_executions plugin_executions_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id);


--
-- Name: plugin_executions plugin_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: plugin_executions plugin_executions_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id);


--
-- Name: plugin_executions plugin_executions_watch_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_executions
    ADD CONSTRAINT plugin_executions_watch_activation_id_fkey FOREIGN KEY (watch_activation_id) REFERENCES public.trigger_watch_activations(id);


--
-- Name: plugin_oauth_records plugin_oauth_records_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_oauth_records
    ADD CONSTRAINT plugin_oauth_records_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: principals principals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: provider_sessions provider_sessions_harness_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sessions
    ADD CONSTRAINT provider_sessions_harness_instance_id_fkey FOREIGN KEY (harness_instance_id) REFERENCES public.harness_instances(id) ON DELETE RESTRICT;


--
-- Name: provider_sessions provider_sessions_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sessions
    ADD CONSTRAINT provider_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: provider_sessions provider_sessions_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sessions
    ADD CONSTRAINT provider_sessions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: request_continuations request_continuations_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_continuations
    ADD CONSTRAINT request_continuations_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE RESTRICT;


--
-- Name: requests requests_originating_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_occurrence_id_fkey FOREIGN KEY (originating_occurrence_id) REFERENCES public.trigger_occurrences(id) ON DELETE RESTRICT;


--
-- Name: requests requests_originating_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_run_id_fkey FOREIGN KEY (originating_run_id) REFERENCES public.runs(id) ON DELETE RESTRICT;


--
-- Name: requests requests_originating_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_thread_id_fkey FOREIGN KEY (originating_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: requests requests_originating_watch_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_watch_activation_id_fkey FOREIGN KEY (originating_watch_activation_id) REFERENCES public.trigger_watch_activations(id);


--
-- Name: requests requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: requests requests_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: requests requests_response_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_response_command_id_fkey FOREIGN KEY (response_command_id) REFERENCES public.commands(id) ON DELETE RESTRICT;


--
-- Name: runner_enrollments runner_enrollments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: runner_enrollments runner_enrollments_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: runner_enrollments runner_enrollments_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_enrollments
    ADD CONSTRAINT runner_enrollments_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: runner_event_receipts runner_event_receipts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_event_receipts
    ADD CONSTRAINT runner_event_receipts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: runners runners_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runners
    ADD CONSTRAINT runners_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: runs runs_activation_input_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_activation_input_id_fkey FOREIGN KEY (activation_input_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: runs runs_activation_input_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_activation_input_thread_fk FOREIGN KEY (activation_input_id, thread_id) REFERENCES public.messages(id, thread_id) ON DELETE RESTRICT;


--
-- Name: runs runs_actor_principal_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: runs runs_causal_chain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES public.causal_chains(id) ON DELETE RESTRICT;


--
-- Name: runs runs_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: runs runs_harness_instance_environment_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES public.harness_instances(id, environment_id) ON DELETE RESTRICT;


--
-- Name: runs runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: runs runs_seed_input_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_seed_input_id_fkey FOREIGN KEY (seed_input_id) REFERENCES public.messages(id) ON DELETE RESTRICT;


--
-- Name: runs runs_seed_input_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_seed_input_thread_fk FOREIGN KEY (seed_input_id, thread_id) REFERENCES public.messages(id, thread_id) ON DELETE RESTRICT;


--
-- Name: runs runs_terminal_reply_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_terminal_reply_fkey FOREIGN KEY (terminal_reply_message_id, id, thread_id) REFERENCES public.messages(id, run_id, thread_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: runs runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: tab_layouts tab_layouts_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_layouts
    ADD CONSTRAINT tab_layouts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: team_agent_recipients team_agent_recipients_channel_id_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_recipients
    ADD CONSTRAINT team_agent_recipients_channel_id_root_id_fkey FOREIGN KEY (channel_id, root_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_agent_recipients team_agent_recipients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_recipients
    ADD CONSTRAINT team_agent_recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_agent_requests team_agent_requests_channel_id_reply_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_channel_id_reply_message_id_fkey FOREIGN KEY (channel_id, reply_message_id) REFERENCES public.team_messages(channel_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: team_agent_requests team_agent_requests_channel_id_thread_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_channel_id_thread_root_id_fkey FOREIGN KEY (channel_id, thread_root_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_agent_requests team_agent_requests_channel_id_trigger_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_channel_id_trigger_message_id_fkey FOREIGN KEY (channel_id, trigger_message_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_agent_requests team_agent_requests_link_id_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_link_id_owner_user_id_fkey FOREIGN KEY (link_id, owner_user_id) REFERENCES public.team_links(id, owner_user_id);


--
-- Name: team_agent_requests team_agent_requests_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_agent_requests team_agent_requests_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_agent_requests
    ADD CONSTRAINT team_agent_requests_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.team_shares(id);


--
-- Name: team_audit team_audit_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_audit
    ADD CONSTRAINT team_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_audit team_audit_agent_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_audit
    ADD CONSTRAINT team_audit_agent_request_id_fkey FOREIGN KEY (agent_request_id) REFERENCES public.team_agent_requests(id);


--
-- Name: team_audit team_audit_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_audit
    ADD CONSTRAINT team_audit_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.team_links(id);


--
-- Name: team_blobs team_blobs_agent_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_agent_link_id_fkey FOREIGN KEY (agent_link_id) REFERENCES public.team_links(id);


--
-- Name: team_blobs team_blobs_agent_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_agent_request_id_fkey FOREIGN KEY (agent_request_id) REFERENCES public.team_agent_requests(id);


--
-- Name: team_blobs team_blobs_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_blobs team_blobs_remote_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_remote_share_id_fkey FOREIGN KEY (remote_share_id) REFERENCES public.team_shares(id);


--
-- Name: team_blobs team_blobs_uploader_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_blobs
    ADD CONSTRAINT team_blobs_uploader_user_id_fkey FOREIGN KEY (uploader_user_id) REFERENCES public.team_principals(id);


--
-- Name: team_channel_member_state team_channel_member_state_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_member_state
    ADD CONSTRAINT team_channel_member_state_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_channel_member_state team_channel_member_state_channel_id_last_read_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_member_state
    ADD CONSTRAINT team_channel_member_state_channel_id_last_read_message_id_fkey FOREIGN KEY (channel_id, last_read_message_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_channel_member_state team_channel_member_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_member_state
    ADD CONSTRAINT team_channel_member_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_channel_members team_channel_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.team_members(user_id);


--
-- Name: team_channel_members team_channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_channel_members team_channel_members_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_channels team_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channels
    ADD CONSTRAINT team_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: team_channels team_channels_id_latest_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channels
    ADD CONSTRAINT team_channels_id_latest_message_id_fkey FOREIGN KEY (id, latest_message_id) REFERENCES public.team_messages(channel_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: team_group_edges team_group_edges_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_edges
    ADD CONSTRAINT team_group_edges_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.team_members(user_id);


--
-- Name: team_group_edges team_group_edges_child_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_edges
    ADD CONSTRAINT team_group_edges_child_group_id_fkey FOREIGN KEY (child_group_id) REFERENCES public.team_groups(id);


--
-- Name: team_group_edges team_group_edges_parent_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_edges
    ADD CONSTRAINT team_group_edges_parent_group_id_fkey FOREIGN KEY (parent_group_id) REFERENCES public.team_groups(id);


--
-- Name: team_group_people team_group_people_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_people
    ADD CONSTRAINT team_group_people_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.team_members(user_id);


--
-- Name: team_group_people team_group_people_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_people
    ADD CONSTRAINT team_group_people_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.team_groups(id);


--
-- Name: team_group_people team_group_people_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_group_people
    ADD CONSTRAINT team_group_people_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_groups team_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_groups
    ADD CONSTRAINT team_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: team_invite_uses team_invite_uses_invite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invite_uses
    ADD CONSTRAINT team_invite_uses_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES public.team_invites(id);


--
-- Name: team_invite_uses team_invite_uses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invite_uses
    ADD CONSTRAINT team_invite_uses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_invites team_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: team_link_connections team_link_connections_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_link_connections
    ADD CONSTRAINT team_link_connections_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.team_links(id) ON DELETE CASCADE;


--
-- Name: team_links team_links_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_links
    ADD CONSTRAINT team_links_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_members team_members_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: team_mentions team_mentions_channel_id_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_mentions
    ADD CONSTRAINT team_mentions_channel_id_message_id_fkey FOREIGN KEY (channel_id, message_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_mentions team_mentions_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_mentions
    ADD CONSTRAINT team_mentions_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.team_principals(id);


--
-- Name: team_message_attachments team_message_attachments_channel_id_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_attachments
    ADD CONSTRAINT team_message_attachments_channel_id_blob_id_fkey FOREIGN KEY (channel_id, blob_id) REFERENCES public.team_blobs(channel_id, id);


--
-- Name: team_message_attachments team_message_attachments_channel_id_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_attachments
    ADD CONSTRAINT team_message_attachments_channel_id_message_id_fkey FOREIGN KEY (channel_id, message_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_message_pins team_message_pins_channel_id_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_pins
    ADD CONSTRAINT team_message_pins_channel_id_message_id_fkey FOREIGN KEY (channel_id, message_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_message_pins team_message_pins_pinned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_pins
    ADD CONSTRAINT team_message_pins_pinned_by_fkey FOREIGN KEY (pinned_by) REFERENCES public.team_principals(id);


--
-- Name: team_messages team_messages_agent_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_agent_link_id_fkey FOREIGN KEY (agent_link_id) REFERENCES public.team_links(id);


--
-- Name: team_messages team_messages_agent_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_agent_request_id_fkey FOREIGN KEY (agent_request_id) REFERENCES public.team_agent_requests(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: team_messages team_messages_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.team_principals(id);


--
-- Name: team_messages team_messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_messages team_messages_channel_id_thread_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_channel_id_thread_root_id_fkey FOREIGN KEY (channel_id, thread_root_id) REFERENCES public.team_messages(channel_id, id);


--
-- Name: team_note_versions team_note_versions_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_note_versions
    ADD CONSTRAINT team_note_versions_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.team_links(id);


--
-- Name: team_note_versions team_note_versions_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_note_versions
    ADD CONSTRAINT team_note_versions_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.team_notes(id);


--
-- Name: team_note_versions team_note_versions_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_note_versions
    ADD CONSTRAINT team_note_versions_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.team_agent_requests(id);


--
-- Name: team_note_versions team_note_versions_writer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_note_versions
    ADD CONSTRAINT team_note_versions_writer_user_id_fkey FOREIGN KEY (writer_user_id) REFERENCES public.team_principals(id);


--
-- Name: team_notes team_notes_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notes
    ADD CONSTRAINT team_notes_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.team_topics(id);


--
-- Name: team_notices team_notices_audit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notices
    ADD CONSTRAINT team_notices_audit_id_fkey FOREIGN KEY (audit_id) REFERENCES public.team_audit(id);


--
-- Name: team_notices team_notices_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_notices
    ADD CONSTRAINT team_notices_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_outbox team_outbox_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_outbox
    ADD CONSTRAINT team_outbox_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_outbox team_outbox_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_outbox
    ADD CONSTRAINT team_outbox_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.team_messages(id);


--
-- Name: team_outbox team_outbox_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_outbox
    ADD CONSTRAINT team_outbox_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES public.team_notices(id);


--
-- Name: team_partner_calls team_partner_calls_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_calls
    ADD CONSTRAINT team_partner_calls_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.team_partner_links(id) ON DELETE CASCADE;


--
-- Name: team_partner_invites team_partner_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_invites
    ADD CONSTRAINT team_partner_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: team_partner_links team_partner_links_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_links
    ADD CONSTRAINT team_partner_links_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.team_members(user_id);


--
-- Name: team_partner_links team_partner_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_partner_links
    ADD CONSTRAINT team_partner_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: team_principals team_principals_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_principals
    ADD CONSTRAINT team_principals_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_share_asks team_share_asks_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_share_asks team_share_asks_local_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_local_request_id_fkey FOREIGN KEY (local_request_id) REFERENCES public.team_agent_requests(id);


--
-- Name: team_share_asks team_share_asks_reply_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_reply_message_id_fkey FOREIGN KEY (reply_message_id) REFERENCES public.team_messages(id);


--
-- Name: team_share_asks team_share_asks_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.team_shares(id);


--
-- Name: team_share_asks team_share_asks_target_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_target_principal_id_fkey FOREIGN KEY (target_principal_id) REFERENCES public.team_principals(id);


--
-- Name: team_share_asks team_share_asks_thread_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_thread_root_id_fkey FOREIGN KEY (thread_root_id) REFERENCES public.team_messages(id);


--
-- Name: team_share_asks team_share_asks_trigger_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_asks
    ADD CONSTRAINT team_share_asks_trigger_message_id_fkey FOREIGN KEY (trigger_message_id) REFERENCES public.team_messages(id);


--
-- Name: team_share_participants team_share_participants_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_participants
    ADD CONSTRAINT team_share_participants_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.team_principals(id);


--
-- Name: team_share_participants team_share_participants_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_participants
    ADD CONSTRAINT team_share_participants_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.team_shares(id);


--
-- Name: team_share_relays team_share_relays_agent_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_relays
    ADD CONSTRAINT team_share_relays_agent_link_id_fkey FOREIGN KEY (agent_link_id) REFERENCES public.team_links(id);


--
-- Name: team_share_relays team_share_relays_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_relays
    ADD CONSTRAINT team_share_relays_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_share_relays team_share_relays_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_share_relays
    ADD CONSTRAINT team_share_relays_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.team_shares(id);


--
-- Name: team_shares team_shares_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.team_members(user_id);


--
-- Name: team_shares team_shares_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id);


--
-- Name: team_shares team_shares_history_from_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_history_from_share_id_fkey FOREIGN KEY (history_from_share_id) REFERENCES public.team_shares(id);


--
-- Name: team_shares team_shares_offered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_offered_by_fkey FOREIGN KEY (offered_by) REFERENCES public.team_members(user_id);


--
-- Name: team_shares team_shares_partner_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_shares
    ADD CONSTRAINT team_shares_partner_link_id_fkey FOREIGN KEY (partner_link_id) REFERENCES public.team_partner_links(id);


--
-- Name: team_topic_grants team_topic_grants_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topic_grants
    ADD CONSTRAINT team_topic_grants_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.team_members(user_id);


--
-- Name: team_topic_grants team_topic_grants_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topic_grants
    ADD CONSTRAINT team_topic_grants_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.team_members(user_id);


--
-- Name: team_topic_grants team_topic_grants_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topic_grants
    ADD CONSTRAINT team_topic_grants_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.team_topics(id);


--
-- Name: team_topics team_topics_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_topics
    ADD CONSTRAINT team_topics_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.team_members(user_id);


--
-- Name: thread_inputs thread_inputs_actor_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_actor_principal_id_fkey FOREIGN KEY (actor_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: thread_inputs thread_inputs_causal_chain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES public.causal_chains(id) ON DELETE RESTRICT;


--
-- Name: thread_inputs thread_inputs_message_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_message_thread_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.messages(id, thread_id) ON DELETE CASCADE;


--
-- Name: thread_inputs thread_inputs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: thread_inputs thread_inputs_run_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_run_thread_fk FOREIGN KEY (run_id, thread_id) REFERENCES public.runs(id, thread_id) ON DELETE RESTRICT;


--
-- Name: thread_inputs thread_inputs_steer_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_inputs
    ADD CONSTRAINT thread_inputs_steer_command_id_fkey FOREIGN KEY (steer_command_id) REFERENCES public.commands(id) ON DELETE SET NULL;


--
-- Name: thread_visits thread_visits_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_visits
    ADD CONSTRAINT thread_visits_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: thread_visits thread_visits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_visits
    ADD CONSTRAINT thread_visits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: threads threads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: threads threads_created_by_principal_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_created_by_principal_fk FOREIGN KEY (created_by_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;


--
-- Name: threads threads_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: threads threads_harness_instance_environment_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES public.harness_instances(id, environment_id) ON DELETE RESTRICT;


--
-- Name: threads threads_last_reply_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_last_reply_message_id_fkey FOREIGN KEY (last_reply_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: threads threads_lineage_root_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_lineage_root_fk FOREIGN KEY (lineage_root_thread_id) REFERENCES public.threads(id);


--
-- Name: threads threads_parent_lineage_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_parent_lineage_fk FOREIGN KEY (parent_thread_id, lineage_root_thread_id) REFERENCES public.threads(id, lineage_root_thread_id);


--
-- Name: tool_calls tool_calls_attempt_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_attempt_id_run_id_fkey FOREIGN KEY (attempt_id, run_id) REFERENCES public.run_attempts(id, run_id) ON DELETE CASCADE;


--
-- Name: tool_calls tool_calls_node_id_run_id_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_node_id_run_id_attempt_id_fkey FOREIGN KEY (node_id, run_id, attempt_id) REFERENCES public.execution_nodes(id, run_id, attempt_id) ON DELETE CASCADE;


--
-- Name: tool_calls tool_calls_run_id_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_run_id_thread_id_fkey FOREIGN KEY (run_id, thread_id) REFERENCES public.runs(id, thread_id) ON DELETE CASCADE;


--
-- Name: tool_calls tool_calls_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: tool_output_images tool_output_images_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_output_images
    ADD CONSTRAINT tool_output_images_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.execution_nodes(id) ON DELETE CASCADE;


--
-- Name: tool_output_images tool_output_images_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_output_images
    ADD CONSTRAINT tool_output_images_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: tool_output_images tool_output_images_tool_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_output_images
    ADD CONSTRAINT tool_output_images_tool_call_id_fkey FOREIGN KEY (tool_call_id) REFERENCES public.tool_calls(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_attempt_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_attempt_id_run_id_fkey FOREIGN KEY (attempt_id, run_id) REFERENCES public.run_attempts(id, run_id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.delegations(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_execution_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_execution_node_id_fkey FOREIGN KEY (execution_node_id) REFERENCES public.execution_nodes(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_message_id_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_message_id_thread_id_fkey FOREIGN KEY (message_id, thread_id) REFERENCES public.messages(id, thread_id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_node_id_run_id_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_node_id_run_id_attempt_id_fkey FOREIGN KEY (node_id, run_id, attempt_id) REFERENCES public.execution_nodes(id, run_id, attempt_id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_run_id_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_run_id_thread_id_fkey FOREIGN KEY (run_id, thread_id) REFERENCES public.runs(id, thread_id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: transcript_items transcript_items_tool_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_items
    ADD CONSTRAINT transcript_items_tool_call_id_fkey FOREIGN KEY (tool_call_id) REFERENCES public.tool_calls(id) ON DELETE CASCADE;


--
-- Name: trigger_control_requests trigger_control_requests_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_control_requests
    ADD CONSTRAINT trigger_control_requests_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES public.trigger_occurrences(id) ON DELETE CASCADE;


--
-- Name: trigger_occurrences trigger_occurrences_causal_chain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES public.causal_chains(id) ON DELETE RESTRICT;


--
-- Name: trigger_occurrences trigger_occurrences_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.commands(id) ON DELETE RESTRICT;


--
-- Name: trigger_occurrences trigger_occurrences_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: trigger_occurrences trigger_occurrences_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.trigger_revisions(id) ON DELETE RESTRICT;


--
-- Name: trigger_occurrences trigger_occurrences_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: trigger_occurrences trigger_occurrences_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_occurrences
    ADD CONSTRAINT trigger_occurrences_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.triggers(id) ON DELETE CASCADE;


--
-- Name: trigger_revisions trigger_revisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: trigger_revisions trigger_revisions_created_by_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_created_by_thread_id_fkey FOREIGN KEY (created_by_thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: trigger_revisions trigger_revisions_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.triggers(id) ON DELETE CASCADE;


--
-- Name: trigger_watch_activations trigger_watch_activations_anchor_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_anchor_thread_id_fkey FOREIGN KEY (anchor_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: trigger_watch_activations trigger_watch_activations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: trigger_watch_activations trigger_watch_activations_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: trigger_watch_activations trigger_watch_activations_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.trigger_revisions(id) ON DELETE RESTRICT;


--
-- Name: trigger_watch_activations trigger_watch_activations_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: trigger_watch_activations trigger_watch_activations_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.triggers(id) ON DELETE CASCADE;


--
-- Name: trigger_watch_activations trigger_watch_activations_trigger_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_trigger_revision_fk FOREIGN KEY (trigger_id, revision_id) REFERENCES public.trigger_revisions(trigger_id, id) ON DELETE RESTRICT;


--
-- Name: triggers triggers_anchor_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_anchor_thread_id_fkey FOREIGN KEY (anchor_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: triggers triggers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: triggers triggers_created_by_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_created_by_thread_id_fkey FOREIGN KEY (created_by_thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: triggers triggers_current_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_current_revision_fk FOREIGN KEY (id, current_revision_id) REFERENCES public.trigger_revisions(trigger_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: watch_control_requests watch_control_requests_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_control_requests
    ADD CONSTRAINT watch_control_requests_activation_id_fkey FOREIGN KEY (activation_id) REFERENCES public.trigger_watch_activations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: kysely_migration; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.kysely_migration VALUES ('0002_personal_team_baseline', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0003_browser_source_binding', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0004_thread_visits', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0005_thread_input_fresh_context', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0006_team_knowledge_notes', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0007_team_reusable_invites', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0008_devices', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0009_device_access_requests', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0010_device_setup_retirement', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0011_team_agent_contracts', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0012_team_agent_asks', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0013_personal_team_posts', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0014_claude_idle_compaction', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0015_team_principals', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0016_team_partner_links', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0017_team_channel_shares', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0018_team_share_files', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0019_team_shared_agents', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0020_team_share_file_cache', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0021_team_share_relay_policy', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0022_person_names', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0023_agent_home_settings', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0024_waiting_input_edits', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0025_team_copies', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0026_tabs_and_apps', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0027_message_origin', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0028_device_drivers', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0029_changed_since_indexes', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0030_drop_specialists_contract', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0031_plugin_host', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0032_plugin_oauth', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0033_drop_service_integrations_contract', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0034_unify_local_plugin_access_contract', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0035_drop_stored_definition_api_key', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0036_one_plugin_per_owner_name', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0037_plugin_package_format', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0038_personal_current_state', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0039_task_approval_receipts', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0040_answered_question_records', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0041_drop_device_access_count_contract', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0042_browser_session_open_tabs', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0043_inline_transcript_messages', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0044_stopped_runs_are_not_news', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0045_thread_done_by', '2026-01-01T00:00:00.000Z');
INSERT INTO public.kysely_migration VALUES ('0046_run_provider_retry', '2026-01-01T00:00:00.000Z');


--
-- Data for Name: kysely_migration_lock; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.kysely_migration_lock VALUES ('migration_lock', 0);


--
-- PostgreSQL database dump complete
--


