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
  create trigger project_principal_scope before insert or update on public.principals
    for each row execute function public.opensteer_project_principal_scope();
`;
