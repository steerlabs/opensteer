import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { PROJECT_AUTHORITY_GUARDS_SQL } from "./project-authority-guards.js";

export const projectAuthorityCutoverMigration: Migration = {
  async up(database) {
    for (const name of [
      "agent_control_requests_action_check",
      "agent_control_requests_action_class_check",
    ] as const) {
      const result = await sql<{
        definition: string;
      }>`select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'public.agent_control_requests'::regclass and conname = ${name}`.execute(
        database,
      );
      const definition = result.rows[0]?.definition;
      if (!definition?.includes("'thread.read'::text"))
        throw new Error("Cannot extend the Run ledger for Project event receipts");
      if (definition.includes("'project.event'::text")) continue;
      const extended = definition
        .replace(/\s+NOT VALID$/u, "")
        .replace("'thread.read'::text", "'thread.read'::text, 'project.event'::text");
      await sql
        .raw(`alter table public.agent_control_requests drop constraint ${name}`)
        .execute(database);
      await sql
        .raw(
          `alter table public.agent_control_requests add constraint ${name} ${extended} not valid`,
        )
        .execute(database);
    }
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
    await sql`alter table public.commands add column originating_grant_id text,
      add constraint commands_originating_grant_id_fkey foreign key (originating_grant_id) references public.grants(id) on delete restrict not valid,
      add constraint commands_project_control_grant check (type <> 'run.control.project' or originating_grant_id is not null) not valid,
      add column membership_generation bigint,
      add constraint commands_membership_generation_bounds check (membership_generation between 1 and 9007199254740991) not valid
    `.execute(database);
    for (const table of ["triggers", "trigger_revisions", "trigger_watch_activations"]) {
      await sql`alter table ${sql.id("public", table)} add column created_by_principal_id text,
        add constraint ${sql.id(`${table}_created_by_principal_id_fkey`)} foreign key (created_by_principal_id) references public.principals(id) on delete restrict not valid
      `.execute(database);
    }

    for (const table of ["thread_inputs", "runs"]) {
      await sql`alter table ${sql.id("public", table)}
        alter column requested_by drop not null,
        alter column membership_generation drop not null,
        add constraint ${sql.id(`${table}_human_root_shape`)} check (
          (requested_by is not null and membership_generation is not null and initiator_generation is null and origin_connection_id is null)
          or (requested_by is not null and membership_generation is not null and initiator_generation is not null)
          or (requested_by is null and membership_generation is null and initiator_generation is null and origin_connection_id is null)
        ) not valid
      `.execute(database);
    }
    await sql`alter table public.commands alter column requested_by drop not null,
      add constraint commands_human_root_shape check (
        (requested_by is not null and membership_generation is null and initiator_generation is null and origin_connection_id is null)
        or (requested_by is not null and membership_generation is not null and initiator_generation is not null)
        or (requested_by is null and membership_generation is null and initiator_generation is null and origin_connection_id is null)
      ) not valid;
      create unique index thread_inputs_unattended_idempotency on public.thread_inputs(thread_id, actor_principal_id, idempotency_key) where requested_by is null;
      create unique index commands_unattended_idempotency on public.commands(actor_principal_id, idempotency_key) where requested_by is null;
    `.execute(database);
    await sql.raw(PROJECT_AUTHORITY_GUARDS_SQL).execute(database);
  },
};
