export const PROJECT_AUTHORITY_GUARDS_SQL = String.raw`
  create or replace function public.opensteer_stored_execution_authority()
    returns table (model integer, kind text)
    language sql stable
    set search_path = pg_catalog
    as $$
      select d.authority_model_version, d.deployment_shape->>'kind'
      from public.deployments d
      where d.singleton_key = 'primary'
    $$;
  create function public.opensteer_project_principal_scope() returns trigger language plpgsql as $$
  begin
    if tg_op = 'UPDATE' and old.kind = 'project' then
      if new.kind is distinct from old.kind or new.workspace_id is distinct from old.workspace_id
         or new.user_id is distinct from old.user_id then
        raise exception 'Project principal identity is immutable' using errcode = '23514';
      end if;
      return new;
    end if;
    if new.kind <> 'project' then return new; end if;
    if not exists (
      select 1 from public.opensteer_stored_execution_authority() d
      where d.model = 2 and d.kind = 'server'
    ) or not exists (
      select 1 from public.workspaces w where w.id = new.workspace_id and w.kind = 'project'
        and w.deleted_at is null and w.status not in ('deleting', 'deleted')
    ) then
      raise exception 'Project principals require server authority model 2 and a live Project' using errcode = '23514';
    end if;
    return new;
  end $$;
  create trigger project_principal_scope before insert or update of kind, workspace_id, user_id on public.principals
    for each row execute function public.opensteer_project_principal_scope();
  create function public.opensteer_project_request_scope() returns trigger language plpgsql as $$
  begin
    if tg_op = 'UPDATE' and old.originating_grant_id is not null then
      if row(new.originating_grant_id, new.originating_run_id, new.originating_occurrence_id,
             new.originating_workspace_id, new.originating_thread_id, new.target_workspace_id,
             new.requested_by, new.required_actor, new.call_id, new.kind, new.mode, new.originating_node_id)
         is distinct from
         row(old.originating_grant_id, old.originating_run_id, old.originating_occurrence_id,
             old.originating_workspace_id, old.originating_thread_id, old.target_workspace_id,
             old.requested_by, old.required_actor, old.call_id, old.kind, old.mode, old.originating_node_id) then
        raise exception 'Project Request origin and audience are immutable' using errcode = '23514';
      end if;
      if old.status <> 'pending' and row(new.status, new.response, new.resolved_by, new.resolved_at, new.cancellation_reason)
         is distinct from row(old.status, old.response, old.resolved_by, old.resolved_at, old.cancellation_reason) then
        raise exception 'A settled Project Request is immutable' using errcode = '23514';
      end if;
      if old.status = 'pending' and new.status in ('fulfilled', 'declined', 'withdrawn') and not exists (
        select 1 from public.grants g join public.runs r on r.id = g.run_id
        join public.workspace_memberships m on m.workspace_id = new.originating_workspace_id
        join public.users u on u.id = m.user_id
        where g.id = new.originating_grant_id and g.status = 'active'
          and g.binding_generation = r.binding_generation and r.status in ('starting', 'running', 'waiting')
          and u.id = new.resolved_by and u.disabled_at is null
          and u.member_state = 'active' and u.admitted_at is not null and m.state = 'active'
          and public.opensteer_project_work_is_valid(r.thread_id, r.actor_principal_id,
            r.requested_by, r.membership_generation, r.initiator_generation, r.origin_connection_id, r.authority_source)
          and ((r.requested_by is not null and u.id = r.requested_by)
            or (r.requested_by is null and m.role = 'owner' and u.member_kind = 'full'))
      ) then
        raise exception 'Project Request resolver is outside its live audience' using errcode = '23514';
      end if;
      return new;
    end if;
    if new.originating_grant_id is null then
      if new.requested_by is null then
        raise exception 'An unattended Request requires a Project grant' using errcode = '23514';
      end if;
      return new;
    end if;
    if tg_op = 'UPDATE' then
      raise exception 'A legacy Request cannot adopt a Project grant' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.grants g
      join public.runs r on r.id = g.run_id
      join public.threads t on t.id = r.thread_id
      join public.principals p on p.id = r.actor_principal_id
      cross join public.opensteer_stored_execution_authority() d
      where g.id = new.originating_grant_id and g.run_id = new.originating_run_id
        and g.status = 'active' and g.binding_generation = r.binding_generation
        and r.status in ('starting', 'running', 'waiting')
        and public.opensteer_project_work_is_valid(r.thread_id, r.actor_principal_id,
          r.requested_by, r.membership_generation, r.initiator_generation, r.origin_connection_id, r.authority_source)
        and p.kind = 'project' and p.workspace_id = t.workspace_id
        and d.model = 2 and d.kind = 'server'
        and new.originating_workspace_id = t.workspace_id
        and new.target_workspace_id = t.workspace_id and new.originating_thread_id = t.id
        and new.originating_occurrence_id is null and new.mode = 'live'
        and new.kind in ('harness.input', 'harness.approval')
        and new.requested_by is not distinct from r.requested_by
        and ((r.requested_by is null and new.required_actor = 'workspace-owner') or
             (r.requested_by is not null and r.initiator_generation is not null
              and new.required_actor = 'requester'))
        and (new.originating_node_id is null or exists (
          select 1 from public.execution_nodes n where n.id = new.originating_node_id
            and n.run_id = r.id and n.attempt_id = g.attempt_id
        ))
    ) then
      raise exception 'Project Request must bind its immutable Run origin and attempt' using errcode = '23514';
    end if;
    return new;
  end $$;
  create trigger project_request_scope before insert or update on public.requests
    for each row execute function public.opensteer_project_request_scope();
  create function public.opensteer_request_grant_identity() returns trigger language plpgsql as $$
  begin
    if row(new.id, new.run_id, new.attempt_id, new.binding_generation, new.runner_id, new.runner_boot_id)
       is distinct from row(old.id, old.run_id, old.attempt_id, old.binding_generation, old.runner_id, old.runner_boot_id)
       then
      if exists (select 1 from public.requests q where q.originating_grant_id = old.id)
         or exists (select 1 from public.commands c where c.originating_grant_id = old.id) then
        raise exception 'A Request retains its original grant identity' using errcode = '23514';
      end if;
    end if;
    return new;
  end $$;
  create trigger request_grant_identity before update on public.grants
    for each row execute function public.opensteer_request_grant_identity();

  create function public.opensteer_user_can_execute_environment(p_environment_id text, p_user_id text, stored_kind text)
    returns boolean language sql stable set search_path = pg_catalog as $$
    select exists (
      select 1 from public.execution_environments environment
      join public.runners runner on runner.id = environment.runner_id
      where environment.id = p_environment_id and runner.revoked_at is null
        and (runner.kind <> 'managed' or runner.owner_user_id is null or runner.owner_user_id = p_user_id)
        and ((runner.owner_kind = 'deployment' and (
          stored_kind = 'server' or (stored_kind = 'personal' and exists (
            select 1 from public.users actor where actor.id = p_user_id and actor.instance_role = 'administrator'
          ))
        )) or (runner.owner_kind = 'user' and runner.owner_user_id = p_user_id))
    )
  $$;
  create function public.opensteer_user_can_execute_thread(p_thread_id text, p_user_id text, stored_kind text)
    returns boolean language sql stable set search_path = pg_catalog as $$
    select exists (
      select 1 from public.threads thread join public.workspace_memberships membership
        on membership.workspace_id = thread.workspace_id and membership.user_id = p_user_id and membership.state = 'active'
      where thread.id = p_thread_id
        and public.opensteer_user_can_execute_environment(thread.environment_id, p_user_id, stored_kind)
    )
  $$;
  create function public.opensteer_project_work_is_valid(
    work_thread text, actor text, requester text, scoped bigint, global_generation bigint,
    connection_id text, source jsonb
  ) returns boolean language plpgsql stable set search_path = pg_catalog as $$
  begin
    return exists (
      select 1 from public.threads t
      join public.workspaces w on w.id = t.workspace_id
      join public.principals p on p.workspace_id = w.id and p.kind = 'project' and p.id = actor
      join public.execution_environments e on e.id = t.environment_id
      join public.runners r on r.id = e.runner_id
      join public.harness_instances h on h.id = coalesce(source #>> '{projectRuntime,harnessInstanceId}', t.harness_instance_id)
      where t.id = work_thread and w.kind = 'project'
        and w.deleted_at is null and w.status not in ('deleting', 'deleted')
        and e.id = w.owner_environment_id and r.owner_kind = 'deployment' and r.owner_user_id is null and r.revoked_at is null
        and r.capabilities @> '["project-authority-v1"]'::jsonb
        and h.environment_id = e.id and h.state_kind = 'isolated'
        and h.driver_kind in ('codex', 'claude') and h.enabled and h.removed_at is null
        and not t.inherits_main and t.specialist_id is null
        and (not source ? 'parentRunId' or exists (
          select 1 from public.runs parent join public.threads pt on pt.id = parent.thread_id
          where parent.id = source->>'parentRunId' and pt.workspace_id = w.id
            and parent.actor_principal_id = actor
            and parent.requested_by is not distinct from requester
            and parent.membership_generation is not distinct from scoped
            and parent.initiator_generation is not distinct from global_generation
            and parent.origin_connection_id is not distinct from connection_id
            and parent.authority_source - 'projectRuntime' - 'parentRunId' = source - 'projectRuntime' - 'parentRunId'
        ))
        and (
          (requester is null and scoped is null and global_generation is null and connection_id is null)
          or (requester is not null and scoped between 1 and 9007199254740991 and global_generation is not null and exists (
            select 1 from public.users u join public.workspace_memberships m on m.user_id = u.id
            where u.id = requester and u.admitted_at is not null and u.member_state = 'active'
              and u.disabled_at is null and u.authority_generation = global_generation
              and m.workspace_id = w.id and m.state = 'active' and m.generation = scoped
          ) and (connection_id is null or exists (
            select 1 from public.agent_connections c where c.id = connection_id and c.user_id = requester
              and c.workspace_id = w.id and c.revoked_at is null
              and c.member_generation = global_generation and c.membership_generation = scoped
          )))
        )
        and (
          (source->>'kind' = 'workspace-membership' and requester is not null
            and source->>'userId' = requester and connection_id is null)
          or (source->>'kind' = 'connection' and requester is not null
            and source->>'userId' = requester and source->>'connectionId' = connection_id)
          or (source->>'kind' in ('thread-agent', 'platform') and exists (
            select 1 from public.runs parent join public.threads pt on pt.id = parent.thread_id
            where parent.id = coalesce(source->>'sourceRunId', source->>'runId')
              and pt.workspace_id = w.id and parent.actor_principal_id = actor
              and parent.requested_by is not distinct from requester
              and parent.membership_generation is not distinct from scoped
              and parent.initiator_generation is not distinct from global_generation
              and parent.origin_connection_id is not distinct from connection_id
              and public.opensteer_project_work_is_valid(parent.thread_id, parent.actor_principal_id,
                parent.requested_by, parent.membership_generation, parent.initiator_generation,
                parent.origin_connection_id, parent.authority_source)
          ))
          or (source->>'kind' = 'trigger-occurrence' and requester is null and exists (
            select 1 from public.trigger_occurrences o
            join public.triggers g on g.id = o.trigger_id
            where o.id = source->>'occurrenceId' and g.workspace_id = w.id
              and o.execution_generation between 1 and 9007199254740991 and o.execution_generation::text = source->>'incarnation'
              and g.current_revision_id = o.revision_id and g.status = 'active'
          ))
          or (source->>'kind' = 'watch-observation' and requester is null and exists (
            select 1 from public.trigger_watch_activations a join public.triggers g on g.id = a.trigger_id
            where a.id = source->>'activationId' and a.workspace_id = w.id
              and a.execution_generation between 1 and 9007199254740991 and a.execution_generation::text = source->>'incarnation'
              and source->>'revisionId' = a.revision_id and source->>'triggerId' = a.trigger_id
              and length(source->>'observationId') > 0
              and a.desired = 'active' and g.status = 'active' and g.current_revision_id = a.revision_id
          ))
        )
    );
  end $$;
  create or replace function public.opensteer_enforce_run_execution_authority() returns trigger language plpgsql as $$
declare stored_model integer; stored_kind text;
      begin
        select model, kind into stored_model, stored_kind from public.opensteer_stored_execution_authority();
        if stored_model = 2 then
          if tg_op = 'UPDATE' and (new.actor_principal_id is distinct from old.actor_principal_id or new.requested_by is distinct from old.requested_by or new.membership_generation is distinct from old.membership_generation or new.initiator_generation is distinct from old.initiator_generation or new.origin_connection_id is distinct from old.origin_connection_id or new.authority_source is distinct from old.authority_source or new.thread_id is distinct from old.thread_id or new.environment_id is distinct from old.environment_id or new.harness_instance_id is distinct from old.harness_instance_id or new.seed_input_id is distinct from old.seed_input_id or new.activation_input_id is distinct from old.activation_input_id or new.causal_chain_id is distinct from old.causal_chain_id or new.assignment_id is distinct from old.assignment_id or new.reply_target is distinct from old.reply_target) then raise exception 'Project work authority is immutable' using errcode = '23514'; end if;
          if not public.opensteer_project_work_is_valid(new.thread_id, new.actor_principal_id, new.requested_by, new.membership_generation, new.initiator_generation, new.origin_connection_id, new.authority_source) or not exists (
            select 1 from public.threads t join public.thread_inputs i on i.message_id = new.seed_input_id
            where t.id = new.thread_id and t.environment_id = new.environment_id
              and (not new.authority_source ? 'projectRuntime' or (
                new.model_selection = new.authority_source #> '{projectRuntime,modelSelection}'
                and new.access_mode = new.authority_source #>> '{projectRuntime,accessMode}'
              ))
              and coalesce(new.authority_source #>> '{projectRuntime,harnessInstanceId}', t.harness_instance_id) = new.harness_instance_id and i.thread_id = t.id
              and i.actor_principal_id = new.actor_principal_id
              and i.requested_by is not distinct from new.requested_by
              and i.membership_generation is not distinct from new.membership_generation
              and i.initiator_generation is not distinct from new.initiator_generation
              and i.origin_connection_id is not distinct from new.origin_connection_id
              and i.authority_source = new.authority_source
              and exists (select 1 from public.thread_inputs activation where activation.message_id = new.activation_input_id
                and activation.thread_id = new.thread_id and activation.actor_principal_id = new.actor_principal_id
                and activation.requested_by is not distinct from new.requested_by
                and activation.membership_generation is not distinct from new.membership_generation
                and activation.initiator_generation is not distinct from new.initiator_generation
                and activation.origin_connection_id is not distinct from new.origin_connection_id
                and activation.authority_source = new.authority_source)
          ) then raise exception 'Invalid Project Run authority' using errcode = '23514'; end if;
          return new;
        end if;
        if new.requested_by is null or new.membership_generation is null or new.initiator_generation is not null
          or new.origin_connection_id is not null then
          raise exception 'Project Run on legacy authority' using errcode = '23514';
        end if;

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
            and opensteer_user_can_execute_thread(thread.id, new.requested_by, stored_kind)
        ) then
          raise exception 'run requester cannot execute the thread environment';
        end if;
        return new;
      end;
  $$;
  create function public.opensteer_enforce_input_execution_authority() returns trigger language plpgsql as $$
  declare stored_model integer; stored_kind text;
  begin
    select model, kind into stored_model, stored_kind from public.opensteer_stored_execution_authority();
    if stored_model = 2 then
      if tg_op = 'UPDATE' and (new.actor_principal_id is distinct from old.actor_principal_id or new.requested_by is distinct from old.requested_by or new.membership_generation is distinct from old.membership_generation or new.initiator_generation is distinct from old.initiator_generation or new.origin_connection_id is distinct from old.origin_connection_id or new.authority_source is distinct from old.authority_source or new.thread_id is distinct from old.thread_id or new.causal_chain_id is distinct from old.causal_chain_id or new.assignment_id is distinct from old.assignment_id or new.reply_target is distinct from old.reply_target) then raise exception 'Project work authority is immutable' using errcode = '23514'; end if;
      if not public.opensteer_project_work_is_valid(new.thread_id, new.actor_principal_id, new.requested_by, new.membership_generation, new.initiator_generation, new.origin_connection_id, new.authority_source) then raise exception 'Invalid Project input authority' using errcode = '23514'; end if;
      if new.run_id is not null and not exists (
        select 1 from public.runs r where r.id = new.run_id and r.thread_id = new.thread_id
          and r.actor_principal_id = new.actor_principal_id and r.requested_by is not distinct from new.requested_by
          and r.membership_generation is not distinct from new.membership_generation
          and r.initiator_generation is not distinct from new.initiator_generation
          and r.origin_connection_id is not distinct from new.origin_connection_id
      ) then raise exception 'Project input cannot change its exchange root' using errcode = '23514'; end if;
    elsif new.requested_by is null or new.membership_generation is null or new.initiator_generation is not null
      or new.origin_connection_id is not null then
      raise exception 'Project input on legacy authority' using errcode = '23514';
    end if;
    return new;
  end $$;
  create or replace function public.opensteer_enforce_command_execution_authority() returns trigger language plpgsql as $$
declare stored_model integer; stored_kind text;
      begin
        if tg_op = 'UPDATE' and old.type not in ('run.execute.project', 'run.control.project')
          and new.type is not distinct from old.type and new.thread_id is not distinct from old.thread_id
          and new.run_id is not distinct from old.run_id and new.environment_id is not distinct from old.environment_id
          and new.requested_by is not distinct from old.requested_by and new.actor_principal_id is not distinct from old.actor_principal_id
          and new.membership_generation is not distinct from old.membership_generation
          and new.initiator_generation is not distinct from old.initiator_generation
          and new.origin_connection_id is not distinct from old.origin_connection_id
          and new.originating_grant_id is not distinct from old.originating_grant_id
          and new.authority_source is not distinct from old.authority_source then return new; end if;
        select model, kind into stored_model, stored_kind from public.opensteer_stored_execution_authority();
        if stored_model = 2 and tg_op = 'UPDATE' and (old.type in ('run.execute.project', 'run.control.project') or new.type in ('run.execute.project', 'run.control.project')) then
          if (new.actor_principal_id is distinct from old.actor_principal_id or new.requested_by is distinct from old.requested_by or new.membership_generation is distinct from old.membership_generation or new.initiator_generation is distinct from old.initiator_generation or new.origin_connection_id is distinct from old.origin_connection_id or new.authority_source is distinct from old.authority_source or new.type is distinct from old.type or new.originating_grant_id is distinct from old.originating_grant_id or new.payload is distinct from old.payload or new.thread_id is distinct from old.thread_id or new.run_id is distinct from old.run_id or new.environment_id is distinct from old.environment_id) then raise exception 'Project work authority is immutable' using errcode = '23514'; end if;
        end if;
        if stored_model = 2 and new.type in ('run.execute.project', 'run.control.project') then
          if new.type = 'run.control.project' and not exists (
            select 1 from public.grants g join public.runs r on r.id = g.run_id
              join public.threads t on t.id = r.thread_id
            where g.id = new.originating_grant_id and r.id = new.run_id
              and new.payload->'binding' = jsonb_build_object(
                'authority', jsonb_build_object('version', 1,
                  'principal', jsonb_build_object('kind', 'project', 'principalId', r.actor_principal_id, 'workspaceId', t.workspace_id),
                  'origin', case when r.requested_by is null then 'null'::jsonb else jsonb_build_object(
                    'userId', r.requested_by, 'initiatorGeneration', r.initiator_generation,
                    'membershipGeneration', r.membership_generation, 'originConnectionId', r.origin_connection_id) end),
                'runId', r.id, 'threadId', r.thread_id, 'workspaceId', t.workspace_id,
                'environmentId', r.environment_id, 'grantId', g.id, 'runnerId', g.runner_id,
                'runnerBootId', g.runner_boot_id, 'bindingGeneration', g.binding_generation)
          ) then raise exception 'Invalid Project control grant' using errcode = '23514'; end if;

          if (not (new.type = 'run.control.project' and new.payload #>> '{control,kind}' in ('run.interrupt', 'request.refuse'))
            and not public.opensteer_project_work_is_valid(new.thread_id, new.actor_principal_id, new.requested_by, new.membership_generation, new.initiator_generation, new.origin_connection_id, new.authority_source)) or not exists (
            select 1 from public.runs r where r.id = new.run_id and r.thread_id = new.thread_id
              and r.environment_id = new.environment_id and r.actor_principal_id = new.actor_principal_id
              and r.requested_by is not distinct from new.requested_by
              and r.membership_generation is not distinct from new.membership_generation
              and r.initiator_generation is not distinct from new.initiator_generation
              and r.origin_connection_id is not distinct from new.origin_connection_id
              and r.authority_source = new.authority_source
          ) then raise exception 'Invalid Project command authority' using errcode = '23514'; end if;
          return new;
        end if;
        if new.requested_by is null or new.membership_generation is not null or new.initiator_generation is not null
          or new.origin_connection_id is not null or new.type in ('run.execute.project', 'run.control.project')
          or (stored_model = 2 and new.type in ('run.execute', 'trigger.execute')) then
          raise exception 'Invalid human command authority' using errcode = '23514';
        end if;

        if stored_model = 2 and not exists (
          select 1 from public.principals p join public.users u on u.id = p.user_id
          where p.id = new.actor_principal_id and p.kind = 'user' and p.user_id = new.requested_by
            and u.admitted_at is not null and u.member_state = 'active' and u.disabled_at is null
        ) then raise exception 'Human control requires its actual user actor' using errcode = '23514'; end if;
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
               and public.opensteer_user_can_execute_thread(thread.id, new.requested_by, stored_kind)
           ) then
          raise exception 'command requester cannot execute the thread environment';
        end if;
        return new;
      end;
  $$;
  create or replace function public.opensteer_enforce_thread_execution_authority() returns trigger language plpgsql as $$
declare stored_model integer; stored_kind text;
      begin
        select model, kind into stored_model, stored_kind from public.opensteer_stored_execution_authority();
        if stored_model = 2 then
          if tg_op = 'UPDATE' and (new.created_by is distinct from old.created_by or new.created_by_principal_id is distinct from old.created_by_principal_id or new.workspace_id is distinct from old.workspace_id or new.parent_thread_id is distinct from old.parent_thread_id) then
            raise exception 'Project Thread creator and scope are immutable' using errcode = '23514';
          end if;
          if not exists (
            select 1 from public.workspaces w
            join public.execution_environments e on e.id = w.owner_environment_id
            join public.runners r on r.id = e.runner_id
            join public.harness_instances h on h.id = new.harness_instance_id and h.environment_id = e.id
            where w.id = new.workspace_id and w.kind = 'project' and w.deleted_at is null
              and w.status not in ('deleting','deleted') and e.id = new.environment_id
              and r.owner_kind = 'deployment' and r.owner_user_id is null and r.revoked_at is null
        and r.capabilities @> '["project-authority-v1"]'::jsonb
              and h.state_kind = 'isolated' and h.driver_kind in ('codex','claude') and h.enabled and h.removed_at is null
              and not new.inherits_main and new.specialist_id is null
          ) or not exists (
            select 1 from public.principals p where p.id = new.created_by_principal_id
              and ((p.kind = 'project' and p.workspace_id = new.workspace_id)
                or (p.kind = 'user' and p.user_id = new.created_by))
          ) then raise exception 'Invalid Project Thread authority' using errcode = '23514'; end if;
          if tg_op = 'INSERT' and new.created_by is not null and not exists (
            select 1 from public.users u join public.workspace_memberships m on m.user_id = u.id
            where u.id = new.created_by and u.admitted_at is not null and u.member_state = 'active'
              and u.disabled_at is null and m.workspace_id = new.workspace_id and m.state = 'active'
          ) then raise exception 'Invalid Project Thread creator' using errcode = '23514'; end if;
          return new;
        end if;

        if not exists (
          select 1 from workspace_memberships membership
          where membership.workspace_id = new.workspace_id
            and membership.user_id = new.created_by
            and membership.state = 'active'
        ) then
          raise exception 'thread creator must be an active workspace member';
        end if;
        if not opensteer_user_can_execute_environment(new.environment_id, new.created_by, stored_kind) then
          raise exception 'thread creator cannot execute on the selected environment';
        end if;
        return new;
      end;
  $$;
  create or replace function public.opensteer_enforce_thread_membership_and_parent() returns trigger language plpgsql as $$
declare
        stored_model integer; stored_kind text;
        parent_workspace_id text;
      begin
        select model, kind into stored_model, stored_kind from public.opensteer_stored_execution_authority();
        if stored_model = 2 then
          if new.parent_thread_id is null then
            if new.lineage_root_thread_id <> new.id then raise exception 'Invalid Project lineage' using errcode = '23514'; end if;
          elsif new.parent_thread_id = new.id or not exists (
            select 1 from public.threads parent join public.threads root on root.id = parent.lineage_root_thread_id
            where parent.id = new.parent_thread_id and parent.workspace_id = new.workspace_id
              and root.workspace_id = new.workspace_id and new.lineage_root_thread_id = parent.lineage_root_thread_id
          ) then raise exception 'Project children must retain their Project lineage' using errcode = '23514'; end if;
          return new;
        end if;

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
  $$;
  create function public.opensteer_project_run_settings_immutable() returns trigger language plpgsql set search_path = pg_catalog as $$
  declare stored_model integer;
  begin
    select model into stored_model from public.opensteer_stored_execution_authority();
    if stored_model = 2 and (new.model_selection is distinct from old.model_selection or new.access_mode is distinct from old.access_mode) then
      raise exception 'Admitted Project Run settings are immutable' using errcode = '23514';
    end if;
    return new;
  end $$;
  create trigger runs_admitted_project_settings before update of model_selection, access_mode on public.runs
    for each row execute function public.opensteer_project_run_settings_immutable();
  drop trigger if exists runs_execution_authority on public.runs;
  create trigger runs_execution_authority before insert or update of actor_principal_id, requested_by, membership_generation, initiator_generation, origin_connection_id, authority_source, thread_id, environment_id, harness_instance_id, seed_input_id, activation_input_id, causal_chain_id, assignment_id, reply_target on public.runs for each row execute function public.opensteer_enforce_run_execution_authority();
  drop trigger if exists commands_execution_authority on public.commands;
  create trigger commands_execution_authority before insert or update of actor_principal_id, requested_by, membership_generation, initiator_generation, origin_connection_id, originating_grant_id, authority_source, type, thread_id, run_id, environment_id, payload on public.commands for each row execute function public.opensteer_enforce_command_execution_authority();
  drop trigger if exists thread_inputs_execution_authority on public.thread_inputs;
  create trigger thread_inputs_execution_authority before insert or update of actor_principal_id, requested_by, membership_generation, initiator_generation, origin_connection_id, authority_source, thread_id, causal_chain_id, assignment_id, reply_target, run_id on public.thread_inputs for each row execute function public.opensteer_enforce_input_execution_authority();
  drop trigger if exists threads_execution_authority on public.threads;
  create trigger threads_execution_authority before insert or update of environment_id, harness_instance_id, workspace_id, created_by, created_by_principal_id, parent_thread_id, inherits_main, specialist_id on public.threads for each row execute function public.opensteer_enforce_thread_execution_authority();
  drop trigger if exists threads_membership_and_parent on public.threads;
  create trigger threads_membership_and_parent before insert or update of id, workspace_id, created_by, parent_thread_id, lineage_root_thread_id on public.threads for each row execute function public.opensteer_enforce_thread_membership_and_parent();
  create function public.opensteer_prevent_deployment_authority_change() returns trigger language plpgsql as $$
  begin
    if new.authority_model_version is distinct from old.authority_model_version
      or new.deployment_shape->>'kind' is distinct from old.deployment_shape->>'kind' then
      raise exception 'Deployment kind and authority model are immutable' using errcode = '23514';
    end if;
    return new;
  end $$;
  create trigger deployments_immutable_authority before update of authority_model_version, deployment_shape
    on public.deployments for each row execute function public.opensteer_prevent_deployment_authority_change();
`;
