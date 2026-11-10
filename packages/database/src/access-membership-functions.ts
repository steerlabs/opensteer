export const ACCESS_MEMBERSHIP_FUNCTIONS_SQL = `
create or replace function public.opensteer_enforce_run_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from threads thread
          join workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = new.requested_by
           and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id)))
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

create or replace function public.opensteer_enforce_thread_execution_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if not exists (
          select 1 from workspace_memberships membership
          where membership.workspace_id = new.workspace_id
            and membership.user_id = new.created_by
            and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id)))
        ) then
          raise exception 'thread creator must be an active workspace member';
        end if;
        if not opensteer_user_can_execute_environment(new.environment_id, new.created_by) then
          raise exception 'thread creator cannot execute on the selected environment';
        end if;
        return new;
      end;
      $$;

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
           and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id)))
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
                  where membership.user_id = u.id and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id)))
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

create or replace function public.opensteer_user_can_execute_thread(p_thread_id text, p_user_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
        select exists (
          select 1
          from threads thread
          join workspace_memberships membership
            on membership.workspace_id = thread.workspace_id
           and membership.user_id = p_user_id
           and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id)))
          where thread.id = p_thread_id
            and opensteer_user_can_execute_environment(thread.environment_id, p_user_id)
        )
      $$;

create or replace function public.opensteer_enforce_thread_consent() returns trigger language plpgsql as $$
      declare parent public.threads;
      begin
        if tg_op = 'UPDATE' then
          if new.inherits_main is distinct from old.inherits_main then
            raise exception 'thread consent is immutable';
          end if;
          if new.specialist_id is distinct from old.specialist_id then
            raise exception 'specialist binding is immutable';
          end if;
          if new.lineage_root_thread_id is distinct from old.lineage_root_thread_id then
            raise exception 'thread lineage is immutable';
          end if;
          return new;
        end if;
        if new.parent_thread_id is not null then
          select * into parent from public.threads where id = new.parent_thread_id;
          if not found or new.inherits_main is distinct from parent.inherits_main then
            raise exception 'thread consent does not match its lineage';
          end if;
          if parent.specialist_id is not null and new.specialist_id is distinct from parent.specialist_id then
            raise exception 'thread cannot escape its specialist binding';
          end if;
        elsif new.inherits_main and not exists (
          select 1 from public.workspaces workspace
            join public.workspace_memberships membership on membership.workspace_id = workspace.id
          where workspace.id = new.workspace_id and workspace.kind = 'main'
            and workspace.created_by = new.created_by
            and membership.user_id = new.created_by
            and (membership.state = 'active' and ((membership.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(membership.state, membership.effective_until, membership.user_id))) and membership.role = 'owner'
        ) then
          raise exception 'thread consent exceeds its durable authority';
        end if;
        if new.specialist_id is not null then
          if not exists (
            select 1 from public.specialists where id = new.specialist_id
              and workspace_id = new.workspace_id and owner_user_id = new.created_by
              and status = 'ready' and removed_at is null for share
          ) then
            raise exception 'invalid specialist binding';
          end if;
        end if;
        return new;
      end $$;

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
            and (state = 'active' and ((workspace_memberships.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(state, workspace_memberships.effective_until, workspace_memberships.user_id)))
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
            and (state = 'active' and ((workspace_memberships.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(state, workspace_memberships.effective_until, workspace_memberships.user_id)))
        ) then
          raise exception 'thread creator must be a member of both parent and child workspaces';
        end if;
        return new;
      end;
      $function$;

create or replace function public.opensteer_require_workspace_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.kind = 'project' and exists (
          select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'
        ) then return new; end if;
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

create or replace function public.opensteer_prevent_last_workspace_owner_removal()
      returns trigger language plpgsql as $$
      begin
 if exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server')
 and exists (select 1 from public.workspaces where id = old.workspace_id and kind = 'project') then
 return case when tg_op = 'DELETE' then old else new end;
 end if;
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

create or replace function opensteer_legacy_plugin_revision() returns trigger language plpgsql as $$
      declare changed jsonb; consent_owner text; definition_id text; target_kind text;
      begin
        changed := case when TG_OP = 'DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
        if TG_OP = 'UPDATE' then
          if TG_TABLE_NAME = 'specialists' then
            if NEW.plugin_version_id is not distinct from OLD.plugin_version_id and NEW.removed_at is not distinct from OLD.removed_at then return NEW; end if;
          end if;
          if TG_TABLE_NAME = 'integration_grants' and to_jsonb(NEW) is not distinct from to_jsonb(OLD) then return NEW; end if;
        end if;
        if TG_TABLE_NAME = 'plugin_activations' then
          for consent_owner in select user_id from workspace_memberships where workspace_id = changed->>'workspace_id' and (state = 'active' and ((workspace_memberships.effective_until is null and not (select exists (select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server'))) or public.opensteer_membership_is_effective(state, workspace_memberships.effective_until, workspace_memberships.user_id))) order by user_id loop
            perform opensteer_advance_plugin_setting(consent_owner,jsonb_build_object('kind','plugin','pluginId',changed->>'plugin_id'));
          end loop;
        elsif TG_TABLE_NAME = 'specialists' then
          perform opensteer_advance_plugin_setting(changed->>'owner_user_id',jsonb_build_object('kind','specialist','pluginId',changed->>'plugin_id','ownerUserId',changed->>'owner_user_id'));
        else
          select coalesce(manifest->'definition'->>'id',name) into definition_id from integration_installations where id = changed->>'installation_id';
          target_kind := 'service';
          if exists(select 1 from integration_connections where id = changed->>'connection_id' and connection_kind = 'computer') then target_kind := 'device-app'; end if;
          if definition_id is not null then perform opensteer_advance_plugin_setting(changed->>'owner_user_id',jsonb_build_object('kind',target_kind,'definitionId',definition_id)); end if;
        end if;
        return null;
      end $$;
`;
