import { TriggerStore } from "./trigger-store.js";
import { runFromRow } from "./thread-row-mappers.js";
import { Migrator } from "kysely/migration";
import {
  createProjectIdentityFixture,
  insertProjectRunFixture,
} from "./project-work.test-support.js";
import { createId } from "@opensteer/core";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { projectAuthorityCutoverMigration } from "./project-authority-migration.js";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";

describeStore("additive Project authority preparation", (it) => {
  it("reads the stored selector through one trackable stable helper with a pinned search path", async ({
    storeFixture,
  }) => {
    const database = storeFixture.database;
    await database
      .insertInto("deployments")
      .values({
        id: createId("deployment"),
        singletonKey: "primary",
        activeHostInstanceId: createId("hostInstance"),
        authorityModelVersion: 2,
        canonicalOrigin: "https://project.test.invalid",
        lifecycle: "active",
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`set local track_functions = 'all'`.execute(transaction);
      const result = await sql<{
        model: number;
        kind: string;
      }>`select * from public.opensteer_stored_execution_authority()`.execute(transaction);
      expect(result.rows).toEqual([{ model: 2, kind: "server" }]);
      const metadata = await sql<{
        provolatile: string;
        proconfig: string[];
      }>`select provolatile, proconfig from pg_proc where oid = 'public.opensteer_stored_execution_authority()'::regprocedure`.execute(
        transaction,
      );
      expect(metadata.rows).toEqual([{ provolatile: "s", proconfig: ["search_path=pg_catalog"] }]);
      const statistics = await sql<{
        calls: string;
      }>`select calls from pg_stat_xact_user_functions where funcid = 'public.opensteer_stored_execution_authority()'::regprocedure`.execute(
        transaction,
      );
      expect(statistics.rows).toEqual([{ calls: "1" }]);
    });
  });

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
    const rollback = new Error("Roll back constraint-isolation DDL");
    for (const table of ["runs", "thread_inputs", "commands"] as const) {
      await expect(
        storeFixture.database.transaction().execute(async (transaction) => {
          // Isolate scalar constraints from the stricter model guard, then roll back the DDL.
          await sql`alter table ${sql.id(table)} disable trigger ${sql.id(table === "thread_inputs" ? "thread_inputs_execution_authority" : `${table}_execution_authority`)}`.execute(
            transaction,
          );
          await expect(
            sql`update ${sql.id(table)} set initiator_generation = 0 ${table === "commands" ? sql`, membership_generation = 1` : sql``}`.execute(
              transaction,
            ),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: `${table}_initiator_generation_bounds`,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    await expect(
      storeFixture.database.transaction().execute(async (transaction) => {
        await sql`alter table runs disable trigger runs_execution_authority`.execute(transaction);
        await expect(
          sql`update runs set initiator_generation = 1, origin_connection_id = 'missing' where id = ${row.id}`.execute(
            transaction,
          ),
        ).rejects.toMatchObject({ code: "23503" });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const constraints = await sql<{
      convalidated: boolean;
    }>`select convalidated from pg_constraint where conname in (
      'principals_kind_check', 'principals_kind_shape_check', 'principals_workspace_id_fkey',
      'runs_initiator_generation_bounds', 'runs_origin_connection_id_fkey',
      'auth_sessions_member_generation_bounds', 'agent_connections_member_generation_bounds', 'agent_connections_membership_generation_bounds',
      'agent_control_requests_action_check', 'agent_control_requests_action_class_check'
    )`.execute(storeFixture.database);
    expect(constraints.rows).toHaveLength(10);
    expect(constraints.rows.every((constraint) => !constraint.convalidated)).toBe(true);
  });

  it("enforces Project principal identity and scope by direct SQL without touching legacy identities", async ({
    storeFixture,
  }) => {
    const fixture = await createProjectIdentityFixture(storeFixture, "cutover-principal");
    const database = storeFixture.database;
    const insert = (kind: string, userId: string | null, workspaceId: string | null) =>
      sql`insert into principals (id, kind, user_id, workspace_id, display_name) values (${`pri_${randomUUID()}`}, ${kind}, ${userId}, ${workspaceId}, 'Principal')`.execute(
        database,
      );
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
    const main = await createTestWorkspace(storeFixture.store, {
      backing: { ...fixture.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: fixture.userId,
      idempotencyKey: "main-principal",
      kind: "main",
      name: "Main",
      status: "ready",
    });
    await expect(insert("project", null, main.id)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects Project principals on cold Personal model 2", async ({ storeFixture }) => {
    await storeFixture.database
      .insertInto("deployments")
      .values({
        id: createId("deployment"),
        singletonKey: "primary",
        activeHostInstanceId: createId("hostInstance"),
        authorityModelVersion: 2,
        canonicalOrigin: "http://127.0.0.1:4310",
        lifecycle: "active",
        deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await expect(
      sql`insert into principals (id, kind, workspace_id, display_name) values (${`pri_${randomUUID()}`}, 'project', ${createId("workspace")}, 'Project')`.execute(
        storeFixture.database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects either Project work shape on model 1 by direct inserts", async ({ storeFixture }) => {
    await storeFixture.startRunFixture("legacy-project-forgery", "project");
    for (const table of ["runs", "thread_inputs", "commands"]) {
      for (const shape of [
        sql`jsonb_build_object('initiator_generation', 1, 'membership_generation', 1)`,
        sql`jsonb_build_object('requested_by', null, 'membership_generation', null)`,
      ]) {
        await expect(
          sql`insert into ${sql.id(table)} select (jsonb_populate_record(null::${sql.id(table)}, to_jsonb(row) || ${shape})).* from ${sql.id(table)} row limit 1`.execute(
            storeFixture.database,
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
    }
  });

  it("guards Project work, captured roots and immutable authority directly in SQL", async ({
    storeFixture,
  }) => {
    const project = await createProjectIdentityFixture(storeFixture, "guarded-work");
    const fixture = await insertProjectRunFixture(storeFixture, project, "guarded-work");
    const database = storeFixture.database;
    for (const mutation of ["model_selection = '{}'::jsonb", "access_mode = 'approval-required'"]) {
      await expect(
        sql`update runs set ${sql.raw(mutation)} where id = ${fixture.run.id}`.execute(database),
      ).rejects.toMatchObject({ code: "23514" });
    }
    for (const table of ["runs", "thread_inputs", "commands"]) {
      await expect(
        sql`insert into ${sql.id(table)} select (jsonb_populate_record(null::${sql.id(table)}, to_jsonb(row) || jsonb_build_object('initiator_generation', null, 'actor_principal_id', (select id from principals where user_id = ${fixture.userId})))).* from ${sql.id(table)} row ${table === "commands" ? sql`where type = 'run.execute.project'` : sql``} limit 1`.execute(
          database,
        ),
        table,
      ).rejects.toMatchObject({ code: "23514" });
    }
    const principal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", fixture.userId)
      .executeTakeFirstOrThrow();
    await expect(
      sql`update commands set type = 'run.interrupt', actor_principal_id = ${principal.id}, membership_generation = null, initiator_generation = null, payload = '{}'::jsonb where type = 'run.execute.project'`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    for (const type of ["run.interrupt", "run.steer"] as const) {
      await database
        .insertInto("commands")
        .values({
          id: createId("command"),
          actorPrincipalId: principal.id,
          requestedBy: fixture.userId,
          authoritySource: sql`'{"kind":"workspace-membership"}'::jsonb`,
          environmentId: fixture.environmentId,
          threadId: fixture.thread.id,
          runId: fixture.run.id,
          idempotencyKey: type,
          type,
          payload: sql`'{}'::jsonb`,
          status: "pending",
          dispatcherId: null,
          lastError: null,
        })
        .execute();
    }
    for (const table of ["runs", "thread_inputs", "commands"]) {
      for (const mutation of [
        "requested_by = null",
        "initiator_generation = null",
        "membership_generation = null",
        "authority_source = '{}'::jsonb",
        "actor_principal_id = 'principal:system'",
      ]) {
        await expect(
          sql`update ${sql.id(table)} set ${sql.raw(mutation)} ${table === "commands" ? sql`where type = 'run.execute.project'` : sql``}`.execute(
            database,
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
    }
    for (const mutation of [
      "authority_model_version = 1",
      `deployment_shape = '{"kind":"personal","defaultWorkspaceBacking":"local-directory"}'::jsonb`,
    ]) {
      await expect(
        sql`update deployments set ${sql.raw(mutation)}`.execute(database),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await database
      .updateTable("deployments")
      .set({ activeHostInstanceId: createId("hostInstance") })
      .execute();
    expect(
      (await database.selectFrom("runs").selectAll().executeTakeFirstOrThrow()).requestedBy,
    ).toBe(fixture.userId);
  });
  it("stores unattended work as the Project and rejects a stale Watch incarnation", async ({
    storeFixture,
  }) => {
    const project = await createProjectIdentityFixture(storeFixture, "unattended");
    const fixture = await insertProjectRunFixture(storeFixture, project, "watch-anchor");
    const database = storeFixture.database;
    const created = await new TriggerStore(database).create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "unattended-watch",
      name: "Files",
      source: { kind: "watch" },
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => {}",
      },
    });
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: 1 })
      .where("triggerId", "=", created.trigger.id)
      .execute();
    const activation = await database
      .selectFrom("triggerWatchActivations")
      .selectAll()
      .where("triggerId", "=", created.trigger.id)
      .executeTakeFirstOrThrow();
    const source = {
      kind: "watch-observation",
      activationId: activation.id,
      revisionId: activation.revisionId,
      triggerId: activation.triggerId,
      observationId: "observation-1",
      incarnation: activation.executionGeneration,
    };
    const messageId = createId("message");
    const runId = createId("run");
    const causalChainId = createId("causalChain");
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", fixture.run.id)
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`insert into causal_chains(id, root_watch_activation_id, root_watch_observation_id, max_delegations, max_autonomous_runs) values (${causalChainId}, ${activation.id}, 'observation-1', 32, 32)`.execute(
        transaction,
      );
      await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content)
        values (${messageId}, ${fixture.thread.id}, 1, 'input', ${project.principalId},
          ${JSON.stringify({ kind: "watch", activationId: activation.id, revisionId: activation.revisionId, triggerId: activation.triggerId, displayName: "Files" })}::jsonb, '[{"type":"text","text":"Changed"}]'::jsonb)`.execute(
        transaction,
      );
      await sql`insert into thread_inputs select (jsonb_populate_record(null::thread_inputs,
        to_jsonb(i) || jsonb_build_object('message_id', ${messageId}::text, 'causal_chain_id', ${causalChainId}::text,
          'idempotency_key', 'unattended', 'requested_by', null, 'membership_generation', null, 'initiator_generation', null,
          'authority_source', ${JSON.stringify(source)}::jsonb))).* from thread_inputs i where message_id = ${fixture.turn.input.messageId}`.execute(
        transaction,
      );
      await sql`insert into runs select (jsonb_populate_record(null::runs,
        to_jsonb(r) || jsonb_build_object('id', ${runId}::text, 'seed_input_id', ${messageId}::text,
          'activation_input_id', ${messageId}::text, 'causal_chain_id', ${causalChainId}::text, 'run_ordinal', 1,
          'requested_by', null, 'membership_generation', null, 'initiator_generation', null, 'status', 'queued', 'completed_at', null,
          'authority_source', ${JSON.stringify(source)}::jsonb))).* from runs r where id = ${fixture.run.id}`.execute(
        transaction,
      );
      await sql`insert into commands select (jsonb_populate_record(null::commands,
        to_jsonb(c) || jsonb_build_object('id', ${createId("command")}::text, 'run_id', ${runId}::text,
          'idempotency_key', 'unattended', 'requested_by', null, 'membership_generation', null, 'initiator_generation', null,
          'payload', jsonb_build_object('type','run.execute.project','runId',${runId}::text,'threadId',${fixture.thread.id}::text),
          'authority_source', ${JSON.stringify(source)}::jsonb))).* from commands c where id = ${fixture.turn.command.id}`.execute(
        transaction,
      );
    });
    const stored = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(runFromRow(stored).requestedBy).toBeNull();
    expect(stored).toMatchObject({
      actorPrincipalId: project.principalId,
      requestedBy: null,
      membershipGeneration: null,
      initiatorGeneration: null,
      originConnectionId: null,
    });
    const duplicateMessageId = createId("message");
    await sql`insert into messages select (jsonb_populate_record(null::messages, to_jsonb(m) || jsonb_build_object('id', ${duplicateMessageId}::text, 'sequence', 2))).* from messages m where id = ${messageId}`.execute(
      database,
    );
    await expect(
      sql`insert into thread_inputs select (jsonb_populate_record(null::thread_inputs, to_jsonb(i) || jsonb_build_object('message_id', ${duplicateMessageId}::text))).* from thread_inputs i where message_id = ${messageId}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "thread_inputs_unattended_idempotency" });
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: Number(activation.executionGeneration) + 1 })
      .where("id", "=", activation.id)
      .execute();
    await expect(
      sql`insert into thread_inputs select (jsonb_populate_record(null::thread_inputs, to_jsonb(i) || jsonb_build_object('idempotency_key','stale-incarnation'))).* from thread_inputs i where message_id = ${messageId}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("adds root metadata without scans or heap rewrites and records the held DDL locks", async ({
    storeFixture,
  }) => {
    await storeFixture.startRunFixture("cutover-ddl", "project");
    const result = await new Migrator({
      db: storeFixture.database,
      migrationTableName: "f5_e_ddl_probe_migrations",
      migrationLockTableName: "f5_e_ddl_probe_lock",
      provider: {
        getMigrations: async () => ({
          probe: {
            up: async (transaction) => {
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
              await sql`drop index thread_inputs_unattended_idempotency; drop index commands_unattended_idempotency;
        drop trigger runs_execution_authority on runs; drop trigger commands_execution_authority on commands;
        drop trigger runs_admitted_project_settings on runs; drop function opensteer_project_run_settings_immutable();
        drop trigger thread_inputs_execution_authority on thread_inputs; drop function opensteer_enforce_input_execution_authority();
        drop trigger deployments_immutable_authority on deployments; drop function opensteer_prevent_deployment_authority_change();
        drop function opensteer_project_work_is_valid(text,text,text,bigint,bigint,text,jsonb);
        drop function opensteer_user_can_execute_thread(text,text,text); drop function opensteer_user_can_execute_environment(text,text,text);
        drop trigger project_principal_scope on principals; drop function opensteer_project_principal_scope();
        alter table principals drop column workspace_id;
        alter table principals add constraint principals_kind_shape_check check ((kind = 'user' and user_id is not null) or (kind in ('channel-identity', 'system') and user_id is null));
        alter table runs drop column initiator_generation, drop column origin_connection_id;
        alter table thread_inputs drop column initiator_generation, drop column origin_connection_id;
        alter table commands drop column initiator_generation, drop column origin_connection_id, drop column membership_generation, drop column originating_grant_id;
        alter table triggers drop column created_by_principal_id;
        alter table trigger_revisions drop column created_by_principal_id;
        alter table trigger_watch_activations drop column created_by_principal_id;
        insert into principals (id, kind, display_name) select 'pri_ddl_' || item, 'system', 'System' from generate_series(1, 100) item
      `.execute(transaction);
              const facts = async () =>
                (
                  await sql<{ relname: string; relfilenode: number; scans: string | null }>`
        select relname, relfilenode, case when relname <> 'principals' then pg_stat_get_xact_numscans(oid) end as scans
        from pg_class where oid in ('principals'::regclass, 'runs'::regclass, 'thread_inputs'::regclass, 'commands'::regclass, 'triggers'::regclass, 'trigger_revisions'::regclass, 'trigger_watch_activations'::regclass)
        order by relname
      `.execute(transaction)
                ).rows;
              const before = await facts();
              await projectAuthorityCutoverMigration.up(transaction);
              expect(await facts()).toEqual(
                before.map((row) => ({
                  ...row,
                  scans:
                    row.relname === "thread_inputs" || row.relname === "commands"
                      ? String(Number(row.scans) + 1)
                      : row.scans,
                })),
              );
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
              expect(locks).toContainEqual({
                relname: "agent_connections",
                mode: "ShareRowExclusiveLock",
              });
              console.info("0172 held migration locks", locks);
            },
          },
        }),
      },
    }).migrateToLatest();
    if (result.error) throw result.error;
  });
});
