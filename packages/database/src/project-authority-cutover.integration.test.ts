import { createId } from "@opensteer/core";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { projectAuthorityCutoverMigration } from "./project-authority-migration.js";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";

describeStore("additive Project authority preparation", (it) => {
  it("keeps legacy work shapes and writers while adding nullable metadata", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.startRunFixture("cutover-legacy", "project");
    const row = await storeFixture.database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", run.run.id)
      .executeTakeFirstOrThrow();
    expect(row.requestedBy).toBe(run.userId);
    expect(row.membershipGeneration).toBe("1");
    expect(row.initiatorGeneration).toBeNull();
    expect(row.originConnectionId).toBeNull();
    for (const table of ["runs", "thread_inputs", "commands"] as const) {
      const constraint = `${table}_initiator_generation_bounds`;
      await expect(
        sql`update ${sql.id(table)} set initiator_generation = 0`.execute(storeFixture.database),
      ).rejects.toMatchObject({ code: "23514", constraint });
    }
    await expect(
      sql`update runs set origin_connection_id = 'missing' where id = ${row.id}`.execute(
        storeFixture.database,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const constraints = await sql<{
      convalidated: boolean;
    }>`select convalidated from pg_constraint where conname in (
      'principals_kind_check', 'principals_kind_shape_check', 'principals_workspace_id_fkey',
      'runs_initiator_generation_bounds', 'runs_origin_connection_id_fkey',
      'auth_sessions_member_generation_bounds', 'agent_connections_member_generation_bounds', 'agent_connections_membership_generation_bounds'
    )`.execute(storeFixture.database);
    expect(constraints.rows).toHaveLength(8);
    expect(constraints.rows.every((constraint) => !constraint.convalidated)).toBe(true);
  });

  it("enforces Project principal identity and scope by direct SQL without touching legacy identities", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("cutover-principal", null, "project");
    const database = storeFixture.database;
    const insert = (kind: string, userId: string | null, workspaceId: string | null) =>
      sql`
      insert into principals (id, kind, user_id, workspace_id, display_name)
      values (${`pri_${randomUUID()}`}, ${kind}, ${userId}, ${workspaceId}, 'Principal')
    `.execute(database);
    await expect(insert("project", null, fixture.workspace.id)).rejects.toMatchObject({
      code: "23514",
    });
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await insert("project", null, fixture.workspace.id);
    await expect(insert("project", null, fixture.workspace.id)).rejects.toMatchObject({
      code: "23505",
    });
    for (const [kind, userId, workspaceId] of [
      ["project", fixture.userId, fixture.workspace.id],
      ["project", null, null],
      ["user", fixture.userId, fixture.workspace.id],
      ["user", null, null],
      ["system", fixture.userId, null],
      ["channel-identity", fixture.userId, null],
      ["system", null, fixture.workspace.id],
      ["channel-identity", null, fixture.workspace.id],
      ["future", null, null],
    ] as const)
      await expect(insert(kind, userId, workspaceId)).rejects.toMatchObject({ code: "23514" });
    await sql`update principals set display_name = 'Human' where kind = 'user' and user_id = ${fixture.userId}`.execute(
      database,
    );
    await insert("system", null, null);
    await insert("channel-identity", null, null);
    await expect(
      sql`update principals set workspace_id = null where kind = 'project'`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses Project principals on Main and on Personal model 2", async ({ storeFixture }) => {
    const fixture = await storeFixture.createRunFixture("cutover-scope");
    const database = storeFixture.database;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    const insert = () =>
      sql`insert into principals (id, kind, workspace_id, display_name) values (${`pri_${randomUUID()}`}, 'project', ${fixture.workspace.id}, 'Project')`.execute(
        database,
      );
    await expect(insert()).rejects.toMatchObject({ code: "23514" });
    if (fixture.workspace.backing.kind !== "local-directory")
      throw new Error("Expected local fixture");
    const project = await createTestWorkspace(storeFixture.store, {
      backing: { ...fixture.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: fixture.userId,
      idempotencyKey: "second-project",
      kind: "project",
      name: "Project",
      status: "ready",
    });
    await sql`update deployments set deployment_shape = '{"kind":"personal","defaultWorkspaceBacking":"local-directory"}'::jsonb`.execute(
      database,
    );
    await expect(
      sql`insert into principals (id, kind, workspace_id, display_name) values (${`pri_${randomUUID()}`}, 'project', ${project.id}, 'Project')`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("adds root metadata without scans or heap rewrites and records the held DDL locks", async ({
    storeFixture,
  }) => {
    await storeFixture.startRunFixture("cutover-ddl", "project");
    await storeFixture.database.transaction().execute(async (transaction) => {
      const definitions = async () =>
        (
          await sql`
        select 'column:' || table_name || ':' || column_name as name,
          data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as definition
        from information_schema.columns where table_schema = 'public' and table_name in ('principals', 'runs', 'thread_inputs', 'commands', 'triggers', 'trigger_revisions', 'trigger_watch_activations')
        union all select 'constraint:' || conrelid::regclass::text || ':' || conname, pg_get_constraintdef(oid)
          from pg_constraint where connamespace = 'public'::regnamespace and conrelid in ('principals'::regclass, 'runs'::regclass, 'thread_inputs'::regclass, 'commands'::regclass, 'triggers'::regclass, 'trigger_revisions'::regclass, 'trigger_watch_activations'::regclass)
        union all select 'index:' || indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('principals', 'runs', 'thread_inputs', 'commands', 'triggers', 'trigger_revisions', 'trigger_watch_activations')
        union all select 'function:' || proname, pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'opensteer_project_principal_scope'
        union all select 'trigger:' || tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'principals'::regclass and tgname = 'project_principal_scope'
        order by name
      `.execute(transaction)
        ).rows;
      const freshDefinitions = await definitions();
      await sql`drop trigger project_principal_scope on principals; drop function opensteer_project_principal_scope();
        alter table principals drop column workspace_id;
        alter table principals add constraint principals_kind_shape_check check ((kind = 'user' and user_id is not null) or (kind in ('channel-identity', 'system') and user_id is null));
        alter table runs drop column initiator_generation, drop column origin_connection_id;
        alter table thread_inputs drop column initiator_generation, drop column origin_connection_id;
        alter table commands drop column initiator_generation, drop column origin_connection_id, drop column membership_generation;
        alter table triggers drop column created_by_principal_id;
        alter table trigger_revisions drop column created_by_principal_id;
        alter table trigger_watch_activations drop column created_by_principal_id;
        insert into principals (id, kind, display_name) select 'pri_ddl_' || item, 'system', 'System' from generate_series(1, 100) item
      `.execute(transaction);
      const facts = async () =>
        (
          await sql`
        select relname, relfilenode, case when relname <> 'principals' then pg_stat_get_xact_numscans(oid) end as scans
        from pg_class where oid in ('principals'::regclass, 'runs'::regclass, 'thread_inputs'::regclass, 'commands'::regclass, 'triggers'::regclass, 'trigger_revisions'::regclass, 'trigger_watch_activations'::regclass)
        order by relname
      `.execute(transaction)
        ).rows;
      const before = await facts();
      await projectAuthorityCutoverMigration.up(transaction);
      expect(await facts()).toEqual(before);
      expect(await definitions()).toEqual(freshDefinitions);
      const locks = (
        await sql<{ relname: string; mode: string }>`
        select distinct c.relname, l.mode from pg_locks l join pg_class c on c.oid = l.relation
        where l.pid = pg_backend_pid() and l.granted and c.relname in ('principals', 'runs', 'thread_inputs', 'commands', 'triggers', 'trigger_revisions', 'trigger_watch_activations', 'agent_connections', 'workspaces')
        order by c.relname, l.mode
      `.execute(transaction)
      ).rows;
      for (const table of [
        "principals",
        "runs",
        "thread_inputs",
        "commands",
        "triggers",
        "trigger_revisions",
        "trigger_watch_activations",
      ])
        expect(locks).toContainEqual({ relname: table, mode: "AccessExclusiveLock" });
      expect(locks).toContainEqual({ relname: "agent_connections", mode: "ShareRowExclusiveLock" });
      console.info("0172 held migration locks", locks);
    });
  });
});
