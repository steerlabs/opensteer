import { HUMAN_AUTHORITY_GUARDS_SQL } from "./human-authority-guards.js";
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { PROJECT_AUTHORITY_GUARDS_SQL } from "./project-authority-guards.js";

export const projectAuthorityCutoverMigrationName = "0174_project_authority_cutover";

export const projectAuthorityCutoverMigration: Migration = {
  async up(database) {
    await sql`
      alter table public.principals add column workspace_id text;
      alter table public.principals
        add constraint principals_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete restrict not valid,
        drop constraint principals_kind_check,
        drop constraint principals_kind_shape_check,
        add constraint principals_kind_check check (kind in ('user', 'project', 'channel-identity', 'system')) not valid,
        add constraint principals_kind_shape_check check (
          (kind = 'user' and user_id is not null and workspace_id is null) or
          (kind = 'project' and user_id is null and workspace_id is not null) or
          (kind in ('channel-identity', 'system') and user_id is null and workspace_id is null)
        ) not valid;
      create unique index principals_project_identity on public.principals(workspace_id) where workspace_id is not null;
    `.execute(database);
    for (const table of ["thread_inputs", "runs", "commands"]) {
      await sql`alter table ${sql.id("public", table)}
        add column initiator_generation bigint,
        add column origin_connection_id text,
        add constraint ${sql.id(`${table}_initiator_generation_bounds`)} check (initiator_generation between 1 and 9007199254740991) not valid,
        add constraint ${sql.id(`${table}_origin_connection_id_fkey`)} foreign key (origin_connection_id) references public.agent_connections(id) on delete restrict not valid
      `.execute(database);
    }
    await sql`alter table public.commands add column membership_generation bigint,
      add constraint commands_membership_generation_bounds check (membership_generation between 1 and 9007199254740991) not valid
    `.execute(database);
    for (const table of ["triggers", "trigger_revisions", "trigger_watch_activations"]) {
      await sql`alter table ${sql.id("public", table)} add column created_by_principal_id text,
        add constraint ${sql.id(`${table}_created_by_principal_id_fkey`)} foreign key (created_by_principal_id) references public.principals(id) on delete restrict not valid
      `.execute(database);
    }
    await sql.raw(PROJECT_AUTHORITY_GUARDS_SQL).execute(database);
    await sql.raw(HUMAN_AUTHORITY_GUARDS_SQL).execute(database);
    await sql`alter table public.deployments add column trusted_members_acknowledged_at timestamptz`.execute(
      database,
    );
    await sql`alter table public.team_invitations add column trusted_computer_confirmed_at timestamptz`.execute(
      database,
    );
  },
};
