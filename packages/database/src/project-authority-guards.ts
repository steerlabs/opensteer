export const PROJECT_AUTHORITY_GUARDS_SQL = String.raw`
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
      select 1 from public.deployments d
      where d.singleton_key = 'primary' and d.authority_model_version = 2
        and d.deployment_shape->>'kind' = 'server'
    ) or not exists (
      select 1 from public.workspaces w where w.id = new.workspace_id and w.kind = 'project'
        and w.deleted_at is null and w.status not in ('deleting', 'deleted')
    ) then
      raise exception 'Project principals require server authority model 2 and a live Project' using errcode = '23514';
    end if;
    return new;
  end $$;
  create trigger project_principal_scope before insert or update on public.principals
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
      join public.deployments d on d.singleton_key = 'primary'
      where g.id = new.originating_grant_id and g.run_id = new.originating_run_id
        and p.kind = 'project' and p.workspace_id = t.workspace_id
        and d.authority_model_version = 2 and d.deployment_shape->>'kind' = 'server'
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
`;
