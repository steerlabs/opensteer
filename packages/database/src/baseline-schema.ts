/** Final PostgreSQL schema for a fresh Opensteer beta deployment. */
export const BASELINE_SCHEMA_SQL = String.raw`
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET check_function_bodies = false;


--
-- Name: opensteer_bump_all_integration_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_bump_all_integration_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        insert into integration_authority_generations (owner_user_id, generation, updated_at)
        select id, 1, now() from users
        on conflict (owner_user_id) do update
        set generation = integration_authority_generations.generation + 1,
            updated_at = excluded.updated_at;
        return null;
      end
      $$;


--
-- Name: opensteer_bump_integration_owner_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_bump_integration_owner_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      declare authority_owner_id text;
      begin
        authority_owner_id := case when tg_op = 'DELETE' then old.owner_user_id else new.owner_user_id end;
        insert into integration_authority_generations (owner_user_id, generation, updated_at)
        values (authority_owner_id, 1, now())
        on conflict (owner_user_id) do update
        set generation = integration_authority_generations.generation + 1,
            updated_at = excluded.updated_at;
        if tg_op = 'DELETE' then
          return old;
        end if;
        return new;
      end
      $$;


--
-- Name: opensteer_bump_provider_integration_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_bump_provider_integration_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: opensteer_enforce_command_execution_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_command_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
        if new.thread_id is null
           or new.environment_id is null
           or not exists (
             select 1 from threads thread
             where thread.id = new.thread_id
               and thread.environment_id = new.environment_id
               and opensteer_user_can_execute_thread(thread.id, new.requested_by)
           ) then
          raise exception 'command requester cannot execute the thread environment';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_run_execution_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_run_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from threads thread
          join workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = new.requested_by
           and membership.state = 'active'
           and membership.generation = new.membership_generation
          where thread.id = new.thread_id
            and thread.environment_id = new.environment_id
            and thread.harness_instance_id = new.harness_instance_id
            and opensteer_user_can_execute_thread(thread.id, new.requested_by)
        ) then
          raise exception 'run requester cannot execute the thread environment';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_thread_capability_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_thread_capability_profile() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: opensteer_enforce_thread_execution_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_thread_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from workspace_memberships membership
          where membership.workspace_id = new.workspace_id
            and membership.user_id = new.created_by
            and membership.state = 'active'
        ) then
          raise exception 'thread creator must be an active workspace member';
        end if;
        if not opensteer_user_can_execute_environment(new.environment_id, new.created_by) then
          raise exception 'thread creator cannot execute on the selected environment';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_thread_membership_and_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_thread_membership_and_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      declare
        parent_workspace_id text;
      begin
        if not exists (
          select 1
          from workspace_memberships
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
        from threads
        where threads.id = new.parent_thread_id;
        if parent_workspace_id is null then
          raise exception 'parent thread does not exist';
        end if;
        if not exists (
          select 1
          from workspace_memberships
          where workspace_id = parent_workspace_id
            and user_id = new.created_by
            and state = 'active'
        ) then
          raise exception 'thread creator must be a member of both parent and child workspaces';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_trigger_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_trigger_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from threads thread
          where thread.id = new.anchor_thread_id
            and thread.workspace_id = new.workspace_id
            and opensteer_user_can_execute_thread(thread.id, new.created_by)
        ) then
          raise exception 'trigger creator cannot execute the anchor thread environment';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_trigger_occurrence_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_trigger_occurrence_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1
          from triggers trigger
          join threads thread on thread.id = trigger.anchor_thread_id
          where trigger.id = new.trigger_id
            and (
              trigger.status = 'active'
              or (trigger.status = 'paused' and new.event #>> '{source,kind}' = 'manual')
            )
            and trigger.current_revision_id = new.revision_id
            and thread.environment_id = new.environment_id
            and opensteer_user_can_execute_thread(thread.id, trigger.created_by)
        ) then
          raise exception 'trigger occurrence cannot execute the anchor thread environment';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_enforce_trigger_revision_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_enforce_trigger_revision_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from triggers trigger
          where trigger.id = new.trigger_id
            and trigger.created_by = new.created_by
        ) then
          raise exception 'trigger revision creator does not own the trigger';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_prevent_bound_environment_reassignment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_bound_environment_reassignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.runner_id is distinct from old.runner_id
           and exists (select 1 from threads where environment_id = old.id) then
          raise exception 'a thread-bound execution environment cannot change runners';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_prevent_last_workspace_owner_removal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_last_workspace_owner_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if old.state = 'active'
           and old.role = 'owner'
           and (
             tg_op = 'DELETE'
             or new.state is distinct from 'active'
             or new.role is distinct from 'owner'
           ) then
          perform 1 from workspaces where id = old.workspace_id for update;
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
      end;
      $$;


--
-- Name: opensteer_prevent_runner_owner_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_runner_owner_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.owner_kind is distinct from old.owner_kind
           or new.owner_user_id is distinct from old.owner_user_id then
          raise exception 'runner execution ownership is immutable';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_prevent_thread_binding_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_thread_binding_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.environment_id is distinct from old.environment_id
           or new.parent_thread_id is distinct from old.parent_thread_id
           or new.workspace_id is distinct from old.workspace_id
           or new.created_by is distinct from old.created_by then
          raise exception 'thread ownership, execution environment, and lineage are immutable';
        end if;
        if old.continuation_identity is not null
           and new.continuation_identity is distinct from old.continuation_identity then
          raise exception 'thread provider continuation identity is immutable once established';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_prevent_trigger_authority_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_trigger_authority_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.anchor_thread_id is distinct from old.anchor_thread_id
           or new.workspace_id is distinct from old.workspace_id
           or new.created_by is distinct from old.created_by then
          raise exception 'trigger execution authority is immutable';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_prevent_workspace_kind_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_prevent_workspace_kind_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.kind is distinct from old.kind then
          raise exception 'workspace kind is immutable';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_project_auth_account_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_project_auth_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if tg_op = 'DELETE' then
          if old.password is null then
            perform opensteer_set_account_directory_projection(
              old.provider_id,
              old.account_id,
              old.user_id,
              false
            );
          end if;
          return old;
        end if;
        if tg_op = 'UPDATE' and (
          old.provider_id is distinct from new.provider_id or
          old.account_id is distinct from new.account_id or
          old.user_id is distinct from new.user_id
        ) and old.password is null then
          perform opensteer_set_account_directory_projection(
            old.provider_id,
            old.account_id,
            old.user_id,
            false
          );
        end if;
        perform opensteer_refresh_account_directory_user(new.user_id);
        return new;
      end
      $$;


--
-- Name: opensteer_project_membership_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_project_membership_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if tg_op = 'DELETE' then
          perform opensteer_refresh_account_directory_user(old.user_id);
          return old;
        end if;
        if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
          perform opensteer_refresh_account_directory_user(old.user_id);
        end if;
        perform opensteer_refresh_account_directory_user(new.user_id);
        return new;
      end
      $$;


--
-- Name: opensteer_project_user_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_project_user_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if tg_op = 'DELETE' then
          update account_directory_projections
          set present = false,
              generation = generation + 1,
              attempts = 0,
              next_attempt_at = now(),
              last_error = null,
              lease_token = null,
              lease_expires_at = null,
              updated_at = now()
          where user_id = old.id and present = true;
          return old;
        end if;
        perform opensteer_refresh_account_directory_user(new.id);
        return new;
      end
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
          select 1 from users u
          where u.id = target_user_id
            and u.disabled_at is null
            and exists (
              select 1 from workspace_memberships membership
              where membership.user_id = u.id and membership.state = 'active'
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


--
-- Name: opensteer_require_workspace_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_require_workspace_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1
          from workspace_memberships
          where workspace_id = new.id
            and state = 'active'
            and role = 'owner'
        ) then
          raise exception 'workspace must have at least one active owner';
        end if;
        return new;
      end;
      $$;


--
-- Name: opensteer_set_account_directory_projection(text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_set_account_directory_projection(target_provider_id text, target_account_id text, target_user_id text, target_present boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from account_directory_provider provider
          where provider.singleton_key = 'opensteer-account'
            and provider.provider_id = target_provider_id
        ) then
          return;
        end if;
        insert into account_directory_projections(
          provider_id, account_id, user_id, present, generation,
          published_generation, attempts, next_attempt_at, last_error,
          lease_token, lease_expires_at, updated_at
        ) values (
          target_provider_id, target_account_id, target_user_id, target_present,
          1, 0, 0, now(), null, null, null, now()
        )
        on conflict (provider_id, account_id) do update
        set user_id = excluded.user_id,
            present = excluded.present,
            generation = account_directory_projections.generation + 1,
            attempts = 0,
            next_attempt_at = now(),
            last_error = null,
            lease_token = null,
            lease_expires_at = null,
            updated_at = now()
        where account_directory_projections.present is distinct from excluded.present
           or account_directory_projections.user_id is distinct from excluded.user_id;
      end
      $$;


--
-- Name: opensteer_sync_user_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_sync_user_principal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        insert into principals(id, kind, user_id, display_name)
        values ('pri_' || gen_random_uuid()::text, 'user', new.id, new.display_name)
        on conflict (user_id) where user_id is not null
        do update set display_name = excluded.display_name, updated_at = now();
        return new;
      end
      $$;


--
-- Name: opensteer_user_can_execute_environment(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_user_can_execute_environment(p_environment_id text, p_user_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
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
      $$;


--
-- Name: opensteer_user_can_execute_thread(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opensteer_user_can_execute_thread(p_thread_id text, p_user_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
        select exists (
          select 1
          from threads thread
          join workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = p_user_id
           and membership.state = 'active'
          where thread.id = p_thread_id
            and opensteer_user_can_execute_environment(thread.environment_id, p_user_id)
        )
      $$;




--
-- Name: account_directory_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_directory_projections (
    provider_id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    present boolean NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    published_generation bigint DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_directory_projection_account_check CHECK (((octet_length(account_id) >= 1) AND (octet_length(account_id) <= 1024))),
    CONSTRAINT account_directory_projection_attempts_check CHECK (((attempts >= 0) AND (attempts <= 1000000))),
    CONSTRAINT account_directory_projection_error_check CHECK (((last_error IS NULL) OR ((octet_length(last_error) >= 1) AND (octet_length(last_error) <= 2000)))),
    CONSTRAINT account_directory_projection_generation_check CHECK ((((generation >= 1) AND (generation <= '9007199254740991'::bigint)) AND ((published_generation >= 0) AND (published_generation <= generation)))),
    CONSTRAINT account_directory_projection_lease_check CHECK ((((lease_token IS NULL) AND (lease_expires_at IS NULL)) OR (((octet_length(lease_token) >= 32) AND (octet_length(lease_token) <= 128)) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT account_directory_projection_provider_check CHECK (((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 512)))
);


--
-- Name: account_directory_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_directory_provider (
    singleton_key text DEFAULT 'opensteer-account'::text NOT NULL,
    provider_id text NOT NULL,
    issuer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    projection_revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT account_directory_provider_id_check CHECK (((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 512))),
    CONSTRAINT account_directory_provider_issuer_check CHECK (((issuer ~ '^https?://[^?#]+$'::text) AND (POSITION(('@'::text) IN (issuer)) = 0) AND ((octet_length(issuer) >= 8) AND (octet_length(issuer) <= 2048)))),
    CONSTRAINT account_directory_provider_singleton_check CHECK ((singleton_key = 'opensteer-account'::text))
);


--
-- Name: agent_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_control_requests (
    run_id text NOT NULL,
    request_id uuid NOT NULL,
    source_thread_id text NOT NULL,
    action text NOT NULL,
    action_class text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_control_requests_action_check CHECK ((action = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text]))),
    CONSTRAINT agent_control_requests_action_class_check CHECK ((action_class = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text]))),
    CONSTRAINT agent_control_requests_action_mapping_check CHECK ((action = action_class)),
    CONSTRAINT agent_control_requests_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
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
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_admissions_consumption_check CHECK (((consumed_at IS NULL) = (consumed_by IS NULL))),
    CONSTRAINT auth_admissions_purpose_check CHECK ((purpose = ANY (ARRAY['setup'::text, 'recovery'::text, 'invitation'::text]))),
    CONSTRAINT auth_admissions_reservation_check CHECK (((reserved_at IS NULL) = (reserved_email IS NULL)))
);


--
-- Name: auth_jwks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL,
    CONSTRAINT auth_rate_limits_count_check CHECK ((count >= 0))
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    absolute_expires_at timestamp with time zone NOT NULL,
    device_label text NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_via text,
    account_issuer text,
    account_subject text,
    grant_id text,
    grant_authority_epoch integer,
    CONSTRAINT auth_sessions_deployment_session_provenance_check CHECK ((((created_via IS NULL) AND (account_issuer IS NULL) AND (account_subject IS NULL) AND (grant_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((created_via = 'opensteer-deployment-session'::text) AND (account_issuer IS NOT NULL) AND (account_subject IS NOT NULL) AND (grant_id IS NOT NULL) AND (grant_authority_epoch IS NOT NULL) AND (grant_authority_epoch > 0)))),
    CONSTRAINT auth_sessions_device_label_size_check CHECK (((octet_length(device_label) >= 1) AND (octet_length(device_label) <= 480))),
    CONSTRAINT auth_sessions_expiry_check CHECK (((created_at < expires_at) AND (expires_at <= absolute_expires_at)))
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
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requests (
    id text NOT NULL,
    kind text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    originating_workspace_id text NOT NULL,
    originating_thread_id text NOT NULL,
    originating_run_id text,
    originating_occurrence_id text,
    call_id text NOT NULL,
    target_workspace_id text NOT NULL,
    requested_by text NOT NULL,
    required_actor text NOT NULL,
    presentation jsonb NOT NULL,
    payload jsonb NOT NULL,
    response jsonb,
    response_command_id text,
    cancellation_reason text,
    resolved_at timestamp with time zone,
    resolved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT requests_call_id_check CHECK (((octet_length(call_id) >= 1) AND (octet_length(call_id) <= 512))),
    CONSTRAINT requests_cancellation_reason_check CHECK (((cancellation_reason IS NULL) OR (cancellation_reason = ANY (ARRAY['run-ended'::text, 'process-lost'::text, 'source-closed'::text, 'thread-archived'::text, 'workspace-deleted'::text, 'membership-revoked'::text, 'resource-deleted'::text, 'authority-revoked'::text])))),
    CONSTRAINT requests_id_check CHECK ((id ~ '^req_[0-9a-f-]{36}$'::text)),
    CONSTRAINT requests_kind_check CHECK ((kind = ANY (ARRAY['harness.approval'::text, 'harness.input'::text, 'machine.full-disk-access'::text, 'browser.access'::text, 'browser.profile.save'::text, 'integration.access'::text, 'integration.install'::text]))),
    CONSTRAINT requests_kind_mode_check CHECK ((((kind = ANY (ARRAY['harness.approval'::text, 'harness.input'::text])) AND (mode = 'live'::text)) OR ((kind = ANY (ARRAY['machine.full-disk-access'::text, 'browser.access'::text, 'browser.profile.save'::text, 'integration.access'::text, 'integration.install'::text])) AND (mode = 'durable'::text)))),
    CONSTRAINT requests_mode_check CHECK ((mode = ANY (ARRAY['live'::text, 'durable'::text]))),
    CONSTRAINT requests_origin_check CHECK (((num_nonnulls(originating_run_id, originating_occurrence_id) = 1) AND ((mode <> 'live'::text) OR (originating_run_id IS NOT NULL)))),
    CONSTRAINT requests_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144))),
    CONSTRAINT requests_presentation_check CHECK (((jsonb_typeof(presentation) = 'object'::text) AND (octet_length((presentation)::text) <= 131072))),
    CONSTRAINT requests_required_actor_check CHECK ((required_actor = ANY (ARRAY['requester'::text, 'workspace-owner'::text, 'administrator'::text]))),
    CONSTRAINT requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'fulfilled'::text, 'declined'::text, 'withdrawn'::text, 'cancelled'::text]))),
    CONSTRAINT requests_terminal_check CHECK ((((status = 'pending'::text) AND (response IS NULL) AND (cancellation_reason IS NULL) AND (resolved_at IS NULL) AND (resolved_by IS NULL)) OR ((status = ANY (ARRAY['fulfilled'::text, 'declined'::text])) AND (jsonb_typeof(response) = 'object'::text) AND (response_command_id IS NULL) AND (cancellation_reason IS NULL) AND (resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL)) OR ((status = 'withdrawn'::text) AND (response IS NULL) AND (response_command_id IS NULL) AND (cancellation_reason IS NULL) AND (resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL)) OR ((status = 'cancelled'::text) AND (response IS NULL) AND (response_command_id IS NULL) AND (cancellation_reason IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resolved_by IS NULL))))
);


--
-- Name: integration_request_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_request_details (
    request_id text NOT NULL,
    installation_id text,
    requested_connection_id text,
    requested_server_id text,
    manifest jsonb,
    required_skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT integration_request_details_components_check CHECK (((jsonb_typeof(required_skills) = 'array'::text) AND (jsonb_typeof(required_tools) = 'array'::text) AND ((jsonb_array_length(required_skills) + jsonb_array_length(required_tools)) <= 256) AND ((octet_length((required_skills)::text) + octet_length((required_tools)::text)) <= 131072))),
    CONSTRAINT integration_request_details_manifest_check CHECK (((manifest IS NULL) OR ((jsonb_typeof(manifest) = 'object'::text) AND (octet_length((manifest)::text) <= 8388608))))
);


--
-- Name: request_continuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_continuations (
    request_id text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    attempted_at timestamp with time zone,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_continuations_reason_check CHECK (((reason IS NULL) OR ((octet_length(reason) >= 1) AND (octet_length(reason) <= 2000)))),
    CONSTRAINT request_continuations_state_check CHECK ((((status = 'waiting'::text) AND (reason IS NULL)) OR ((status = 'queued'::text) AND (attempted_at IS NOT NULL) AND (reason IS NULL)) OR ((status = 'undeliverable'::text) AND (attempted_at IS NOT NULL) AND (reason IS NOT NULL)))),
    CONSTRAINT request_continuations_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'queued'::text, 'undeliverable'::text])))
);


--
-- Name: browser_profile_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profile_grants (
    id text CONSTRAINT grants_id_not_null NOT NULL,
    workspace_id text CONSTRAINT grants_workspace_id_not_null NOT NULL,
    created_by text CONSTRAINT grants_created_by_not_null NOT NULL,
    profile_id text CONSTRAINT grants_browser_profile_id_not_null NOT NULL,
    access text DEFAULT '{}'::jsonb CONSTRAINT grants_policy_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT grants_created_at_not_null NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT browser_profile_grants_access_check CHECK ((access = 'full-control'::text)),
    CONSTRAINT browser_profile_grants_id_check CHECK ((id ~ '^bpg_[0-9a-f-]{36}$'::text))
);


--
-- Name: browser_profile_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profile_revisions (
    profile_id text NOT NULL,
    revision integer NOT NULL,
    ciphertext bytea NOT NULL,
    ciphertext_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT browser_profile_revisions_ciphertext_size_check CHECK (((octet_length(ciphertext) >= 30) AND (octet_length(ciphertext) <= 16777245))),
    CONSTRAINT browser_profile_revisions_digest_check CHECK ((ciphertext_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT browser_profile_revisions_revision_check CHECK ((revision > 0))
);


--
-- Name: browser_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profiles (
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT browser_profiles_revision_check CHECK ((revision >= 0))
);


--
-- Name: browser_session_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_attachments (
    agent_binding_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id text NOT NULL,
    workspace_id text NOT NULL,
    CONSTRAINT browser_session_attachments_binding_size_check CHECK (((octet_length(agent_binding_id) >= 5) AND (octet_length(agent_binding_id) <= 512)))
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id text NOT NULL,
    profile_id text,
    workspace_id text NOT NULL,
    placement_key text NOT NULL,
    runner_id text NOT NULL,
    runtime_id text NOT NULL,
    state text NOT NULL,
    lease_token_hash text,
    lease_generation integer NOT NULL,
    profile_lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    origin text DEFAULT 'workspace'::text NOT NULL,
    CONSTRAINT browser_sessions_lease_generation_check CHECK ((lease_generation > 0)),
    CONSTRAINT browser_sessions_origin_check CHECK ((origin = ANY (ARRAY['agent'::text, 'trigger'::text, 'workspace'::text]))),
    CONSTRAINT browser_sessions_profile_lease_check CHECK ((((state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text])) AND (profile_lease_expires_at IS NULL)) OR ((state = ANY (ARRAY['closed'::text, 'failed'::text])) AND (profile_lease_expires_at IS NOT NULL)))),
    CONSTRAINT browser_sessions_state_check CHECK ((state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text, 'closed'::text, 'failed'::text])))
);


--
-- Name: causal_chains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.causal_chains (
    id text NOT NULL,
    root_message_id text,
    root_occurrence_id text,
    used_delegations integer DEFAULT 0 NOT NULL,
    max_delegations integer NOT NULL,
    used_autonomous_runs integer DEFAULT 0 NOT NULL,
    max_autonomous_runs integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    root_watch_activation_id text,
    root_watch_observation_id text,
    CONSTRAINT causal_chains_delegation_budget_check CHECK (((used_delegations >= 0) AND (max_delegations > 0) AND (used_delegations <= max_delegations))),
    CONSTRAINT causal_chains_root_check CHECK (((num_nonnulls(root_message_id, root_occurrence_id, root_watch_activation_id) = 1) AND ((root_watch_activation_id IS NULL) = (root_watch_observation_id IS NULL)))),
    CONSTRAINT causal_chains_run_budget_check CHECK (((used_autonomous_runs >= 0) AND (max_autonomous_runs > 0) AND (used_autonomous_runs <= max_autonomous_runs)))
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
    status text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    routing_mode text DEFAULT 'shared'::text NOT NULL,
    CONSTRAINT channel_accounts_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT channel_accounts_external_account_id_check CHECK (((octet_length(external_account_id) >= 1) AND (octet_length(external_account_id) <= 2048))),
    CONSTRAINT channel_accounts_routing_mode_check CHECK ((routing_mode = ANY (ARRAY['dedicated'::text, 'shared'::text]))),
    CONSTRAINT channel_accounts_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'needs-attention'::text, 'paused'::text, 'revoked'::text])))
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
    revision integer DEFAULT 1 NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    request_ingress_id text,
    decided_at timestamp with time zone,
    decided_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_access_grants_decision_shape CHECK ((((status = 'pending'::text) AND (decided_at IS NULL) AND (decided_by IS NULL)) OR ((status = ANY (ARRAY['approved'::text, 'declined'::text, 'revoked'::text])) AND (decided_at IS NOT NULL) AND (decided_by IS NOT NULL)))),
    CONSTRAINT channel_access_grants_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT channel_access_grants_external_user_id_check CHECK (((octet_length(external_user_id) >= 1) AND (octet_length(external_user_id) <= 2048))),
    CONSTRAINT channel_access_grants_revision_check CHECK ((revision > 0)),
    CONSTRAINT channel_access_grants_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'revoked'::text])))
);


--
-- Name: channel_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_bindings (
    id text NOT NULL,
    account_id text NOT NULL,
    workspace_id text NOT NULL,
    created_by text NOT NULL,
    selector jsonb NOT NULL,
    execution_policy jsonb NOT NULL,
    access_policy jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_bindings_policy_size CHECK (((octet_length((execution_policy)::text) <= 16384) AND (octet_length((access_policy)::text) <= 65536))),
    CONSTRAINT channel_bindings_revision_check CHECK ((revision > 0)),
    CONSTRAINT channel_bindings_selector_size CHECK ((octet_length((selector)::text) <= 16384)),
    CONSTRAINT channel_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'revoked'::text])))
);


--
-- Name: channel_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_conversations (
    id text NOT NULL,
    account_id text NOT NULL,
    binding_id text NOT NULL,
    binding_revision integer NOT NULL,
    workspace_id text NOT NULL,
    external_scope_id text,
    external_conversation_id text NOT NULL,
    external_thread_id text,
    conversation_type text NOT NULL,
    display_name text,
    active_thread_id text,
    provider_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    external_account_id text NOT NULL,
    CONSTRAINT channel_conversations_binding_revision_check CHECK ((binding_revision > 0)),
    CONSTRAINT channel_conversations_conversation_type_check CHECK ((conversation_type = ANY (ARRAY['dm'::text, 'group'::text, 'channel'::text]))),
    CONSTRAINT channel_conversations_external_account_size CHECK (((octet_length(external_account_id) >= 1) AND (octet_length(external_account_id) <= 2048))),
    CONSTRAINT channel_conversations_external_conversation_id_check CHECK (((octet_length(external_conversation_id) >= 1) AND (octet_length(external_conversation_id) <= 2048)))
);


--
-- Name: channel_conversation_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_conversation_contexts (
    conversation_id text NOT NULL,
    authority_user_id text NOT NULL,
    binding_revision integer NOT NULL,
    active_thread_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_conversation_contexts_binding_revision_check CHECK ((binding_revision > 0))
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
    kind text NOT NULL,
    audience text DEFAULT 'conversation'::text NOT NULL,
    part integer DEFAULT 0 NOT NULL,
    part_count integer DEFAULT 1 NOT NULL,
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
    CONSTRAINT channel_deliveries_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT channel_deliveries_audience_check CHECK ((audience = ANY (ARRAY['conversation'::text, 'actor'::text]))),
    CONSTRAINT channel_deliveries_claim_shape CHECK ((((status = ANY (ARRAY['leased'::text, 'attempt-started'::text])) AND (claim_token_hash IS NOT NULL) AND (claim_owner IS NOT NULL) AND (claim_expires_at IS NOT NULL)) OR ((status <> ALL (ARRAY['leased'::text, 'attempt-started'::text])) AND (claim_token_hash IS NULL) AND (claim_owner IS NULL) AND (claim_expires_at IS NULL)))),
    CONSTRAINT channel_deliveries_content_size CHECK ((octet_length((content)::text) <= 524288)),
    CONSTRAINT channel_deliveries_destination_check CHECK ((num_nonnulls(conversation_id, ingress_id) = 1)),
    CONSTRAINT channel_deliveries_error_size CHECK (((last_error IS NULL) OR (octet_length(last_error) <= 8000))),
    CONSTRAINT channel_deliveries_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'status'::text]))),
    CONSTRAINT channel_deliveries_part_check CHECK (((part >= 0) AND (part_count >= 1) AND (part < part_count))),
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
    CONSTRAINT channel_identities_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT channel_identities_external_user_id_check CHECK (((octet_length(external_user_id) >= 1) AND (octet_length(external_user_id) <= 2048))),
    CONSTRAINT channel_identities_link_shape CHECK ((((status = 'linked'::text) AND (linked_user_id IS NOT NULL)) OR ((status = 'unlinked'::text) AND (linked_user_id IS NULL)))),
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
    received_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_ingress_claim_shape CHECK ((((status = 'leased'::text) AND (claim_token_hash IS NOT NULL) AND (claim_owner IS NOT NULL) AND (claim_expires_at IS NOT NULL)) OR ((status <> 'leased'::text) AND (claim_token_hash IS NULL) AND (claim_owner IS NULL) AND (claim_expires_at IS NULL)))),
    CONSTRAINT channel_ingress_error_size CHECK (((last_error IS NULL) OR (octet_length(last_error) <= 8000))),
    CONSTRAINT channel_ingress_event_size CHECK ((octet_length((event)::text) <= 524288)),
    CONSTRAINT channel_ingress_events_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT channel_ingress_events_lane_key_check CHECK (((octet_length(lane_key) >= 1) AND (octet_length(lane_key) <= 4096))),
    CONSTRAINT channel_ingress_events_provider_event_id_check CHECK (((octet_length(provider_event_id) >= 1) AND (octet_length(provider_event_id) <= 2048))),
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
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    identity_id text NOT NULL,
    request_ingress_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_link_codes_consumption_check CHECK (((consumed_at IS NULL) = (user_id IS NULL)))
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
    idempotency_key text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    dispatcher_id text,
    last_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    encrypted_request_response bytea,
    request_response_key_version integer,
    CONSTRAINT commands_request_response_envelope_check CHECK ((((encrypted_request_response IS NULL) AND (request_response_key_version IS NULL)) OR ((encrypted_request_response IS NOT NULL) AND ((octet_length(encrypted_request_response) >= 1) AND (octet_length(encrypted_request_response) <= 1048576)) AND (request_response_key_version >= 0)))),
    CONSTRAINT commands_active_environment_check CHECK (((status <> ALL (ARRAY['pending'::text, 'dispatched'::text])) OR (environment_id IS NOT NULL))),
    CONSTRAINT commands_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text])))
);


--
-- Name: credential_access_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential_access_audit (
    id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_id text NOT NULL,
    connection_id text NOT NULL,
    actor_id text NOT NULL,
    runner_id text,
    purpose text NOT NULL,
    CONSTRAINT credential_access_audit_purpose_check CHECK ((purpose = ANY (ARRAY['channel-delivery'::text, 'channel-transport'::text, 'channel-webhook'::text])))
);


--
-- Name: credential_vault_canaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential_vault_canaries (
    key_version integer NOT NULL,
    encrypted_payload bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credential_vault_canaries_encrypted_payload_check CHECK (((octet_length(encrypted_payload) >= 1) AND (octet_length(encrypted_payload) <= 1048576))),
    CONSTRAINT credential_vault_canaries_key_version_check CHECK ((key_version >= 0))
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
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegations (
    id text NOT NULL,
    parent_thread_id text NOT NULL,
    parent_run_id text,
    parent_occurrence_id text,
    child_thread_id text NOT NULL,
    child_run_id text NOT NULL,
    reply_target jsonb,
    result_message_id text,
    result_attempted_at timestamp with time zone,
    result_status text DEFAULT 'pending'::text NOT NULL,
    result_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    parent_watch_activation_id text,
    CONSTRAINT delegations_parent_check CHECK ((num_nonnulls(parent_run_id, parent_occurrence_id, parent_watch_activation_id) = 1)),
    CONSTRAINT delegations_result_check CHECK ((((result_status = 'pending'::text) AND (completed_at IS NULL) AND (result_message_id IS NULL) AND (result_reason IS NULL)) OR ((result_status = 'delivered'::text) AND (completed_at IS NOT NULL) AND (result_message_id IS NOT NULL) AND (result_reason IS NULL)) OR ((result_status = 'undeliverable'::text) AND (completed_at IS NOT NULL) AND (result_message_id IS NULL) AND (result_reason IS NOT NULL))))
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id text NOT NULL,
    singleton_key text DEFAULT 'primary'::text NOT NULL,
    active_host_instance_id text NOT NULL,
    authority_epoch bigint DEFAULT 1 NOT NULL,
    canonical_origin text NOT NULL,
    lifecycle text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deployment_shape jsonb NOT NULL,
    CONSTRAINT deployments_active_host_instance_id_check CHECK ((active_host_instance_id ~ '^hst_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT deployments_authority_epoch_check CHECK (((authority_epoch >= 1) AND (authority_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT deployments_canonical_origin_check CHECK (((canonical_origin ~ '^https?://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (canonical_origin)) = 0) AND ((octet_length(canonical_origin) >= 8) AND (octet_length(canonical_origin) <= 2048)))),
    CONSTRAINT deployments_id_check CHECK ((id ~ '^dep_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT deployments_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['active'::text, 'transferring'::text, 'sealed'::text]))),
    CONSTRAINT deployments_singleton_check CHECK ((singleton_key = 'primary'::text)),
    CONSTRAINT deployments_shape_check CHECK (
      jsonb_typeof(deployment_shape) = 'object'
      AND deployment_shape ?& ARRAY['backing', 'ownerEstablishment', 'tenancy']
      AND deployment_shape - ARRAY['backing', 'ownerEstablishment', 'tenancy'] = '{}'::jsonb
      AND deployment_shape->>'backing' = ANY (ARRAY['local-directory', 'portablefs'])
      AND deployment_shape->>'ownerEstablishment' = ANY (ARRAY['self-claim', 'enrollment'])
      AND deployment_shape->>'tenancy' = ANY (ARRAY['single-user', 'multi-user'])
    )
);


--
-- Name: execution_environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_environments (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    runner_id text,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_environments_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text])))
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
    state_kind text NOT NULL,
    runtime_revision integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    is_default boolean DEFAULT false NOT NULL,
    source_id text NOT NULL,
    CONSTRAINT harness_instances_default_enabled_check CHECK (((NOT is_default) OR (enabled AND (removed_at IS NULL)))),
    CONSTRAINT harness_instances_removed_disabled_check CHECK (((removed_at IS NULL) OR (enabled = false))),
    CONSTRAINT harness_instances_runtime_revision_check CHECK ((runtime_revision >= 1)),
    CONSTRAINT harness_instances_source_id_check CHECK ((source_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)),
    CONSTRAINT harness_instances_state_kind_check CHECK ((state_kind = ANY (ARRAY['ambient'::text, 'isolated'::text])))
);


--
-- Name: host_account_adoption_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_account_adoption_proofs (
    id text NOT NULL,
    credential_hash text NOT NULL,
    deployment_id text NOT NULL,
    host_instance_id text NOT NULL,
    authority_epoch bigint NOT NULL,
    canonical_origin text NOT NULL,
    authorized_by_user_id text NOT NULL,
    authorized_by_session_id text NOT NULL,
    expected_issuer text,
    expected_subject text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    host_key_fingerprint text NOT NULL,
    CONSTRAINT host_account_adoption_proofs_completion_check CHECK (((completed_at IS NULL) OR ((consumed_at IS NOT NULL) AND (completed_at >= consumed_at)))),
    CONSTRAINT host_account_adoption_proofs_consumption_check CHECK (((consumed_at IS NULL) OR ((expected_issuer IS NOT NULL) AND (expected_subject IS NOT NULL)))),
    CONSTRAINT host_account_adoption_proofs_credential_hash_check CHECK ((credential_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT host_account_adoption_proofs_epoch_check CHECK (((authority_epoch >= 1) AND (authority_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT host_account_adoption_proofs_expected_account_check CHECK (((expected_issuer IS NULL) = (expected_subject IS NULL))),
    CONSTRAINT host_account_adoption_proofs_expected_issuer_check CHECK (((expected_issuer IS NULL) OR ((expected_issuer ~ '^https?://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (expected_issuer)) = 0) AND ((octet_length(expected_issuer) >= 8) AND (octet_length(expected_issuer) <= 2048))))),
    CONSTRAINT host_account_adoption_proofs_expected_subject_check CHECK (((expected_subject IS NULL) OR (expected_subject ~ '^acct_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))),
    CONSTRAINT host_account_adoption_proofs_host_instance_check CHECK ((host_instance_id ~ '^hst_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT host_account_adoption_proofs_id_check CHECK ((id ~ '^hap_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT host_account_adoption_proofs_key_fingerprint_check CHECK ((host_key_fingerprint ~ '^sha256:[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT host_account_adoption_proofs_lifetime_check CHECK ((created_at < expires_at)),
    CONSTRAINT host_account_adoption_proofs_origin_check CHECK (((canonical_origin ~ '^https?://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (canonical_origin)) = 0) AND ((octet_length(canonical_origin) >= 8) AND (octet_length(canonical_origin) <= 2048))))
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
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    scopes jsonb NOT NULL
);


--
-- Name: host_oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_oauth_clients (
    id text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    disabled boolean DEFAULT false NOT NULL,
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
    public boolean,
    type text,
    require_pkce boolean,
    reference_id text,
    metadata jsonb,
    CONSTRAINT host_oauth_public_client_check CHECK (((NOT COALESCE(public, false)) OR ((token_endpoint_auth_method = 'none'::text) AND COALESCE(require_pkce, false) AND (type = ANY (ARRAY['native'::text, 'user-agent-based'::text])))))
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
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
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
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    auth_time timestamp with time zone,
    scopes jsonb NOT NULL
);


--
-- Name: integration_application_source_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_application_source_defaults (
    provider text NOT NULL,
    source_kind text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_application_source_defaults_kind_check CHECK ((source_kind = ANY (ARRAY['hosted-oauth'::text, 'deployment-oauth'::text]))),
    CONSTRAINT integration_application_source_defaults_provider_check CHECK ((provider ~ '^[a-z][a-z0-9.-]{0,127}$'::text))
);


--
-- Name: integration_auth_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_auth_attempts (
    id text NOT NULL,
    flow text NOT NULL,
    owner_user_id text NOT NULL,
    state_hash text NOT NULL,
    encrypted_payload bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    launch_ticket_hash text NOT NULL,
    browser_binding_hash text,
    surface text NOT NULL,
    failure_reason text,
    result_connection_id text,
    launched_at timestamp with time zone,
    CONSTRAINT integration_auth_attempts_binding_check CHECK ((((status = 'pending'::text) AND (browser_binding_hash IS NULL)) OR ((status = ANY (ARRAY['launched'::text, 'claimed'::text, 'completed'::text])) AND (browser_binding_hash IS NOT NULL)) OR (status = 'failed'::text))),
    CONSTRAINT integration_auth_attempts_browser_binding_hash_check CHECK (((browser_binding_hash IS NULL) OR ((octet_length(browser_binding_hash) = 43) AND (browser_binding_hash ~ '^[A-Za-z0-9_-]{43}$'::text)))),
    CONSTRAINT integration_auth_attempts_encrypted_payload_check CHECK (((octet_length(encrypted_payload) >= 1) AND (octet_length(encrypted_payload) <= 8388608))),
    CONSTRAINT integration_auth_attempts_encryption_key_version_check CHECK ((encryption_key_version >= 0)),
    CONSTRAINT integration_auth_attempts_failure_check CHECK ((((status = 'failed'::text) AND (failure_reason IS NOT NULL)) OR ((status <> 'failed'::text) AND (failure_reason IS NULL)))),
    CONSTRAINT integration_auth_attempts_failure_reason_check CHECK ((failure_reason = ANY (ARRAY['cancelled'::text, 'denied'::text, 'exchange-failed'::text, 'provider-identity-already-connected'::text]))),
    CONSTRAINT integration_auth_attempts_flow_check CHECK ((flow = ANY (ARRAY['provider-oauth'::text, 'mcp-oauth'::text]))),
    CONSTRAINT integration_auth_attempts_id_check CHECK ((id ~ '^(ioa|imo)_[0-9a-f-]{36}$'::text)),
    CONSTRAINT integration_auth_attempts_launch_ticket_hash_check CHECK (((octet_length(launch_ticket_hash) = 43) AND (launch_ticket_hash ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT integration_auth_attempts_state_hash_check CHECK (((octet_length(state_hash) = 43) AND (state_hash ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT integration_auth_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'launched'::text, 'claimed'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT integration_auth_attempts_surface_check CHECK ((surface = ANY (ARRAY['desktop'::text, 'native'::text, 'web'::text]))),
    CONSTRAINT integration_auth_attempts_timestamps CHECK (((expires_at > created_at) AND (((status = 'pending'::text) AND (launched_at IS NULL) AND (claimed_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'launched'::text) AND (launched_at IS NOT NULL) AND (claimed_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'claimed'::text) AND (launched_at IS NOT NULL) AND (claimed_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (launched_at IS NOT NULL) AND (claimed_at IS NOT NULL) AND (completed_at IS NOT NULL)) OR ((status = 'failed'::text) AND (completed_at IS NULL)))))
);


--
-- Name: integration_authority_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_authority_generations (
    owner_user_id text NOT NULL,
    generation integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_authority_generations_generation_check CHECK ((generation >= 0))
);


--
-- Name: integration_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_connections (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    account_identifier text,
    credential_id text,
    provider text NOT NULL,
    connection_method text NOT NULL,
    status text NOT NULL,
    display_name text NOT NULL,
    external_tenant_id text,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_identity_id text,
    runner_id text,
    transport_kind text,
    credential_generation integer DEFAULT 1 NOT NULL,
    status_detail text,
    connection_kind text NOT NULL,
    provider_application_id text,
    integration_server_id text,
    status_reason text,
    auth_method_id text,
    authorization_digest text,
    granted_scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    integration_definition_id text,
    application_source jsonb,
    computer_access text,
    CONSTRAINT integration_connections_account_identifier_check CHECK (((account_identifier IS NULL) OR ((octet_length(account_identifier) >= 1) AND (octet_length(account_identifier) <= 1280)))),
    CONSTRAINT integration_connections_api_key_application_check CHECK (((connection_method <> 'api-key'::text) OR (provider_application_id IS NULL))),
    CONSTRAINT integration_connections_application_source_check CHECK ((((connection_kind <> 'provider-account'::text) AND (application_source IS NULL)) OR ((connection_kind = 'provider-account'::text) AND (jsonb_typeof(application_source) = 'object'::text) AND
CASE (application_source ->> 'kind'::text)
    WHEN 'api-key'::text THEN ((connection_method = 'api-key'::text) AND (application_source = '{"kind": "api-key"}'::jsonb))
    WHEN 'deployment-oauth'::text THEN ((connection_method = 'managed-oauth'::text) AND (provider_application_id IS NOT NULL) AND ((application_source ->> 'providerApplicationId'::text) = provider_application_id) AND ((application_source ->> 'providerApplicationRevision'::text) ~ '^[1-9][0-9]*$'::text) AND ((application_source ->> 'callbackUrl'::text) ~ '^https?://'::text) AND ((application_source - ARRAY['kind'::text, 'providerApplicationId'::text, 'providerApplicationRevision'::text, 'callbackUrl'::text]) = '{}'::jsonb))
    WHEN 'hosted-oauth'::text THEN ((connection_method = 'managed-oauth'::text) AND (provider_application_id IS NULL) AND ((application_source ->> 'providerApplicationRevision'::text) ~ '^[1-9][0-9]*$'::text) AND ((application_source ->> 'brokerIssuer'::text) ~ '^https://'::text) AND ((application_source - ARRAY['kind'::text, 'providerApplicationRevision'::text, 'brokerIssuer'::text]) = '{}'::jsonb))
    WHEN 'provider-specific'::text THEN ((connection_method = ANY (ARRAY['bring-your-own'::text, 'device'::text])) AND ((application_source ->> 'method'::text) = connection_method) AND ((application_source - ARRAY['kind'::text, 'method'::text]) = '{}'::jsonb))
    ELSE false
END))),
    CONSTRAINT integration_connections_authorization_digest_check CHECK (((connection_kind <> 'provider-account'::text) OR ((authorization_digest IS NOT NULL) AND (octet_length(authorization_digest) = 43) AND (authorization_digest ~ '^[A-Za-z0-9_-]{43}$'::text)))),
    CONSTRAINT integration_connections_computer_access_check CHECK (((computer_access IS NULL) OR (computer_access = ANY (ARRAY['read'::text, 'read-write'::text])))),
    CONSTRAINT integration_connections_connection_method_check CHECK ((connection_method = ANY (ARRAY['api-key'::text, 'managed-oauth'::text, 'bring-your-own'::text, 'computer'::text, 'device'::text]))),
    CONSTRAINT integration_connections_credential_generation_check CHECK ((credential_generation > 0)),
    CONSTRAINT integration_connections_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT integration_connections_external_identity_size CHECK (((external_identity_id IS NULL) OR ((octet_length(external_identity_id) >= 1) AND (octet_length(external_identity_id) <= 2048)))),
    CONSTRAINT integration_connections_external_tenant_size CHECK (((external_tenant_id IS NULL) OR ((octet_length(external_tenant_id) >= 1) AND (octet_length(external_tenant_id) <= 2048)))),
    CONSTRAINT integration_connections_granted_scopes_check CHECK (((jsonb_typeof(granted_scopes) = 'array'::text) AND (octet_length((granted_scopes)::text) <= 131072))),
    CONSTRAINT integration_connections_kind_check CHECK ((connection_kind = ANY (ARRAY['provider-account'::text, 'channel'::text, 'computer'::text, 'mcp-oauth'::text]))),
    CONSTRAINT integration_connections_kind_shape CHECK ((((connection_kind = 'channel'::text) AND (transport_kind IS NOT NULL) AND (integration_server_id IS NULL) AND (auth_method_id IS NULL) AND (integration_definition_id IS NULL) AND (computer_access IS NULL)) OR ((connection_kind = 'provider-account'::text) AND (transport_kind IS NULL) AND (runner_id IS NULL) AND (integration_server_id IS NULL) AND (auth_method_id IS NOT NULL) AND (integration_definition_id IS NOT NULL) AND (computer_access IS NULL)) OR ((connection_kind = 'mcp-oauth'::text) AND (transport_kind IS NULL) AND (runner_id IS NULL) AND (provider_application_id IS NULL) AND (integration_server_id IS NOT NULL) AND (auth_method_id IS NULL) AND (integration_definition_id IS NULL) AND (computer_access IS NULL)) OR ((connection_kind = 'computer'::text) AND (runner_id IS NOT NULL) AND (integration_server_id IS NOT NULL) AND (integration_definition_id IS NOT NULL) AND (computer_access IS NOT NULL) AND (auth_method_id IS NOT NULL) AND (credential_id IS NULL) AND (provider_application_id IS NULL) AND (application_source IS NULL) AND (transport_kind IS NULL) AND (authorization_digest IS NULL) AND (account_identifier IS NULL) AND (external_identity_id IS NULL) AND (external_tenant_id IS NULL)))),
    CONSTRAINT integration_connections_provider_application_check CHECK (((connection_kind <> 'provider-account'::text) OR (connection_method <> 'managed-oauth'::text) OR ((application_source ->> 'kind'::text) = 'hosted-oauth'::text) OR (provider_application_id IS NOT NULL) OR (status = ANY (ARRAY['needs-attention'::text, 'revoked'::text])))),
    CONSTRAINT integration_connections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text, 'needs-attention'::text, 'paused'::text, 'revoked'::text]))),
    CONSTRAINT integration_connections_status_detail_size CHECK (((status_detail IS NULL) OR ((octet_length(status_detail) >= 1) AND (octet_length(status_detail) <= 2000)))),
    CONSTRAINT integration_connections_status_reason_check CHECK (((status_reason IS NULL) OR (status_reason = ANY (ARRAY['configuration'::text, 'credentials'::text, 'permissions'::text, 'transport'::text])))),
    CONSTRAINT integration_connections_transport_kind_check CHECK ((transport_kind = ANY (ARRAY['socket'::text, 'polling'::text])))
);


--
-- Name: integration_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_grants (
    id text NOT NULL,
    workspace_id text NOT NULL,
    owner_user_id text NOT NULL,
    installation_id text NOT NULL,
    connection_id text,
    alias text NOT NULL,
    granted_tools jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    granted_skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT integration_grants_alias_check CHECK (((octet_length(alias) >= 1) AND (octet_length(alias) <= 320))),
    CONSTRAINT integration_grants_components CHECK (((jsonb_typeof(granted_tools) = 'array'::text) AND (jsonb_typeof(granted_skills) = 'array'::text) AND ((jsonb_array_length(granted_tools) >= 0) AND (jsonb_array_length(granted_tools) <= 512)) AND ((jsonb_array_length(granted_skills) >= 0) AND (jsonb_array_length(granted_skills) <= 512)) AND (((jsonb_array_length(granted_tools) + jsonb_array_length(granted_skills)) >= 1) AND ((jsonb_array_length(granted_tools) + jsonb_array_length(granted_skills)) <= 512)) AND ((octet_length((granted_tools)::text) + octet_length((granted_skills)::text)) <= 131072))),
    CONSTRAINT integration_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'needs-reapproval'::text, 'revoked'::text])))
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
    adapter_snapshot jsonb,
    CONSTRAINT integration_installations_adapter_snapshot CHECK (((adapter_snapshot IS NULL) OR ((jsonb_typeof(adapter_snapshot) = 'object'::text) AND (adapter_snapshot ?& ARRAY['adapter'::text, 'config'::text, 'definitionId'::text]) AND ((((adapter_snapshot - 'adapter'::text) - 'config'::text) - 'definitionId'::text) = '{}'::jsonb) AND ((adapter_snapshot ->> 'adapter'::text) = ANY (ARRAY['graphql'::text, 'mcp'::text, 'openapi'::text])) AND (jsonb_typeof((adapter_snapshot -> 'config'::text)) = 'object'::text) AND (jsonb_typeof((adapter_snapshot -> 'definitionId'::text)) = 'string'::text) AND (octet_length((adapter_snapshot)::text) <= 8388608)))),
    CONSTRAINT integration_installations_description_check CHECK ((octet_length(description) <= 16384)),
    CONSTRAINT integration_installations_documents CHECK (((jsonb_typeof(manifest) = 'object'::text) AND (octet_length((manifest)::text) <= 1048576) AND (NOT (manifest ? 'resolvedConfig'::text)) AND ((NOT (manifest ? 'definition'::text)) OR ((jsonb_typeof((manifest -> 'definition'::text)) = 'object'::text) AND (NOT ((manifest -> 'definition'::text) ? 'config'::text)))) AND (NOT COALESCE(((manifest #> '{proposal,source}'::text[]) ? 'content'::text), false)) AND (NOT COALESCE(((provenance -> 'source'::text) ? 'content'::text), false)) AND (jsonb_typeof(provenance) = 'object'::text) AND (octet_length((provenance)::text) <= 65536))),
    CONSTRAINT integration_installations_name_check CHECK ((((octet_length(name) >= 1) AND (octet_length(name) <= 64)) AND (name ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'::text) AND (name !~~ '%--%'::text) AND (name !~~ '%..%'::text))),
    CONSTRAINT integration_installations_revision_check CHECK ((revision > 0)),
    CONSTRAINT integration_installations_source_kind_check CHECK ((source_kind = ANY (ARRAY['built-in'::text, 'agent-plugin'::text, 'proposed'::text, 'remote-mcp'::text]))),
    CONSTRAINT integration_installations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'needs-attention'::text]))),
    CONSTRAINT integration_installations_title_check CHECK (((octet_length(title) >= 1) AND (octet_length(title) <= 640))),
    CONSTRAINT integration_installations_trust_check CHECK ((trust = ANY (ARRAY['built-in'::text, 'verified-publisher'::text, 'administrator-approved'::text]))),
    CONSTRAINT integration_installations_version_check CHECK (((version IS NULL) OR ((octet_length(version) >= 1) AND (octet_length(version) <= 640))))
);


--
-- Name: integration_provider_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_provider_applications (
    id text NOT NULL,
    provider text NOT NULL,
    display_name text NOT NULL,
    client_id text NOT NULL,
    encrypted_secrets bytea NOT NULL,
    encryption_key_version integer CONSTRAINT integration_provider_applicatio_encryption_key_version_not_null NOT NULL,
    owner_user_id text,
    revision integer NOT NULL,
    status text NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_provider_applications_client_id_check CHECK (((octet_length(client_id) >= 1) AND (octet_length(client_id) <= 8192))),
    CONSTRAINT integration_provider_applications_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT integration_provider_applications_encrypted_secrets_check CHECK (((octet_length(encrypted_secrets) >= 1) AND (octet_length(encrypted_secrets) <= 1048576))),
    CONSTRAINT integration_provider_applications_encryption_key_version_check CHECK ((encryption_key_version >= 0)),
    CONSTRAINT integration_provider_applications_provider_format_check CHECK ((((octet_length(provider) >= 1) AND (octet_length(provider) <= 64)) AND (provider ~ '^[a-z][a-z0-9-]*(.[a-z][a-z0-9-]*)*$'::text))),
    CONSTRAINT integration_provider_applications_revision_check CHECK ((revision > 0)),
    CONSTRAINT integration_provider_applications_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: integration_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_servers (
    id text NOT NULL,
    installation_id text NOT NULL,
    name text NOT NULL,
    transport jsonb NOT NULL,
    status text NOT NULL,
    status_detail text,
    tool_generation integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    connection_requirement jsonb DEFAULT '{"kind": "none"}'::jsonb NOT NULL,
    CONSTRAINT integration_servers_documents CHECK (((jsonb_typeof(connection_requirement) = 'object'::text) AND (octet_length((connection_requirement)::text) <= 4096) AND (jsonb_typeof(transport) = 'object'::text) AND (octet_length((transport)::text) <= 1048576))),
    CONSTRAINT integration_servers_name_check CHECK (((octet_length(name) >= 1) AND (octet_length(name) <= 512))),
    CONSTRAINT integration_servers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'needs-attention'::text]))),
    CONSTRAINT integration_servers_status_detail_check CHECK (((status_detail IS NULL) OR ((octet_length(status_detail) >= 1) AND (octet_length(status_detail) <= 4000)))),
    CONSTRAINT integration_servers_tool_generation_check CHECK ((tool_generation >= 0))
);


--
-- Name: integration_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_skills (
    id text NOT NULL,
    installation_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    digest text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_skills_description_check CHECK (((octet_length(description) >= 1) AND (octet_length(description) <= 4096))),
    CONSTRAINT integration_skills_digest_check CHECK (((octet_length(digest) = 43) AND (digest ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT integration_skills_id_check CHECK ((id ~ '^isk_[0-9a-f-]{36}$'::text)),
    CONSTRAINT integration_skills_name_check CHECK (((name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (octet_length(name) <= 64))),
    CONSTRAINT integration_skills_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: integration_tool_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_tool_definitions (
    server_id text NOT NULL,
    connection_id text,
    definitions jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_tool_definitions_document CHECK ((jsonb_typeof(definitions) = 'object'::text) AND (octet_length(definitions::text) <= 8388608))
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
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    definition_names text[] DEFAULT '{}'::text[] NOT NULL,
    target jsonb,
    CONSTRAINT integration_tools_description_check CHECK ((octet_length(description) <= 65536)),
    CONSTRAINT integration_tools_documents CHECK (((jsonb_typeof(input_schema) = 'object'::text) AND (octet_length(input_schema::text) <= 1048576) AND ((output_schema IS NULL) OR ((jsonb_typeof(output_schema) = 'object'::text) AND (octet_length(output_schema::text) <= 1048576))) AND (jsonb_typeof(annotations) = 'object'::text) AND (octet_length(annotations::text) <= 65536))),
    CONSTRAINT integration_tools_name_check CHECK (((octet_length(name) >= 1) AND (octet_length(name) <= 512))),
    CONSTRAINT integration_tools_schema_digest_check CHECK (((octet_length(schema_digest) = 43) AND (schema_digest ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT integration_tools_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT integration_tools_target_check CHECK (((target IS NULL) OR ((jsonb_typeof(target) = 'object'::text) AND (octet_length((target)::text) <= 8388608)))),
    CONSTRAINT integration_tools_title_check CHECK (((octet_length(title) >= 1) AND (octet_length(title) <= 640)))
);


--
-- Name: machine_access_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_access_events (
    id bigint NOT NULL,
    session_id text NOT NULL,
    at timestamp with time zone NOT NULL,
    event jsonb NOT NULL
);


--
-- Name: machine_access_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.machine_access_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: machine_access_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.machine_access_events_id_seq OWNED BY public.machine_access_events.id;


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
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    bytes_in bigint DEFAULT 0 NOT NULL,
    bytes_out bigint DEFAULT 0 NOT NULL,
    CONSTRAINT machine_access_sessions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'ended'::text])))
);


--
-- Name: machine_local_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_local_sessions (
    auth_session_id text NOT NULL,
    established_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_credentials (
    connection_id text NOT NULL,
    encrypted_state bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_credentials_encrypted_state_check CHECK (((octet_length(encrypted_state) >= 1) AND (octet_length(encrypted_state) <= 1048576))),
    CONSTRAINT mcp_oauth_credentials_encryption_key_version_check CHECK ((encryption_key_version >= 0)),
    CONSTRAINT mcp_oauth_credentials_revision_check CHECK ((revision > 0))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_principal_id text NOT NULL,
    sequence bigint NOT NULL,
    kind text NOT NULL,
    author jsonb NOT NULL,
    CONSTRAINT messages_content_size_check CHECK (((jsonb_typeof(content) = 'array'::text) AND (octet_length((content)::text) <= 409600))),
    CONSTRAINT messages_kind_author_check CHECK ((((kind = 'input'::text) AND ((author ->> 'kind'::text) = ANY (ARRAY['human'::text, 'agent'::text, 'trigger'::text, 'watch'::text]))) OR ((kind = ANY (ARRAY['assistant'::text, 'run-result'::text])) AND ((author ->> 'kind'::text) = 'agent'::text)) OR ((kind = 'continuation'::text) AND ((author ->> 'kind'::text) = 'platform'::text)))),
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['input'::text, 'assistant'::text, 'run-result'::text, 'continuation'::text]))),
    CONSTRAINT messages_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: notification_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_checkpoints (
    workspace_id text NOT NULL,
    sequence bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_checkpoints_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_outbox (
    id text NOT NULL,
    workspace_id text NOT NULL,
    sequence bigint NOT NULL,
    event_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    request_id text,
    kind text NOT NULL,
    recipient_account_ids jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_outbox_attempts_check CHECK (((attempts >= 0) AND (attempts <= 1000000))),
    CONSTRAINT notification_outbox_error_check CHECK (((last_error IS NULL) OR ((octet_length(last_error) >= 1) AND (octet_length(last_error) <= 2000)))),
    CONSTRAINT notification_outbox_kind_check CHECK ((kind = ANY (ARRAY['request-opened'::text, 'run-completed'::text, 'run-failed'::text, 'run-interrupted'::text]))),
    CONSTRAINT notification_outbox_lease_check CHECK ((((lease_token IS NULL) AND (lease_expires_at IS NULL)) OR (((octet_length(lease_token) >= 32) AND (octet_length(lease_token) <= 128)) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT notification_outbox_origin_check CHECK ((((kind = 'request-opened'::text) AND (request_id IS NOT NULL)) OR ((kind <> 'request-opened'::text) AND (request_id IS NULL) AND (run_id IS NOT NULL)))),
    CONSTRAINT notification_outbox_recipients_check CHECK (((jsonb_typeof(recipient_account_ids) = 'array'::text) AND (jsonb_array_length(recipient_account_ids) >= 1) AND (jsonb_array_length(recipient_account_ids) <= 256))),
    CONSTRAINT notification_outbox_sequence_check CHECK ((sequence >= 1))
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
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT owner_enrollments_consumption_check CHECK (((consumed_at IS NULL) = (consumed_by IS NULL))),
    CONSTRAINT owner_enrollments_kind_check CHECK ((kind = ANY (ARRAY['initial'::text, 'recovery'::text])))
);


--
-- Name: personal_remote_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_access (
    singleton_key text DEFAULT 'personal'::text NOT NULL,
    mode text DEFAULT 'off'::text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    route_origin text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_access_generation_check CHECK (((generation >= 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT personal_remote_access_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'connect'::text, 'private'::text]))),
    CONSTRAINT personal_remote_access_route_shape_check CHECK ((((mode = 'off'::text) AND (route_origin IS NULL)) OR ((mode <> 'off'::text) AND (route_origin ~ '^https://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (route_origin)) = 0) AND ((octet_length(route_origin) >= 9) AND (octet_length(route_origin) <= 2048))))),
    CONSTRAINT personal_remote_access_singleton_check CHECK ((singleton_key = 'personal'::text))
);


--
-- Name: personal_remote_account_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_account_link (
    singleton_key text DEFAULT 'opensteer-account'::text NOT NULL,
    challenge_id text NOT NULL,
    grant_id text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    linked_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    host_credential text NOT NULL,
    link_generation text NOT NULL,
    CONSTRAINT personal_remote_account_link_challenge_check CHECK ((challenge_id ~ '^phc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT personal_remote_account_link_generation_check CHECK ((link_generation ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT personal_remote_account_link_grant_check CHECK ((grant_id ~ '^phg_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT personal_remote_account_link_host_credential_check CHECK ((host_credential ~ '^osc_[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT personal_remote_account_link_issuer_check CHECK (((issuer ~ '^https://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (issuer)) = 0) AND ((octet_length(issuer) >= 9) AND (octet_length(issuer) <= 2048)))),
    CONSTRAINT personal_remote_account_link_singleton_check CHECK ((singleton_key = 'opensteer-account'::text)),
    CONSTRAINT personal_remote_account_link_subject_check CHECK ((subject ~ '^acct_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))
);


--
-- Name: personal_remote_pairing_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_pairing_codes (
    id text NOT NULL,
    credential_hash text NOT NULL,
    generation bigint NOT NULL,
    issued_by_session_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_pairing_code_consume_check CHECK (((consumed_at IS NULL) OR (consumed_at >= created_at))),
    CONSTRAINT personal_remote_pairing_code_expiry_check CHECK ((created_at < expires_at)),
    CONSTRAINT personal_remote_pairing_code_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT personal_remote_pairing_code_hash_check CHECK ((credential_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_remote_pairing_code_id_check CHECK ((id ~ '^prp_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))
);


--
-- Name: personal_remote_session_grant_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_session_grant_uses (
    grant_id text NOT NULL,
    generation bigint NOT NULL,
    consumed_at timestamp with time zone NOT NULL,
    CONSTRAINT personal_remote_session_grant_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT personal_remote_session_grant_id_check CHECK ((grant_id ~ '^ahs_[0-9a-fA-F-]{36}$'::text))
);


--
-- Name: personal_remote_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_remote_sessions (
    auth_session_id text NOT NULL,
    route_kind text NOT NULL,
    route_generation bigint NOT NULL,
    route_origin text NOT NULL,
    delivery text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_remote_sessions_delivery_check CHECK ((delivery = ANY (ARRAY['cookie'::text, 'header'::text]))),
    CONSTRAINT personal_remote_sessions_generation_check CHECK (((route_generation >= 1) AND (route_generation <= '9007199254740991'::bigint))),
    CONSTRAINT personal_remote_sessions_kind_check CHECK ((route_kind = ANY (ARRAY['connect'::text, 'private'::text]))),
    CONSTRAINT personal_remote_sessions_origin_check CHECK (((route_origin ~ '^https://[^/?#]+$'::text) AND (POSITION(('@'::text) IN (route_origin)) = 0) AND ((octet_length(route_origin) >= 9) AND (octet_length(route_origin) <= 2048))))
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
    CONSTRAINT principals_display_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 640))),
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'channel-identity'::text, 'system'::text]))),
    CONSTRAINT principals_kind_shape_check CHECK ((((kind = 'user'::text) AND (user_id IS NOT NULL)) OR ((kind = ANY (ARRAY['channel-identity'::text, 'system'::text])) AND (user_id IS NULL))))
);


--
-- Name: provider_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_sessions (
    id text NOT NULL,
    thread_id text NOT NULL,
    harness_instance_id text NOT NULL,
    provider_session_reference text,
    runner_id text NOT NULL,
    runner_boot_id text NOT NULL,
    binding_generation integer NOT NULL,
    lease_token_hash text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT provider_sessions_active_status_check CHECK ((active = (status <> 'stopped'::text))),
    CONSTRAINT provider_sessions_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'ready'::text, 'running'::text, 'stopped'::text, 'broken'::text])))
);


--
-- Name: workspace_mounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_mounts (
    id text NOT NULL,
    environment_id text NOT NULL,
    runner_id text NOT NULL,
    workspace_id text NOT NULL,
    volume_id text NOT NULL,
    workspace_backing_generation bigint NOT NULL,
    enrollment_id text NOT NULL,
    authorized_by text NOT NULL,
    membership_generation bigint NOT NULL,
    status text NOT NULL,
    termination_reason text,
    revocation_attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_mounts_attempts_check CHECK ((revocation_attempts >= 0)),
    CONSTRAINT workspace_mounts_membership_generation_check CHECK (((membership_generation >= 1) AND (membership_generation <= '9007199254740991'::bigint))),
    CONSTRAINT workspace_mounts_pending_check CHECK ((((status = 'active'::text) AND (termination_reason IS NULL) AND (next_attempt_at IS NULL)) OR ((status = 'revocation_pending'::text) AND (termination_reason IS NOT NULL) AND (next_attempt_at IS NOT NULL)) OR ((status = ANY (ARRAY['closed'::text, 'revoked'::text, 'expired'::text])) AND (termination_reason IS NOT NULL) AND (next_attempt_at IS NULL)))),
    CONSTRAINT workspace_mounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revocation_pending'::text, 'closed'::text, 'revoked'::text, 'expired'::text]))),
    CONSTRAINT workspace_mounts_workspace_backing_generation_check CHECK (((workspace_backing_generation >= 1) AND (workspace_backing_generation <= '9007199254740991'::bigint)))
);


--
-- Name: runner_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_enrollments (
    id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    created_by text,
    owner_kind text NOT NULL,
    owner_user_id text,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    runner_kind text NOT NULL,
    allowed_modules jsonb DEFAULT '["agents"]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    runner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runner_enrollments_allowed_modules_check CHECK (((jsonb_typeof(allowed_modules) = 'array'::text) AND ((jsonb_array_length(allowed_modules) >= 1) AND (jsonb_array_length(allowed_modules) <= 5)) AND (allowed_modules <@ '["agents", "browser", "integrations", "messaging", "shell"]'::jsonb))),
    CONSTRAINT runner_enrollments_consumption_check CHECK (((consumed_at IS NULL) = (runner_id IS NULL))),
    CONSTRAINT runner_enrollments_deployment_author_check CHECK (((created_by IS NOT NULL) OR (owner_kind = 'deployment'::text))),
    CONSTRAINT runner_enrollments_idempotency_key_size_check CHECK (((octet_length(idempotency_key) >= 1) AND (octet_length(idempotency_key) <= 255))),
    CONSTRAINT runner_enrollments_kind_check CHECK ((runner_kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text]))),
    CONSTRAINT runner_enrollments_name_check CHECK (((char_length(BTRIM(name)) >= 1) AND (char_length(BTRIM(name)) <= 120))),
    CONSTRAINT runner_enrollments_owner_check CHECK ((((runner_kind = 'main'::text) AND (owner_kind = 'deployment'::text) AND (owner_user_id IS NULL)) OR ((runner_kind = 'managed'::text) AND (owner_kind = 'deployment'::text)) OR ((runner_kind = 'local'::text) AND (owner_kind = 'user'::text) AND (owner_user_id IS NOT NULL))))
);


--
-- Name: runners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runners (
    id text NOT NULL,
    owner_kind text NOT NULL,
    owner_user_id text,
    name text NOT NULL,
    kind text NOT NULL,
    public_key_pem text NOT NULL,
    public_key_fingerprint text NOT NULL,
    enrollment_token_hash text NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_modules jsonb DEFAULT '["agents"]'::jsonb NOT NULL,
    module_descriptors jsonb DEFAULT '{}'::jsonb NOT NULL,
    connection_generation bigint DEFAULT 0 NOT NULL,
    max_concurrent_runs integer,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    access_policy jsonb DEFAULT '{"reach": "nobody", "shares": [], "commands": false, "forwarding": false}'::jsonb NOT NULL,
    access_policy_revision integer DEFAULT 1 NOT NULL,
    device jsonb,
    CONSTRAINT runners_agents_capacity_check CHECK (((max_concurrent_runs IS NULL) OR (allowed_modules ? 'agents'::text))),
    CONSTRAINT runners_allowed_modules_check CHECK (((jsonb_typeof(allowed_modules) = 'array'::text) AND ((jsonb_array_length(allowed_modules) >= 1) AND (jsonb_array_length(allowed_modules) <= 5)) AND (allowed_modules <@ '["agents", "browser", "integrations", "messaging", "shell"]'::jsonb))),
    CONSTRAINT runners_connection_generation_check CHECK (((connection_generation >= 0) AND (connection_generation <= '9007199254740991'::bigint))),
    CONSTRAINT runners_device_check CHECK (((device IS NULL) OR (jsonb_typeof(device) = 'object'::text))),
    CONSTRAINT runners_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'local'::text, 'managed'::text]))),
    CONSTRAINT runners_max_concurrency_check CHECK (((max_concurrent_runs IS NULL) OR ((max_concurrent_runs >= 1) AND (max_concurrent_runs <= 1000)))),
    CONSTRAINT runners_module_descriptors_check CHECK (((jsonb_typeof(module_descriptors) = 'object'::text) AND (octet_length((module_descriptors)::text) <= 1048576))),
    CONSTRAINT runners_owner_binding_check CHECK ((((kind = 'main'::text) AND (owner_kind = 'deployment'::text) AND (owner_user_id IS NULL)) OR ((kind = 'managed'::text) AND (owner_kind = 'deployment'::text)) OR ((kind = 'local'::text) AND (owner_kind = 'user'::text) AND (owner_user_id IS NOT NULL)))),
    CONSTRAINT runners_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['deployment'::text, 'user'::text])))
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    thread_id text NOT NULL,
    environment_id text NOT NULL,
    harness_instance_id text NOT NULL,
    requested_by text NOT NULL,
    run_ordinal integer NOT NULL,
    next_runner_ordinal integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    model_selection jsonb NOT NULL,
    membership_generation bigint NOT NULL,
    access_mode text NOT NULL,
    activation_input_id text NOT NULL,
    causal_chain_id text NOT NULL,
    failure jsonb,
    reply_target jsonb,
    seed_input_id text NOT NULL,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    cost_usd numeric(18,8),
    CONSTRAINT runs_access_mode_check CHECK ((access_mode = ANY (ARRAY['approval-required'::text, 'auto-accept-edits'::text, 'auto'::text, 'full-access'::text]))),
    CONSTRAINT runs_cost_usd_check CHECK (((cost_usd IS NULL) OR (cost_usd >= (0)::numeric))),
    CONSTRAINT runs_failure_check CHECK ((((status = 'failed'::text) AND (jsonb_typeof(failure) = 'object'::text)) OR ((status <> 'failed'::text) AND (failure IS NULL)))),
    CONSTRAINT runs_membership_generation_check CHECK (((membership_generation >= 1) AND (membership_generation <= '9007199254740991'::bigint))),
    CONSTRAINT runs_model_selection_shape CHECK (((jsonb_typeof(model_selection) = 'object'::text) AND (jsonb_typeof((model_selection -> 'options'::text)) = 'object'::text) AND ((length((model_selection ->> 'providerId'::text)) >= 1) AND (length((model_selection ->> 'providerId'::text)) <= 100)) AND ((length((model_selection ->> 'modelId'::text)) >= 1) AND (length((model_selection ->> 'modelId'::text)) <= 255)))),
    CONSTRAINT runs_next_runner_ordinal_check CHECK ((next_runner_ordinal >= 0)),
    CONSTRAINT runs_run_ordinal_check CHECK ((run_ordinal >= 0)),
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
    workspace_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    request_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_effects (
    id text NOT NULL,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    membership_generation bigint NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_effects_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT security_effects_kind_check CHECK ((kind = ANY (ARRAY['close-realtime'::text, 'stop-runs'::text, 'revoke-mounts'::text, 'revoke-browser'::text, 'revoke-credentials'::text, 'revoke-triggers'::text]))),
    CONSTRAINT security_effects_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: thread_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_inputs (
    message_id text NOT NULL,
    thread_id text NOT NULL,
    policy text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_by text NOT NULL,
    actor_principal_id text NOT NULL,
    authority_source jsonb NOT NULL,
    membership_generation bigint NOT NULL,
    causal_chain_id text NOT NULL,
    reply_target jsonb,
    run_id text,
    steer_command_id text,
    delivered_at timestamp with time zone,
    cancel_reason text,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_inputs_membership_generation_check CHECK ((membership_generation > 0)),
    CONSTRAINT thread_inputs_policy_check CHECK ((policy = ANY (ARRAY['queue'::text, 'trigger'::text]))),
    CONSTRAINT thread_inputs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'delivered'::text, 'unknown'::text, 'cancelled'::text]))),
    CONSTRAINT thread_inputs_state_shape_check CHECK ((((state = 'pending'::text) AND (run_id IS NULL) AND (steer_command_id IS NULL) AND (delivered_at IS NULL) AND (cancel_reason IS NULL)) OR ((state = 'claimed'::text) AND (run_id IS NOT NULL) AND (delivered_at IS NULL) AND (cancel_reason IS NULL)) OR ((state = 'delivered'::text) AND (run_id IS NOT NULL) AND (delivered_at IS NOT NULL) AND (cancel_reason IS NULL)) OR ((state = 'unknown'::text) AND (run_id IS NOT NULL) AND (steer_command_id IS NOT NULL) AND (delivered_at IS NULL) AND (cancel_reason IS NULL)) OR ((state = 'cancelled'::text) AND (delivered_at IS NULL) AND (cancel_reason IS NOT NULL))))
);


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    id text NOT NULL,
    workspace_id text NOT NULL,
    parent_thread_id text,
    title text NOT NULL,
    environment_id text NOT NULL,
    harness_instance_id text NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capability_profile_id text NOT NULL,
    created_by_principal_id text NOT NULL,
    model_selection jsonb NOT NULL,
    continuation_identity jsonb,
    access_mode text DEFAULT 'full-access'::text NOT NULL,
    lineage_root_thread_id text NOT NULL,
    next_message_sequence bigint DEFAULT 0 NOT NULL,
    next_run_ordinal integer DEFAULT 0 NOT NULL,
    title_source text DEFAULT 'chosen'::text NOT NULL,
    CONSTRAINT threads_title_source_check CHECK ((title_source = ANY (ARRAY['provisional'::text, 'generated'::text, 'chosen'::text]))),
    CONSTRAINT threads_access_mode_check CHECK ((access_mode = ANY (ARRAY['approval-required'::text, 'auto-accept-edits'::text, 'auto'::text, 'full-access'::text]))),
    CONSTRAINT threads_capability_profile_check CHECK ((capability_profile_id = ANY (ARRAY['main'::text, 'workspace'::text, 'delegated'::text]))),
    CONSTRAINT threads_continuation_identity_shape CHECK (((continuation_identity IS NULL) OR ((jsonb_typeof(continuation_identity) = 'object'::text) AND (continuation_identity ?& ARRAY['driverKind'::text, 'continuationKey'::text]) AND (continuation_identity = jsonb_build_object('driverKind', (continuation_identity -> 'driverKind'::text), 'continuationKey', (continuation_identity -> 'continuationKey'::text))) AND (jsonb_typeof((continuation_identity -> 'driverKind'::text)) = 'string'::text) AND (jsonb_typeof((continuation_identity -> 'continuationKey'::text)) = 'string'::text) AND ((length((continuation_identity ->> 'driverKind'::text)) >= 1) AND (length((continuation_identity ->> 'driverKind'::text)) <= 100)) AND ((continuation_identity ->> 'continuationKey'::text) ~ '^runner:v1:[A-Za-z0-9_-]{43}$'::text)))),
    CONSTRAINT threads_lineage_shape_check CHECK (((parent_thread_id IS NOT NULL) OR (lineage_root_thread_id = id))),
    CONSTRAINT threads_model_selection_shape CHECK (((jsonb_typeof(model_selection) = 'object'::text) AND (jsonb_typeof((model_selection -> 'options'::text)) = 'object'::text) AND ((length((model_selection ->> 'providerId'::text)) >= 1) AND (length((model_selection ->> 'providerId'::text)) <= 100)) AND ((length((model_selection ->> 'modelId'::text)) >= 1) AND (length((model_selection ->> 'modelId'::text)) <= 255)))),
    CONSTRAINT threads_next_message_sequence_check CHECK ((next_message_sequence >= 0)),
    CONSTRAINT threads_next_run_ordinal_check CHECK ((next_run_ordinal >= 0)),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'waiting'::text, 'failed'::text, 'archived'::text])))
);


--
-- Name: trigger_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_control_requests (
    occurrence_id text NOT NULL,
    request_id uuid NOT NULL,
    action text NOT NULL,
    action_class text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_control_requests_action_check CHECK ((action = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text]))),
    CONSTRAINT trigger_control_requests_action_class_check CHECK ((action_class = ANY (ARRAY['workspace.inspect'::text, 'workspace.create'::text, 'workspace.mount'::text, 'thread.read'::text, 'thread.list'::text, 'thread.delegate'::text, 'thread.message'::text, 'request.list'::text, 'request.withdraw'::text, 'browser.profile.list'::text, 'browser.profile.save'::text, 'machine.full-disk-access.request'::text, 'browser.access.request'::text, 'browser.session.list'::text, 'browser.session.open'::text, 'browser.session.close'::text, 'trigger.read'::text, 'trigger.write'::text]))),
    CONSTRAINT trigger_control_requests_action_mapping_check CHECK ((action = action_class)),
    CONSTRAINT trigger_control_requests_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: trigger_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_occurrences (
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
    stdout text DEFAULT ''::text NOT NULL,
    stderr text DEFAULT ''::text NOT NULL,
    exit_code integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    causal_chain_id text,
    CONSTRAINT trigger_occurrences_binding_check CHECK ((((status = 'pending'::text) AND (runner_id IS NULL) AND (runner_boot_id IS NULL) AND (started_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'running'::text) AND (runner_id IS NOT NULL) AND (runner_boot_id IS NOT NULL) AND (started_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'canceled'::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT trigger_occurrences_event_size_check CHECK (((jsonb_typeof(event) = 'object'::text) AND (octet_length((event)::text) <= 786432))),
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_revisions_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT trigger_revisions_program_check CHECK (((jsonb_typeof(program) = 'object'::text) AND (octet_length((program)::text) <= 530000))),
    CONSTRAINT trigger_revisions_source_check CHECK (((jsonb_typeof(source) = 'object'::text) AND ((source ->> 'kind'::text) = ANY (ARRAY['schedule'::text, 'webhook'::text, 'watch'::text]))))
);


--
-- Name: triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.triggers (
    id text NOT NULL,
    workspace_id text NOT NULL,
    anchor_thread_id text NOT NULL,
    created_by text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    next_fire_at timestamp with time zone,
    webhook_route_key text,
    webhook_secret_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_revision_id text NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    pause_reason text,
    CONSTRAINT triggers_kind_check CHECK ((kind = ANY (ARRAY['schedule'::text, 'webhook'::text, 'watch'::text]))),
    CONSTRAINT triggers_name_size_check CHECK (((octet_length(name) >= 1) AND (octet_length(name) <= 640))),
    CONSTRAINT triggers_pause_reason_check CHECK (((pause_reason IS NULL) OR (status = 'paused'::text))),
    CONSTRAINT triggers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text]))),
    CONSTRAINT triggers_webhook_shape_check CHECK ((((kind = 'webhook'::text) AND (webhook_route_key IS NOT NULL) AND (webhook_secret_hash IS NOT NULL) AND (next_fire_at IS NULL)) OR ((kind = 'schedule'::text) AND (webhook_route_key IS NULL) AND (webhook_secret_hash IS NULL)) OR ((kind = 'watch'::text) AND (webhook_route_key IS NULL) AND (webhook_secret_hash IS NULL) AND (next_fire_at IS NULL))))
);


--
-- Name: trigger_watch_reconcile_generation; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trigger_watch_reconcile_generation;


--
-- Name: trigger_watch_activations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_watch_activations (
    id text NOT NULL,
    trigger_id text NOT NULL,
    revision_id text NOT NULL,
    environment_id text NOT NULL,
    workspace_id text NOT NULL,
    anchor_thread_id text NOT NULL,
    created_by text NOT NULL,
    desired text NOT NULL,
    observed text NOT NULL,
    execution_generation bigint DEFAULT 0 NOT NULL,
    runner_id text,
    runner_boot_id text,
    runner_connection_generation bigint,
    restart_count integer DEFAULT 0 NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    healthy_since timestamp with time zone,
    last_exit_code integer,
    last_error text,
    stdout_tail text DEFAULT ''::text NOT NULL,
    stderr_tail text DEFAULT ''::text NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trigger_watch_activations_counters_check CHECK (((execution_generation >= 0) AND (restart_count >= 0) AND (consecutive_failures >= 0) AND ((runner_connection_generation IS NULL) OR (runner_connection_generation > 0)))),
    CONSTRAINT trigger_watch_activations_desired_check CHECK ((desired = ANY (ARRAY['active'::text, 'stopped'::text]))),
    CONSTRAINT trigger_watch_activations_log_bounds_check CHECK (((octet_length(stdout_tail) <= 16384) AND (octet_length(stderr_tail) <= 16384))),
    CONSTRAINT trigger_watch_activations_observed_check CHECK ((observed = ANY (ARRAY['starting'::text, 'running'::text, 'backoff'::text, 'expired'::text, 'stopped'::text])))
);


--
-- Name: watch_control_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_control_requests (
    activation_id text NOT NULL,
    observation_id text NOT NULL,
    request_id text NOT NULL,
    action text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watch_control_requests_action_check CHECK ((action = ANY (ARRAY['thread.delegate'::text, 'thread.message'::text])))
);


--
-- Name: user_execution_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_execution_preferences (
    user_id text NOT NULL,
    preferences jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    display_name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    instance_role text DEFAULT 'user'::text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_display_name_size_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 480))),
    CONSTRAINT users_instance_role_check CHECK ((instance_role = ANY (ARRAY['administrator'::text, 'user'::text]))),
    CONSTRAINT users_normalized_email_check CHECK (((email = lower(email)) AND ((octet_length(email) >= 3) AND (octet_length(email) <= 320))))
);


--
-- Name: workspace_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_events (
    sequence bigint NOT NULL,
    event_id text NOT NULL,
    workspace_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    environment_id text NOT NULL,
    runner_ordinal integer,
    runner_id text,
    runner_boot_id text,
    runner_binding_generation integer,
    type text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT workspace_events_data_size_check CHECK ((octet_length((data)::text) <= 507904)),
    CONSTRAINT workspace_events_runner_identity_check CHECK ((num_nonnulls(runner_ordinal, runner_id, runner_boot_id, runner_binding_generation) = ANY (ARRAY[0, 4])))
);


--
-- Name: workspace_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invitations (
    id text NOT NULL,
    workspace_id text NOT NULL,
    selector text NOT NULL,
    token_hash text NOT NULL,
    type text NOT NULL,
    intended_email text,
    role text NOT NULL,
    created_by text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by text,
    revoked_at timestamp with time zone,
    revoked_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_invitations_email_check CHECK ((((type = 'email'::text) AND (intended_email IS NOT NULL) AND (intended_email = lower(intended_email))) OR ((type = 'link'::text) AND (intended_email IS NULL)))),
    CONSTRAINT workspace_invitations_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'collaborator'::text]))),
    CONSTRAINT workspace_invitations_terminal_check CHECK (((num_nonnulls(accepted_at, revoked_at) <= 1) AND ((accepted_at IS NULL) = (accepted_by IS NULL)) AND ((revoked_at IS NULL) = (revoked_by IS NULL)))),
    CONSTRAINT workspace_invitations_type_check CHECK ((type = ANY (ARRAY['email'::text, 'link'::text])))
);


--
-- Name: workspace_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_memberships (
    id text NOT NULL,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    invited_by text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_memberships_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT workspace_memberships_revocation_check CHECK ((((state = 'active'::text) AND (revoked_at IS NULL) AND (revoked_by IS NULL)) OR ((state = 'revoked'::text) AND (revoked_at IS NOT NULL) AND (revoked_by IS NOT NULL)))),
    CONSTRAINT workspace_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'collaborator'::text]))),
    CONSTRAINT workspace_memberships_state_check CHECK ((state = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'provisioning'::text NOT NULL,
    event_sequence bigint DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_error_code text,
    storage_error_message text,
    storage_error_retryable boolean DEFAULT false NOT NULL,
    storage_error_at timestamp with time zone,
    kind text DEFAULT 'specialized'::text NOT NULL,
    backing jsonb NOT NULL,
    capacity_policy jsonb NOT NULL,
    deletion_requested_at timestamp with time zone,
    deletion_requested_by text,
    purge_after timestamp with time zone,
    deleted_at timestamp with time zone,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_environment_id text GENERATED ALWAYS AS ((backing ->> 'ownerEnvironmentId'::text)) STORED,
    CONSTRAINT workspaces_backing_capacity_policy_match_check CHECK (((((backing ->> 'kind'::text) = 'local-directory'::text) AND ((capacity_policy ->> 'kind'::text) = 'host-filesystem'::text)) OR (((backing ->> 'kind'::text) = 'portablefs'::text) AND ((capacity_policy ->> 'kind'::text) = 'hard-quota'::text)))),
    CONSTRAINT workspaces_backing_shape_check CHECK (((jsonb_typeof(backing) = 'object'::text) AND (jsonb_typeof((backing -> 'generation'::text)) = 'number'::text) AND ((backing ->> 'generation'::text) ~ '^[0-9]+$'::text) AND (((backing ->> 'generation'::text))::numeric >= (1)::numeric) AND (((backing ->> 'generation'::text))::numeric <= ('9007199254740991'::bigint::numeric)) AND ((((backing ->> 'kind'::text) = 'portablefs'::text) AND (backing ?& ARRAY['kind'::text, 'serviceId'::text, 'volumeId'::text, 'generation'::text]) AND (backing = jsonb_build_object('kind', (backing -> 'kind'::text), 'serviceId', (backing -> 'serviceId'::text), 'volumeId', (backing -> 'volumeId'::text), 'generation', (backing -> 'generation'::text))) AND ((length((backing ->> 'serviceId'::text)) >= 1) AND (length((backing ->> 'serviceId'::text)) <= 255)) AND ((backing ->> 'serviceId'::text) ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'::text) AND ((length((backing ->> 'volumeId'::text)) >= 1) AND (length((backing ->> 'volumeId'::text)) <= 220)) AND ((backing ->> 'volumeId'::text) ~ '^[A-Za-z0-9_-]+$'::text)) OR (((backing ->> 'kind'::text) = 'local-directory'::text) AND (backing ?& ARRAY['kind'::text, 'bindingId'::text, 'ownerEnvironmentId'::text, 'storageAuthorityId'::text, 'generation'::text]) AND (backing = jsonb_build_object('kind', (backing -> 'kind'::text), 'bindingId', (backing -> 'bindingId'::text), 'ownerEnvironmentId', (backing -> 'ownerEnvironmentId'::text), 'storageAuthorityId', (backing -> 'storageAuthorityId'::text), 'generation', (backing -> 'generation'::text))) AND ((backing ->> 'bindingId'::text) ~ '^wbd_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'::text) AND ((backing ->> 'ownerEnvironmentId'::text) ~ '^env_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'::text) AND (((backing -> 'storageAuthorityId'::text) = 'null'::jsonb) OR ((backing ->> 'storageAuthorityId'::text) ~ '^sta_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'::text)))))),
    CONSTRAINT workspaces_capacity_policy_shape_check CHECK (((jsonb_typeof(capacity_policy) = 'object'::text) AND ((capacity_policy = '{"kind": "host-filesystem"}'::jsonb) OR (((capacity_policy ->> 'kind'::text) = 'hard-quota'::text) AND (capacity_policy ?& ARRAY['kind'::text, 'blockHardLimitBytes'::text, 'inodeHardLimit'::text]) AND (capacity_policy = jsonb_build_object('kind', (capacity_policy -> 'kind'::text), 'blockHardLimitBytes', (capacity_policy -> 'blockHardLimitBytes'::text), 'inodeHardLimit', (capacity_policy -> 'inodeHardLimit'::text))) AND ((capacity_policy ->> 'blockHardLimitBytes'::text) ~ '^[0-9]+$'::text) AND ((((capacity_policy ->> 'blockHardLimitBytes'::text))::numeric >= (1)::numeric) AND (((capacity_policy ->> 'blockHardLimitBytes'::text))::numeric <= ('9007199254740991'::bigint)::numeric)) AND ((capacity_policy ->> 'inodeHardLimit'::text) ~ '^[0-9]+$'::text) AND ((((capacity_policy ->> 'inodeHardLimit'::text))::numeric >= (1)::numeric) AND (((capacity_policy ->> 'inodeHardLimit'::text))::numeric <= ('9007199254740991'::bigint)::numeric)))))),
    CONSTRAINT workspaces_deletion_state_check CHECK ((((status = 'deleting'::text) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NOT NULL) AND (purge_after IS NOT NULL) AND (deleted_at IS NULL)) OR ((status = 'deleted'::text) AND (deleted_at IS NOT NULL)) OR ((status <> ALL (ARRAY['deleting'::text, 'deleted'::text])) AND (deletion_requested_at IS NULL) AND (deletion_requested_by IS NULL) AND (purge_after IS NULL) AND (deleted_at IS NULL)))),
    CONSTRAINT workspaces_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'specialized'::text]))),
    CONSTRAINT workspaces_status_check CHECK ((status = ANY (ARRAY['provisioning'::text, 'ready'::text, 'archiving'::text, 'archived'::text, 'unavailable'::text, 'failed'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT workspaces_storage_error_shape_check CHECK ((((storage_error_code IS NULL) AND (storage_error_message IS NULL) AND (storage_error_at IS NULL) AND (storage_error_retryable = false)) OR ((storage_error_code = ANY (ARRAY['manager-allocation-rejected'::text, 'manager-configuration-invalid'::text, 'manager-identity-rejected'::text, 'manager-protocol-error'::text, 'manager-unavailable'::text, 'manager-unknown-volume-state'::text, 'local-authority-mismatch'::text, 'local-authority-unavailable'::text, 'local-directory-inaccessible'::text, 'local-directory-missing'::text, 'local-directory-replaced'::text, 'local-registry-invalid'::text])) AND (storage_error_message IS NOT NULL) AND ((octet_length(storage_error_message) >= 1) AND (octet_length(storage_error_message) <= 2000)) AND (storage_error_at IS NOT NULL))))
);


--
-- Name: machine_access_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_access_events ALTER COLUMN id SET DEFAULT nextval('public.machine_access_events_id_seq'::regclass);


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
-- Name: agent_control_requests agent_control_requests_primary; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_control_requests
    ADD CONSTRAINT agent_control_requests_primary PRIMARY KEY (run_id, request_id);


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
-- Name: browser_profile_revisions browser_profile_revisions_primary; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_revisions
    ADD CONSTRAINT browser_profile_revisions_primary PRIMARY KEY (profile_id, revision);


--
-- Name: browser_profiles browser_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profiles
    ADD CONSTRAINT browser_profiles_pkey PRIMARY KEY (id);


--
-- Name: browser_session_attachments browser_session_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_attachments
    ADD CONSTRAINT browser_session_attachments_pkey PRIMARY KEY (agent_binding_id);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: causal_chains causal_chains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.causal_chains
    ADD CONSTRAINT causal_chains_pkey PRIMARY KEY (id);


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
-- Name: channel_access_grants channel_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_access_grants
    ADD CONSTRAINT channel_access_grants_pkey PRIMARY KEY (binding_id, external_user_id);


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
-- Name: channel_conversation_contexts channel_conversation_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversation_contexts
    ADD CONSTRAINT channel_conversation_contexts_pkey PRIMARY KEY (conversation_id, authority_user_id);


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
-- Name: delegations delegations_result_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_result_message_id_key UNIQUE (result_message_id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_singleton_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_singleton_key_key UNIQUE (singleton_key);


--
-- Name: execution_environments execution_environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_environments
    ADD CONSTRAINT execution_environments_pkey PRIMARY KEY (id);


--
-- Name: browser_profile_grants grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_grants
    ADD CONSTRAINT grants_pkey PRIMARY KEY (id);


--
-- Name: harness_catalogs harness_catalogs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_catalogs
    ADD CONSTRAINT harness_catalogs_pkey PRIMARY KEY (environment_id, harness_instance_id);


--
-- Name: harness_instances harness_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_instances
    ADD CONSTRAINT harness_instances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.harness_instances
    ADD CONSTRAINT harness_instances_id_environment_key UNIQUE (id, environment_id);


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
-- Name: host_oauth_access_tokens host_oauth_access_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_token_key UNIQUE (token);


--
-- Name: host_oauth_clients host_oauth_clients_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_clients
    ADD CONSTRAINT host_oauth_clients_client_id_key UNIQUE (client_id);


--
-- Name: host_oauth_clients host_oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_clients
    ADD CONSTRAINT host_oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: host_oauth_clients host_oauth_clients_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_clients
    ADD CONSTRAINT host_oauth_clients_reference_id_key UNIQUE (reference_id);


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
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_token_key UNIQUE (token);




--
-- Name: integration_application_source_defaults integration_application_source_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_application_source_defaults
    ADD CONSTRAINT integration_application_source_defaults_pkey PRIMARY KEY (provider);


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
-- Name: integration_provider_applications integration_provider_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_provider_applications
    ADD CONSTRAINT integration_provider_applications_pkey PRIMARY KEY (id);


--
-- Name: integration_provider_applications integration_provider_applications_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_provider_applications_shared_provider_key
    ON public.integration_provider_applications USING btree (provider)
    WHERE (owner_user_id IS NULL);

CREATE INDEX integration_provider_applications_owner_provider_idx
    ON public.integration_provider_applications USING btree (owner_user_id, provider)
    WHERE (owner_user_id IS NOT NULL);


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
-- Name: integration_skills integration_skills_installation_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_skills
    ADD CONSTRAINT integration_skills_installation_id_name_key UNIQUE (installation_id, name);


--
-- Name: integration_skills integration_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_skills
    ADD CONSTRAINT integration_skills_pkey PRIMARY KEY (id);


--
-- Name: integration_tool_definitions integration_tool_definitions_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tool_definitions
    ADD CONSTRAINT integration_tool_definitions_scope UNIQUE NULLS NOT DISTINCT (server_id, connection_id);


--
-- Name: integration_tools integration_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_tools
    ADD CONSTRAINT integration_tools_pkey PRIMARY KEY (id);


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
-- Name: machine_local_sessions machine_local_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_local_sessions
    ADD CONSTRAINT machine_local_sessions_pkey PRIMARY KEY (auth_session_id);


--
-- Name: mcp_oauth_credentials mcp_oauth_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_credentials
    ADD CONSTRAINT mcp_oauth_credentials_pkey PRIMARY KEY (connection_id);


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
-- Name: notification_checkpoints notification_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_checkpoints
    ADD CONSTRAINT notification_checkpoints_pkey PRIMARY KEY (workspace_id);


--
-- Name: notification_outbox notification_outbox_event_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_event_unique UNIQUE (event_id);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


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
-- Name: workspace_mounts workspace_mounts_enrollment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_enrollment_id_key UNIQUE (enrollment_id);


--
-- Name: workspace_mounts workspace_mounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_pkey PRIMARY KEY (id);


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
-- Name: security_effects security_effects_membership_generation_kind_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_effects
    ADD CONSTRAINT security_effects_membership_generation_kind_unique UNIQUE (workspace_id, user_id, membership_generation, kind);


--
-- Name: security_effects security_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_effects
    ADD CONSTRAINT security_effects_pkey PRIMARY KEY (id);



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
-- Name: trigger_control_requests trigger_control_requests_primary; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_control_requests
    ADD CONSTRAINT trigger_control_requests_primary PRIMARY KEY (occurrence_id, request_id);


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
-- Name: trigger_watch_activations trigger_watch_activations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_pkey PRIMARY KEY (id);


--
-- Name: watch_control_requests watch_control_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_control_requests
    ADD CONSTRAINT watch_control_requests_pkey PRIMARY KEY (activation_id, observation_id);


--
-- Name: user_execution_preferences user_execution_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_execution_preferences
    ADD CONSTRAINT user_execution_preferences_pkey PRIMARY KEY (user_id);


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
-- Name: workspace_events workspace_events_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_event_id_key UNIQUE (event_id);


--
-- Name: workspace_events workspace_events_primary; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_primary PRIMARY KEY (workspace_id, sequence);


--
-- Name: workspace_invitations workspace_invitations_creator_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_creator_idempotency_unique UNIQUE (created_by, idempotency_key);


--
-- Name: workspace_invitations workspace_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_selector_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_selector_key UNIQUE (selector);


--
-- Name: workspace_invitations workspace_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: workspace_memberships workspace_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (id);


--
-- Name: workspace_memberships workspace_memberships_workspace_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_user_unique UNIQUE (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: account_directory_projections_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_directory_projections_pending ON public.account_directory_projections USING btree (provider_id, next_attempt_at, updated_at) WHERE (published_generation < generation);


--
-- Name: agent_control_requests_run_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_control_requests_run_class ON public.agent_control_requests USING btree (run_id, action_class);


--
-- Name: auth_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_accounts_user ON public.auth_accounts USING btree (user_id);


--
-- Name: auth_admissions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_admissions_expiry ON public.auth_admissions USING btree (expires_at);


--
-- Name: auth_sessions_user_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_expiry ON public.auth_sessions USING btree (user_id, expires_at DESC);


--
-- Name: auth_verifications_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verifications_identifier ON public.auth_verifications USING btree (identifier);





--
-- Name: browser_profile_grants_active_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX browser_profile_grants_active_identity ON public.browser_profile_grants USING btree (workspace_id, created_by, profile_id) WHERE (revoked_at IS NULL);


--
-- Name: browser_session_attachments_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_session_attachments_session ON public.browser_session_attachments USING btree (session_id);


--
-- Name: browser_sessions_active_profile_placement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_active_profile_placement ON public.browser_sessions USING btree (profile_id, placement_key) WHERE (state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text]));


--
-- Name: browser_sessions_active_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_active_workspace ON public.browser_sessions USING btree (workspace_id, created_at DESC) WHERE (state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text]));


--
-- Name: browser_sessions_runner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_sessions_runner ON public.browser_sessions USING btree (runner_id, state);


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
-- Name: channel_bindings_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_bindings_workspace ON public.channel_bindings USING btree (workspace_id, status);


--
-- Name: channel_conversations_external_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_conversations_external_unique ON public.channel_conversations USING btree (provider, external_account_id, external_scope_id, external_conversation_id, external_thread_id) NULLS NOT DISTINCT;


--
-- Name: channel_conversations_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_conversations_workspace ON public.channel_conversations USING btree (workspace_id, updated_at DESC);


--
-- Name: channel_conversation_contexts_active_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_conversation_contexts_active_thread ON public.channel_conversation_contexts USING btree (active_thread_id) WHERE (active_thread_id IS NOT NULL);


--
-- Name: channel_deliveries_attention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_attention ON public.channel_deliveries USING btree (account_id, status) WHERE (status = ANY (ARRAY['unknown'::text, 'dead'::text]));


--
-- Name: channel_deliveries_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_retention ON public.channel_deliveries USING btree (updated_at) WHERE (status = ANY (ARRAY['sent'::text, 'dead'::text]));


--
-- Name: channel_deliveries_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_deliveries_claimable ON public.channel_deliveries USING btree (COALESCE(conversation_id, ingress_id), created_at, part) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text, 'attempt-started'::text, 'retryable-failed'::text, 'unknown'::text]));


--
-- Name: channel_deliveries_message_reply_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_deliveries_message_reply_unique ON public.channel_deliveries USING btree (message_id, part) WHERE ((kind = 'reply'::text) AND (message_id IS NOT NULL));


--
-- Name: channel_identities_linked_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_identities_linked_user ON public.channel_identities USING btree (linked_user_id) WHERE (linked_user_id IS NOT NULL);


--
-- Name: channel_ingress_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_ingress_claimable ON public.channel_ingress_events USING btree (next_attempt_at, received_at) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text]));


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
-- Name: commands_environment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commands_environment_active ON public.commands USING btree (environment_id) WHERE (status = ANY (ARRAY['pending'::text, 'dispatched'::text]));


--
-- Name: credential_access_audit_credential_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credential_access_audit_credential_created ON public.credential_access_audit USING btree (credential_id, created_at DESC);


--
-- Name: host_account_adoption_proofs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_account_adoption_proofs_pending ON public.host_account_adoption_proofs USING btree (authorized_by_user_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: host_oauth_access_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_access_client ON public.host_oauth_access_tokens USING btree (client_id);


--
-- Name: host_oauth_access_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_access_refresh ON public.host_oauth_access_tokens USING btree (refresh_id);


--
-- Name: host_oauth_access_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_access_session ON public.host_oauth_access_tokens USING btree (session_id);


--
-- Name: host_oauth_access_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_access_user ON public.host_oauth_access_tokens USING btree (user_id);


--
-- Name: host_oauth_clients_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_clients_user ON public.host_oauth_clients USING btree (user_id);


--
-- Name: host_oauth_consents_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_consents_client ON public.host_oauth_consents USING btree (client_id);


--
-- Name: host_oauth_consents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_consents_user ON public.host_oauth_consents USING btree (user_id);


--
-- Name: host_oauth_refresh_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_refresh_client ON public.host_oauth_refresh_tokens USING btree (client_id);


--
-- Name: host_oauth_refresh_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_refresh_session ON public.host_oauth_refresh_tokens USING btree (session_id);


--
-- Name: host_oauth_refresh_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_oauth_refresh_user ON public.host_oauth_refresh_tokens USING btree (user_id);




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
-- Name: integration_connections_definition_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_connections_definition_identity_unique ON public.integration_connections USING btree (integration_definition_id, external_tenant_id, external_identity_id) NULLS NOT DISTINCT WHERE ((connection_kind = 'provider-account'::text) AND (external_identity_id IS NOT NULL) AND (status <> 'revoked'::text));


--
-- Name: integration_connections_computer_live_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_connections_computer_live_unique ON public.integration_connections USING btree (integration_definition_id, runner_id) WHERE ((connection_kind = 'computer'::text) AND (status <> 'revoked'::text));


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
-- Name: integration_grants_live_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_grants_live_identity ON public.integration_grants USING btree (workspace_id, owner_user_id, installation_id, connection_id) NULLS NOT DISTINCT WHERE (revoked_at IS NULL);


--
-- Name: integration_grants_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_grants_one_default ON public.integration_grants USING btree (workspace_id, owner_user_id, installation_id) WHERE ((revoked_at IS NULL) AND is_default);


--
-- Name: integration_grants_unique_alias; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_grants_unique_alias ON public.integration_grants USING btree (workspace_id, owner_user_id, installation_id, lower(alias)) WHERE (revoked_at IS NULL);




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
-- Name: harness_instances_one_ambient_per_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_instances_one_ambient_per_driver ON public.harness_instances USING btree (environment_id, driver_kind) WHERE ((state_kind = 'ambient'::text) AND (removed_at IS NULL));


--
-- Name: harness_instances_one_default_per_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX harness_instances_one_default_per_driver ON public.harness_instances USING btree (environment_id, driver_kind) WHERE ((removed_at IS NULL) AND is_default);


--
-- Name: harness_instances_environment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_instances_environment ON public.harness_instances USING btree (environment_id, created_at) WHERE (removed_at IS NULL);


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
-- Name: messages_thread_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_thread_recent ON public.messages USING btree (thread_id, created_at DESC, id DESC);


--
-- Name: messages_thread_sequence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_thread_sequence_unique ON public.messages USING btree (thread_id, sequence);


--
-- Name: notification_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_outbox_pending ON public.notification_outbox USING btree (next_attempt_at, created_at) WHERE (published_at IS NULL);


--
-- Name: personal_remote_pairing_codes_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_remote_pairing_codes_pending ON public.personal_remote_pairing_codes USING btree (generation, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: personal_remote_sessions_generation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX personal_remote_sessions_generation ON public.personal_remote_sessions USING btree (route_kind, route_generation);


--
-- Name: principals_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX principals_user_unique ON public.principals USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: provider_sessions_one_active_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_sessions_one_active_per_thread ON public.provider_sessions USING btree (thread_id) WHERE active;


--
-- Name: workspace_mounts_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_mounts_pending ON public.workspace_mounts USING btree (next_attempt_at, created_at) WHERE (status = 'revocation_pending'::text);


--
-- Name: workspace_mounts_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_mounts_workspace ON public.workspace_mounts USING btree (workspace_id, status);


--
-- Name: workspace_mounts_environment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_mounts_environment ON public.workspace_mounts USING btree (environment_id, status);


--
-- Name: runners_single_main; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runners_single_main ON public.runners USING btree (kind) WHERE ((kind = 'main'::text) AND (revoked_at IS NULL));


--
-- Name: runs_environment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_environment_active ON public.runs USING btree (environment_id) WHERE (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_one_executing_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_one_executing_per_thread ON public.runs USING btree (thread_id) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'waiting'::text]));


--
-- Name: runs_one_queued_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_one_queued_per_thread ON public.runs USING btree (thread_id) WHERE (status = 'queued'::text);


--
-- Name: security_audit_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_audit_actor_created ON public.security_audit USING btree (actor_user_id, created_at DESC, id DESC);


--
-- Name: security_audit_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_audit_workspace_created ON public.security_audit USING btree (workspace_id, created_at DESC, id DESC);


--
-- Name: security_effects_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_effects_pending ON public.security_effects USING btree (next_attempt_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: causal_chains_watch_observation_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX causal_chains_watch_observation_unique ON public.causal_chains USING btree (root_watch_activation_id, root_watch_observation_id) WHERE (root_watch_activation_id IS NOT NULL);





--
-- Name: thread_inputs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_pending ON public.thread_inputs USING btree (thread_id, created_at, message_id) WHERE (state = 'pending'::text);


--
-- Name: thread_inputs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX thread_inputs_run ON public.thread_inputs USING btree (run_id, created_at, message_id) WHERE (run_id IS NOT NULL);


--
-- Name: threads_lineage_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_lineage_page ON public.threads USING btree (lineage_root_thread_id, updated_at DESC, id DESC);


--
-- Name: threads_parent_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_parent_thread ON public.threads USING btree (parent_thread_id) WHERE (parent_thread_id IS NOT NULL);


--
-- Name: threads_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX threads_workspace_updated ON public.threads USING btree (workspace_id, updated_at DESC, id DESC);


--
-- Name: trigger_control_requests_class_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_control_requests_class_count ON public.trigger_control_requests USING btree (occurrence_id, action_class);


--
-- Name: trigger_occurrences_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_occurrences_recent ON public.trigger_occurrences USING btree (trigger_id, created_at DESC, id DESC);


--
-- Name: trigger_occurrences_running_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_occurrences_running_binding ON public.trigger_occurrences USING btree (runner_id, runner_boot_id) WHERE (status = 'running'::text);


--
-- Name: trigger_watch_activations_environment_desired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_watch_activations_environment_desired ON public.trigger_watch_activations USING btree (environment_id, desired, updated_at, id);


--
-- Name: trigger_watch_activations_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trigger_watch_activations_one_active ON public.trigger_watch_activations USING btree (trigger_id) WHERE (desired = 'active'::text);


--
-- Name: triggers_due_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX triggers_due_schedule ON public.triggers USING btree (next_fire_at, id) WHERE ((status = 'active'::text) AND (kind = 'schedule'::text) AND (next_fire_at IS NOT NULL));


--
-- Name: watch_control_requests_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX watch_control_requests_window ON public.watch_control_requests USING btree (activation_id, created_at);


--
-- Name: workspace_events_runner_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_events_runner_dedup ON public.workspace_events USING btree (run_id, runner_ordinal) WHERE ((run_id IS NOT NULL) AND (runner_ordinal IS NOT NULL));


--
-- Name: workspace_invitations_workspace_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invitations_workspace_active ON public.workspace_invitations USING btree (workspace_id, expires_at) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: workspace_memberships_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_memberships_user_active ON public.workspace_memberships USING btree (user_id, workspace_id) WHERE (state = 'active'::text);


--
-- Name: workspace_memberships_workspace_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_memberships_workspace_active ON public.workspace_memberships USING btree (workspace_id, role, user_id) WHERE (state = 'active'::text);


--
-- Name: workspaces_deletion_purge_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_deletion_purge_due_idx ON public.workspaces USING btree (purge_after, id) WHERE (status = 'deleting'::text);


--
-- Name: workspaces_local_binding_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_local_binding_unique ON public.workspaces USING btree (((backing ->> 'bindingId'::text))) WHERE ((backing ->> 'kind'::text) = 'local-directory'::text);


--
-- Name: workspaces_one_main_per_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_one_main_per_creator ON public.workspaces USING btree (created_by) WHERE (kind = 'main'::text);


--
-- Name: workspaces_owner_environment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_owner_environment_idx ON public.workspaces USING btree (owner_environment_id, status) WHERE (owner_environment_id IS NOT NULL);


--
-- Name: workspaces_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_owner_updated ON public.workspaces USING btree (created_by, updated_at DESC);


--
-- Name: workspaces_portablefs_backing_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_portablefs_backing_unique ON public.workspaces USING btree (((backing ->> 'serviceId'::text)), ((backing ->> 'volumeId'::text))) WHERE ((backing ->> 'kind'::text) = 'portablefs'::text);


--
-- Name: workspaces_status_last_activity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_status_last_activity_idx ON public.workspaces USING btree (status, last_activity_at);


--
-- Name: auth_accounts auth_accounts_account_directory_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_accounts_account_directory_projection AFTER INSERT OR DELETE OR UPDATE ON public.auth_accounts FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_auth_account_change();


--
-- Name: commands commands_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commands_execution_authority BEFORE INSERT OR UPDATE OF type, thread_id, environment_id, requested_by ON public.commands FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_command_execution_authority();


--
-- Name: execution_environments execution_environments_immutable_runner_after_thread; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER execution_environments_immutable_runner_after_thread BEFORE UPDATE OF runner_id ON public.execution_environments FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_bound_environment_reassignment();


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
-- Name: integration_provider_applications integration_provider_applications_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_provider_applications_authority_generation AFTER UPDATE OF status ON public.integration_provider_applications FOR EACH ROW EXECUTE FUNCTION public.opensteer_bump_provider_integration_authority();


--
-- Name: integration_servers integration_servers_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_servers_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_servers FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: integration_skills integration_skills_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_skills_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_skills FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: integration_tools integration_tools_authority_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_tools_authority_generation AFTER INSERT OR DELETE OR UPDATE ON public.integration_tools FOR EACH STATEMENT EXECUTE FUNCTION public.opensteer_bump_all_integration_authority();


--
-- Name: harness_instances harness_instances_immutable_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER harness_instances_immutable_identity BEFORE UPDATE OF environment_id, driver_kind, state_kind, runtime_revision, removed_at ON public.harness_instances FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_harness_instance_identity_change();


--
-- Name: runners runners_immutable_execution_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runners_immutable_execution_owner BEFORE UPDATE OF owner_kind, owner_user_id ON public.runners FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_runner_owner_change();


--
-- Name: runs runs_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_execution_authority BEFORE INSERT OR UPDATE OF thread_id, environment_id, harness_instance_id, requested_by, membership_generation ON public.runs FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_run_execution_authority();


--
-- Name: threads threads_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER threads_execution_authority BEFORE INSERT OR UPDATE OF environment_id, created_by, parent_thread_id ON public.threads FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_thread_execution_authority();


--
-- Name: threads threads_immutable_capability_profile; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER threads_immutable_capability_profile BEFORE INSERT OR UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_thread_capability_profile();


--
-- Name: threads threads_immutable_execution_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER threads_immutable_execution_binding BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_thread_binding_change();


--
-- Name: threads threads_membership_and_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER threads_membership_and_parent BEFORE INSERT OR UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_thread_membership_and_parent();


--
-- Name: trigger_occurrences trigger_occurrences_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_occurrences_execution_authority BEFORE INSERT OR UPDATE OF trigger_id, revision_id, environment_id ON public.trigger_occurrences FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_trigger_occurrence_authority();


--
-- Name: trigger_revisions trigger_revisions_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_revisions_execution_authority BEFORE INSERT OR UPDATE OF trigger_id, created_by ON public.trigger_revisions FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_trigger_revision_authority();


--
-- Name: triggers triggers_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER triggers_execution_authority BEFORE INSERT ON public.triggers FOR EACH ROW EXECUTE FUNCTION public.opensteer_enforce_trigger_authority();


--
-- Name: triggers triggers_immutable_execution_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER triggers_immutable_execution_authority BEFORE UPDATE ON public.triggers FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_trigger_authority_change();


--
-- Name: users users_account_directory_projection_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_account_directory_projection_delete BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_user_change();


--
-- Name: users users_account_directory_projection_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_account_directory_projection_update AFTER UPDATE OF disabled_at ON public.users FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_user_change();


--
-- Name: users users_sync_principal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_sync_principal AFTER INSERT OR UPDATE OF display_name ON public.users FOR EACH ROW EXECUTE FUNCTION public.opensteer_sync_user_principal();


--
-- Name: workspace_memberships workspace_memberships_account_directory_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_memberships_account_directory_projection AFTER INSERT OR DELETE OR UPDATE ON public.workspace_memberships FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_membership_change();


--
-- Name: workspace_memberships workspace_memberships_retain_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_memberships_retain_owner BEFORE DELETE OR UPDATE ON public.workspace_memberships FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_last_workspace_owner_removal();


--
-- Name: workspaces workspaces_immutable_kind; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_immutable_kind BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.opensteer_prevent_workspace_kind_change();


--
-- Name: workspaces workspaces_require_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER workspaces_require_owner AFTER INSERT ON public.workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.opensteer_require_workspace_owner();


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
-- Name: browser_profile_revisions browser_profile_revisions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_revisions
    ADD CONSTRAINT browser_profile_revisions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.browser_profiles(id) ON DELETE CASCADE;


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
-- Name: browser_session_attachments browser_session_attachments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_attachments
    ADD CONSTRAINT browser_session_attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: browser_sessions browser_sessions_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.browser_profiles(id) ON DELETE RESTRICT;


--
-- Name: browser_sessions browser_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


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
-- Name: channel_bindings channel_bindings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


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
-- Name: channel_conversations channel_conversations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversations
    ADD CONSTRAINT channel_conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: channel_conversation_contexts channel_conversation_contexts_active_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversation_contexts
    ADD CONSTRAINT channel_conversation_contexts_active_thread_id_fkey FOREIGN KEY (active_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;


--
-- Name: channel_conversation_contexts channel_conversation_contexts_authority_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversation_contexts
    ADD CONSTRAINT channel_conversation_contexts_authority_user_id_fkey FOREIGN KEY (authority_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: channel_conversation_contexts channel_conversation_contexts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_conversation_contexts
    ADD CONSTRAINT channel_conversation_contexts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.channel_conversations(id) ON DELETE RESTRICT;


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
-- Name: credential_access_audit credential_access_audit_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_access_audit
    ADD CONSTRAINT credential_access_audit_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


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
-- Name: delegations delegations_parent_watch_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_parent_watch_activation_id_fkey FOREIGN KEY (parent_watch_activation_id) REFERENCES public.trigger_watch_activations(id) ON DELETE RESTRICT;


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
-- Name: delegations delegations_result_message_thread_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_result_message_thread_fk FOREIGN KEY (result_message_id, parent_thread_id) REFERENCES public.messages(id, thread_id) ON DELETE RESTRICT;


--
-- Name: execution_environments execution_environments_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_environments
    ADD CONSTRAINT execution_environments_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE SET NULL;


--
-- Name: browser_profile_grants grants_browser_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_grants
    ADD CONSTRAINT grants_browser_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.browser_profiles(id) ON DELETE CASCADE;


--
-- Name: browser_profile_grants grants_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_grants
    ADD CONSTRAINT grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: browser_profile_grants grants_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profile_grants
    ADD CONSTRAINT grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: harness_catalogs harness_catalogs_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_catalogs
    ADD CONSTRAINT harness_catalogs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE CASCADE;


--
-- Name: harness_catalogs harness_catalogs_harness_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
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
-- Name: host_oauth_access_tokens host_oauth_access_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.host_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: host_oauth_access_tokens host_oauth_access_tokens_refresh_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_refresh_id_fkey FOREIGN KEY (refresh_id) REFERENCES public.host_oauth_refresh_tokens(id) ON DELETE CASCADE;


--
-- Name: host_oauth_access_tokens host_oauth_access_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: host_oauth_access_tokens host_oauth_access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_access_tokens
    ADD CONSTRAINT host_oauth_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: host_oauth_clients host_oauth_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_clients
    ADD CONSTRAINT host_oauth_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: host_oauth_consents host_oauth_consents_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_consents
    ADD CONSTRAINT host_oauth_consents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.host_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: host_oauth_consents host_oauth_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_consents
    ADD CONSTRAINT host_oauth_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.host_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: host_oauth_refresh_tokens host_oauth_refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_oauth_refresh_tokens
    ADD CONSTRAINT host_oauth_refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;








--
-- Name: integration_application_source_defaults integration_application_source_defaults_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_application_source_defaults
    ADD CONSTRAINT integration_application_source_defaults_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_auth_attempts integration_auth_attempts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_auth_attempts
    ADD CONSTRAINT integration_auth_attempts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_auth_attempts integration_auth_attempts_result_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_auth_attempts
    ADD CONSTRAINT integration_auth_attempts_result_connection_id_fkey FOREIGN KEY (result_connection_id) REFERENCES public.integration_connections(id) ON DELETE SET NULL;


--
-- Name: integration_authority_generations integration_authority_generations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_authority_generations
    ADD CONSTRAINT integration_authority_generations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: integration_connections integration_connections_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: integration_connections integration_connections_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE RESTRICT;


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
-- Name: integration_connections integration_connections_provider_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_provider_application_id_fkey FOREIGN KEY (provider_application_id) REFERENCES public.integration_provider_applications(id) ON DELETE RESTRICT;


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
-- Name: integration_grants integration_grants_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_grants
    ADD CONSTRAINT integration_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;






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
-- Name: integration_provider_applications integration_provider_applications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_provider_applications
    ADD CONSTRAINT integration_provider_applications_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.integration_provider_applications
    ADD CONSTRAINT integration_provider_applications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: integration_provider_applications integration_provider_applications_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_provider_applications
    ADD CONSTRAINT integration_provider_applications_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: integration_servers integration_servers_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_servers
    ADD CONSTRAINT integration_servers_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;


--
-- Name: integration_skills integration_skills_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_skills
    ADD CONSTRAINT integration_skills_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;


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
-- Name: machine_local_sessions machine_local_sessions_auth_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_local_sessions
    ADD CONSTRAINT machine_local_sessions_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_credentials mcp_oauth_credentials_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_credentials
    ADD CONSTRAINT mcp_oauth_credentials_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.integration_connections(id) ON DELETE RESTRICT;


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
-- Name: notification_checkpoints notification_checkpoints_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_checkpoints
    ADD CONSTRAINT notification_checkpoints_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: notification_outbox notification_outbox_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: owner_enrollments owner_enrollments_consumed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_enrollments
    ADD CONSTRAINT owner_enrollments_consumed_by_fkey FOREIGN KEY (consumed_by) REFERENCES public.users(id) ON DELETE RESTRICT;


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
-- Name: workspace_mounts workspace_mounts_authorized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_mounts workspace_mounts_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: workspace_mounts workspace_mounts_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: workspace_mounts workspace_mounts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_mounts
    ADD CONSTRAINT workspace_mounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


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
-- Name: runs runs_harness_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
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
-- Name: runs runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: security_effects security_effects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_effects
    ADD CONSTRAINT security_effects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: security_effects security_effects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_effects
    ADD CONSTRAINT security_effects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;









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
-- Name: threads threads_harness_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES public.harness_instances(id, environment_id) ON DELETE RESTRICT;


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
-- Name: threads threads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


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
-- Name: trigger_revisions trigger_revisions_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_revisions
    ADD CONSTRAINT trigger_revisions_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.triggers(id) ON DELETE CASCADE;


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
-- Name: triggers triggers_current_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_current_revision_fk FOREIGN KEY (id, current_revision_id) REFERENCES public.trigger_revisions(trigger_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: triggers triggers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


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
-- Name: trigger_watch_activations trigger_watch_activations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_watch_activations
    ADD CONSTRAINT trigger_watch_activations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: user_execution_preferences user_execution_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_execution_preferences
    ADD CONSTRAINT user_execution_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: watch_control_requests watch_control_requests_activation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_control_requests
    ADD CONSTRAINT watch_control_requests_activation_id_fkey FOREIGN KEY (activation_id) REFERENCES public.trigger_watch_activations(id) ON DELETE CASCADE;


--
-- Name: workspace_events workspace_events_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Name: workspace_events workspace_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: workspace_events workspace_events_runner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES public.runners(id) ON DELETE RESTRICT;


--
-- Name: workspace_events workspace_events_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: workspace_events workspace_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invitations workspace_invitations_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitations workspace_invitations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitations workspace_invitations_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitations workspace_invitations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspaces workspaces_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspaces workspaces_owner_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_owner_environment_id_fkey FOREIGN KEY (owner_environment_id) REFERENCES public.execution_environments(id) ON DELETE RESTRICT;


--
-- Unified Request lifecycle constraints and indexes
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);

-- One call identity per origin. Postgres treats NULLs as distinct in a UNIQUE
-- constraint, so each origin column needs its own index restricted to the rows
-- that actually carry it.
CREATE UNIQUE INDEX requests_run_call_identity_unique ON public.requests USING btree (originating_run_id, call_id) WHERE (originating_run_id IS NOT NULL);

CREATE UNIQUE INDEX requests_occurrence_call_identity_unique ON public.requests USING btree (originating_occurrence_id, call_id) WHERE (originating_occurrence_id IS NOT NULL);

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.request_continuations
    ADD CONSTRAINT request_continuations_pkey PRIMARY KEY (request_id);

CREATE INDEX requests_originating_thread_pending ON public.requests USING btree (originating_thread_id, created_at, id) WHERE (status = 'pending'::text);

CREATE INDEX requests_target_workspace_pending ON public.requests USING btree (target_workspace_id, created_at, id) WHERE (status = 'pending'::text);

CREATE INDEX requests_originating_thread_history ON public.requests USING btree (originating_thread_id, created_at, id);

CREATE INDEX requests_target_workspace_history ON public.requests USING btree (target_workspace_id, created_at, id);

CREATE INDEX request_continuations_waiting ON public.request_continuations USING btree (attempted_at NULLS FIRST, created_at, request_id) WHERE (status = 'waiting'::text);

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_workspace_id_fkey FOREIGN KEY (originating_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_thread_id_fkey FOREIGN KEY (originating_thread_id) REFERENCES public.threads(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_run_id_fkey FOREIGN KEY (originating_run_id) REFERENCES public.runs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_originating_occurrence_id_fkey FOREIGN KEY (originating_occurrence_id) REFERENCES public.trigger_occurrences(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_response_command_id_fkey FOREIGN KEY (response_command_id) REFERENCES public.commands(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.integration_installations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.integration_request_details
    ADD CONSTRAINT integration_request_details_requested_server_id_fkey FOREIGN KEY (requested_server_id) REFERENCES public.integration_servers(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.request_continuations
    ADD CONSTRAINT request_continuations_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
`;
