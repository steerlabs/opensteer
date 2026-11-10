export const HUMAN_AUTHORITY_GUARDS_SQL = `
create or replace function public.opensteer_prevent_last_workspace_owner_removal()
      returns trigger language plpgsql as $$
      begin
        if exists (select 1 from public.deployments where singleton_key = 'primary' and deployment_shape->>'kind' = 'server' and authority_model_version = 2) and exists (select 1 from public.workspaces where id = old.workspace_id and kind = 'project') then
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
CREATE OR REPLACE FUNCTION public.opensteer_require_workspace_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if new.kind = 'project' and exists (select 1 from public.deployments where singleton_key = 'primary' and deployment_shape->>'kind' = 'server' and authority_model_version = 2) then return new; end if;
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
CREATE OR REPLACE FUNCTION public.opensteer_project_membership_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      begin
        if exists (select 1 from public.deployments where singleton_key = 'primary' and deployment_shape->>'kind' = 'server' and authority_model_version = 2) then return case when tg_op = 'DELETE' then old else new end; end if;
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
create or replace function public.opensteer_refresh_account_directory_user(
        target_user_id text
      ) returns void
      language plpgsql
      as $$
        declare
          target_present boolean;
          account record;
        begin
          if exists (select 1 from public.deployments where singleton_key = 'primary' and deployment_shape->>'kind' = 'server' and authority_model_version = 2) then
            select exists (select 1 from public.users where id = target_user_id and admitted_at is not null and member_state = 'active' and disabled_at is null) into target_present;
          else
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
          end if;
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
DROP TRIGGER users_account_directory_projection_update ON public.users;
CREATE TRIGGER users_account_directory_projection_update
AFTER UPDATE OF disabled_at, instance_role, admitted_at, member_state ON public.users
FOR EACH ROW EXECUTE FUNCTION public.opensteer_project_user_change();
`;
