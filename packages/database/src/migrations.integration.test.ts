import { personTaskReader } from "./task-reader.js";
import { requestFromRow } from "./request-persistence.js";
import { DeviceIdSchema } from "@opensteer/core";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import {
  AgentEventSchema,
  AgentEventViewSchema,
  createId,
  createToolOutput,
  parseReferenceHref,
  PlaceEnteredEventViewSchema,
  TabIdSchema,
  tabReferenceHref,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { jsonValue } from "./store-primitives.js";
import {
  tabsAndAppsMigrationName,
  agentHomeSettingsMigrationName,
  dropSpecialistsMigrationName,
  onePluginPerOwnerNameMigrationName,
  pluginPackageFormatMigrationName,
  MigrationLineageError,
  migrateToLatest,
  migrationProvider,
  personalTeamBaselineName,
  personalCurrentStateMigrationName,
  waitingInputEditsMigrationName,
} from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { TriggerStore } from "./trigger-store.js";
import { agentGrantsMigrationName } from "./agent-grants-migration.js";
import { agentSessionsMigrationName } from "./agent-sessions-migration.js";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { resolvePersonalReferences } from "./reference-store.js";
import { connectionAttempts, outstandingAttempts } from "./connection-disconnect.js";
import { AgentConnectionStore } from "./agent-connection-store.js";

let clone: TestDatabase;
let database: Kysely<DatabaseSchema>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  await sql`drop schema public cascade; create schema public`.execute(database);
});
afterEach(async () => {
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

async function catalog() {
  return (
    await sql<{ name: string; kind: string; definition: string | null }>`
    select c.relname as name,c.relkind as kind,case when c.relkind='i' then pg_get_indexdef(c.oid) else null end as definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname
  `.execute(database)
  ).rows;
}
async function createOwner() {
  await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape)
    values(${createId("deployment")},'primary',${createId("hostInstance")},'https://home.example.invalid','active','{"kind":"personal"}')
    on conflict(singleton_key) do nothing`.execute(database);
  const id = createId("user");
  await sql`insert into users(id,display_name,email,email_verified,created_at,updated_at) values(${id},'Maya','maya@example.invalid',true,now(),now());
  `.execute(database);
  return id;
}

/** Every migration that sorts before `name`, as a database last migrated by an older build has. */
function migrationsBefore(name: string) {
  return {
    async getMigrations() {
      const all = await migrationProvider().getMigrations();
      return Object.fromEntries(Object.entries(all).filter(([key]) => key < name));
    },
  };
}

async function legacyTask(
  owner: Awaited<ReturnType<typeof seedPersonalFixture>>,
  title: string,
  origin?: { teamId: string; channelId: string; threadRootId: string },
) {
  const id = createId("thread");
  const harnessInstanceId = createId("harnessInstance");
  const model = { providerId: "openai", modelId: "fixture", options: {} };
  await sql`insert into harness_instances (id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id)
    values (${harnessInstanceId},${owner.environmentId},'codex','Codex','{}',1,'ready',true,true,'native')`.execute(
    database,
  );
  await sql`insert into threads (id,lineage_root_thread_id,purpose,listed,title,icon_source,color,environment_id,
    harness_instance_id,model_selection,created_by,created_by_principal_id,team_id,channel_id,thread_root_id)
    select ${id},${id},'task',true,${title},'default','blue',${owner.environmentId},${harnessInstanceId},${JSON.stringify(model)}::jsonb,
      ${owner.userId},id,${origin?.teamId ?? null},${origin?.channelId ?? null},${origin?.threadRootId ?? null}::bigint
    from principals where user_id=${owner.userId}`.execute(database);
  return { id };
}

async function legacyQueuedInput(input: {
  readonly threadId: string;
  readonly requestedBy: string;
  readonly idempotencyKey: string;
  readonly content: readonly unknown[];
}) {
  const messageId = createId("message");
  const chainId = createId("causalChain");
  const thread = await database
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", input.threadId as import("@opensteer/core").ThreadId)
    .executeTakeFirstOrThrow();
  const sequence = thread.nextMessageSequence;
  const author = {
    kind: "human",
    displayName: "Alex",
    principalId: thread.createdByPrincipalId,
    userId: input.requestedBy,
  };
  await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values(${chainId},100,100,0,0)`.execute(
    database,
  );
  await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content) values(${messageId},${thread.id},${sequence},'input',${thread.createdByPrincipalId},${JSON.stringify(author)}::jsonb,${JSON.stringify(input.content)}::jsonb)`.execute(
    database,
  );
  await sql`insert into thread_inputs(message_id,thread_id,actor_principal_id,authority_source,causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state) values(${messageId},${thread.id},${thread.createdByPrincipalId},'{}',${chainId},${input.idempotencyKey},'queue',${sequence},'fixture',${input.requestedBy},'pending')`.execute(
    database,
  );
  const existing = await database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", thread.id)
    .executeTakeFirst();
  const runId = existing ? null : createId("run");
  if (runId)
    await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,access_mode,activation_input_id,seed_input_id,causal_chain_id,requested_by,actor_principal_id,authority_source,run_ordinal,status) values(${runId},${thread.id},${thread.environmentId},${thread.harnessInstanceId},${JSON.stringify(thread.modelSelection)}::jsonb,${thread.accessMode},${messageId},${messageId},${chainId},${input.requestedBy},${thread.createdByPrincipalId},'{}',0,'queued')`.execute(
      database,
    );
  await sql`update threads set next_message_sequence=next_message_sequence+1 where id=${thread.id}`.execute(
    database,
  );
  await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,type,data)
    select deployment_id,sequence+1,${createId("event")},${thread.id},'message.created',${JSON.stringify({ message: { id: messageId, content: input.content }, input: { messageId, replyTarget: null } })}::jsonb from deployment_event_state`.execute(
    database,
  );
  await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
  return { message: { id: messageId }, run: runId ? { id: runId } : null };
}

describe("fresh personal/team lineage", () => {
  it("upgrades waiting edits without touching their messages or leases", async () => {
    await migrateToLatest(database, migrationsBefore(waitingInputEditsMigrationName));
    const ownerFixture = await seedPersonalFixture(database, "/tmp/opensteer-waiting-upgrade");
    const { userId } = ownerFixture;
    const thread = await legacyTask(ownerFixture, "waiting-upgrade");
    const input = await legacyQueuedInput({
      threadId: thread.id,
      requestedBy: userId,
      idempotencyKey: "waiting-upgrade",
      content: [{ type: "text", text: "Original" }],
    });
    await migrateToLatest(database);
    expect(
      await database
        .selectFrom("messages")
        .select(["revision", "editedAt"])
        .where("id", "=", input.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revision: 0, editedAt: null });
    expect(await database.selectFrom("messageRevisions").selectAll().execute()).toEqual([]);
    expect(
      await database
        .selectFrom("threadWorkInputs")
        .select(["editLeaseId", "editLeaseSessionId", "editLeaseExpiresAt"])
        .execute(),
    ).toEqual([{ editLeaseId: null, editLeaseSessionId: null, editLeaseExpiresAt: null }]);
  });
  it("drops stored background model choices from databases made before settings.json held them", async () => {
    await migrateToLatest(database, migrationsBefore(agentHomeSettingsMigrationName));
    await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    await sql`alter table personal_settings add column background_model_preferences jsonb not null default '{"roles":{},"excludedAccounts":[]}'`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(
      (
        await sql`select column_name from information_schema.columns where table_name='personal_settings' and column_name='background_model_preferences'`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(await database.selectFrom("agentHomeSettings").selectAll().execute()).toEqual([]);
  });
  it("gives existing connections their old authority, backfills only queued connection inputs, and exposes lineage through the work view", async () => {
    await migrateToLatest(database, migrationsBefore(agentGrantsMigrationName));
    const owner = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const connectionId = `mcn_${crypto.randomUUID()}`;
    await sql`insert into agent_connections (id,user_id,label,client_name,access_mode,resource,token_hash,expires_at)
      values (${connectionId},${owner.userId},'Agent','Agent','auto','https://h.example/internal/v1/mcp','hash',now() + interval '1 day')`.execute(
      database,
    );
    const delegated = await legacyTask(owner, "Delegated");
    const own = { id: createId("thread") };
    await sql`insert into threads (id,lineage_root_thread_id,purpose,listed,title,icon_source,color,environment_id,
        harness_instance_id,model_selection,created_by,created_by_principal_id)
      select ${own.id},${own.id},purpose,listed,'Own',icon_source,color,environment_id,harness_instance_id,
        model_selection,created_by,created_by_principal_id
      from threads where id = ${delegated.id}`.execute(database);
    // Rows as a Host before 0100_agent_grants wrote them: the connection is named only in the input's source.
    const queued = async (threadId: string, key: string, source: object) => {
      const messageId = createId("message");
      const chainId = createId("causalChain");
      const runId = createId("run");
      await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values(${chainId},100,100,0,0)`.execute(
        database,
      );
      await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content)
        select ${messageId},id,next_message_sequence,'input',created_by_principal_id,'{"kind":"human","displayName":"A"}'::jsonb,'[]'::jsonb
        from threads where id=${threadId}`.execute(database);
      await sql`insert into thread_inputs(message_id,thread_id,actor_principal_id,authority_source,causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state)
        select ${messageId},id,created_by_principal_id,${JSON.stringify(source)}::jsonb,${chainId},${key},'queue',next_message_sequence,'fixture',created_by,'pending'
        from threads where id=${threadId}`.execute(database);
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,access_mode,activation_input_id,seed_input_id,causal_chain_id,requested_by,actor_principal_id,authority_source,run_ordinal,status)
        select ${runId},id,environment_id,harness_instance_id,model_selection,access_mode,${messageId},${messageId},${chainId},created_by,created_by_principal_id,'{}',0,'queued'
        from threads where id=${threadId}`.execute(database);
      return { message: { id: messageId }, run: { id: runId } };
    };
    const sent = await queued(delegated.id, "connection-sent", {
      kind: "connection",
      connectionId,
      userId: owner.userId,
    });
    const typed = await queued(own.id, "person-typed", {
      kind: "user-session",
      userId: owner.userId,
    });
    await sql`insert into plugin_executions (id,owner_user_id,thread_id,run_id,caller,mode,state)
      values ('legacy-connected',${owner.userId},${delegated.id},${sent.run.id},'delegated','automatic','running'),
             ('legacy-personal',${owner.userId},${own.id},${typed.run.id},'personal','automatic','running')`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(
      await database
        .selectFrom("agentConnections")
        .select(["grant", "grantRevision", "consentVersion", "clientFingerprint", "removedAt"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      grant: { scope: "everything" },
      grantRevision: 1,
      consentVersion: 1,
      clientFingerprint: null,
      removedAt: null,
    });
    expect(
      await database
        .selectFrom("threads")
        .select(["id", "originConnectionId"])
        .where("id", "in", [delegated.id, own.id] as never)
        .orderBy("title")
        .execute(),
    ).toEqual([
      // Existing tasks stay the person's: a mutable queue order never proves lineage.
      { id: delegated.id, originConnectionId: null },
      { id: own.id, originConnectionId: null },
    ]);
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["messageId", "connectionId"])
        .where("threadId", "in", [delegated.id, own.id] as never)
        .orderBy("idempotencyKey")
        .execute(),
    ).toEqual([
      { messageId: sent.message.id, connectionId },
      { messageId: typed.message.id, connectionId: null },
    ]);
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "connectionId"])
        .orderBy("connectionId")
        .execute(),
    ).toEqual([
      // A Run still queued from a connection's input works for that connection, not the person.
      { id: sent.run.id, connectionId },
      { id: typed.run.id, connectionId: null },
    ]);
    // Dequeue reads inputs through `thread_work_inputs`, so the view must carry the new column.
    expect(
      await database
        .selectFrom("threadWorkInputs")
        .select(["messageId", "connectionId"])
        .where("threadId", "in", [delegated.id, own.id] as never)
        .orderBy("idempotencyKey")
        .execute(),
    ).toEqual([
      { messageId: sent.message.id, connectionId },
      { messageId: typed.message.id, connectionId: null },
    ]);
    expect(await database.selectFrom("triggers").select("originConnectionId").execute()).toEqual(
      [],
    );
    expect(
      await database
        .selectFrom("pluginExecutions")
        .select(["id", "connectionId", "engineProcess"])
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "legacy-connected", connectionId, engineProcess: null },
      { id: "legacy-personal", connectionId: null, engineProcess: null },
    ]);
    const connections = new AgentConnectionStore(database);
    await connections.revoke(owner.userId, connectionId);
    const pluginAttempts = async () =>
      outstandingAttempts(await connectionAttempts(database, connectionId))
        .filter(({ kind }) => kind === "plugin")
        .map(({ id }) => id);
    expect(await pluginAttempts()).toEqual(["legacy-connected"]);
    for (const state of ["interrupted", "cancelled"] as const) {
      await database
        .updateTable("pluginExecutions")
        .set({ state })
        .where("id", "=", "legacy-connected")
        .execute();
      expect(await pluginAttempts()).toEqual(["legacy-connected"]);
    }
    expect((await connections.list(owner.userId, { includeRevoked: true }))[0]?.state).toBe(
      "stopping",
    );
    await database
      .updateTable("pluginExecutions")
      .set({ terminalEvidenceAt: new Date() })
      .where("id", "=", "legacy-connected")
      .execute();
    expect(await pluginAttempts()).toEqual([]);
  });
  it("adds agent sessions without touching existing tasks, and keeps their invariants in the database", async () => {
    await migrateToLatest(database, migrationsBefore(agentSessionsMigrationName));
    const owner = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const existing = await legacyTask(owner, "Existing");
    await migrateToLatest(database);
    expect(
      await database
        .selectFrom("threads")
        .select("worker")
        .where("id", "=", existing.id as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ worker: "native" });
    // A task worked by an external agent always belongs to a connection's lineage.
    await expect(
      sql`update threads set worker = 'external' where id = ${existing.id}`.execute(database),
    ).rejects.toMatchObject({ constraint: "threads_external_worker_lineage" });
    const reserved = async () =>
      sql`insert into harness_instances (id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id,removed_at)
        select ${createId("harnessInstance")},environment_id,'external-agent','Connected agent','{}',1,'isolated',false,false,'external-agent',now()
        from threads where id = ${existing.id}`.execute(database);
    await reserved();
    await expect(reserved()).rejects.toMatchObject({
      constraint: "harness_instances_external_agent",
    });
    const profile = createId("browserProfile");
    await sql`insert into browser_profiles (id,owner_id,name) values (${profile},${owner.userId},'Work')`.execute(
      database,
    );
    expect(
      await database.selectFrom("browserProfiles").select("purpose").executeTakeFirstOrThrow(),
    ).toEqual({ purpose: "person" });
    await expect(
      sql`update browser_profiles set purpose = 'shared' where id = ${profile}`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps every plugin a person registered under one name, each later one under a free name", async () => {
    await migrateToLatest(database, migrationsBefore(onePluginPerOwnerNameMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const plugin = (id: string, name: string, createdAt: string) => ({
      id,
      name,
      scope: "deployment" as const,
      source: jsonValue({}),
      installedBy: userId,
      currentVersionId: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    await database
      .insertInto("plugins")
      .values([
        plugin("iin_00000000-0000-4000-8000-0000000000aa", "office-light", "2026-11-01T00:00:00Z"),
        plugin("iin_00000000-0000-4000-8000-0000000000bb", "office-light", "2026-11-01T00:00:01Z"),
        // Already holds the name the duplicate above would first be given.
        plugin(
          "iin_00000000-0000-4000-8000-0000000000cc",
          "office-light-000000bb",
          "2026-11-01T00:00:02Z",
        ),
        // Ends like the second, so its first two choices are taken, one by this migration.
        plugin("iin_00000000-0000-4000-8000-1000000000bb", "office-light", "2026-11-01T00:00:03Z"),
      ])
      .execute();
    await migrateToLatest(database);
    expect(
      await database.selectFrom("plugins").select(["id", "name"]).orderBy("id").execute(),
    ).toEqual([
      { id: "iin_00000000-0000-4000-8000-0000000000aa", name: "office-light" },
      { id: "iin_00000000-0000-4000-8000-0000000000bb", name: "office-light-000000bb-2" },
      { id: "iin_00000000-0000-4000-8000-0000000000cc", name: "office-light-000000bb" },
      { id: "iin_00000000-0000-4000-8000-1000000000bb", name: "office-light-000000bb-3" },
    ]);
    await expect(
      database
        .insertInto("plugins")
        .values(
          plugin(
            "iin_00000000-0000-4000-8000-0000000000dd",
            "office-light",
            "2026-11-02T00:00:00Z",
          ),
        )
        .execute(),
    ).rejects.toThrow(/plugins_owner_name/u);
    const upgraded = await catalog();
    await sql`drop schema public cascade; create schema public`.execute(database);
    await migrateToLatest(database);
    expect(await catalog()).toEqual(upgraded);
  });
  it("records no package format for a plugin version stored before formats were recorded", async () => {
    await migrateToLatest(database, migrationsBefore(pluginPackageFormatMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    await sql`insert into plugins(id, name, scope, source, installed_by, current_version_id)
      values ('iin_00000000-0000-4000-8000-0000000000aa', 'office-light', 'deployment', '{}',
        ${userId}, 'version-before')`.execute(database);
    await sql`insert into plugin_versions(id, plugin_id, digest, manifest)
      values ('version-before', 'iin_00000000-0000-4000-8000-0000000000aa', ${"a".repeat(64)},
        '{"name":"office-light"}')`.execute(database);
    await migrateToLatest(database);
    expect(
      await database.selectFrom("pluginVersions").select(["id", "packageFormat"]).execute(),
    ).toEqual([{ id: "version-before", packageFormat: null }]);
  });
  it("drops specialist storage and settings from databases made before specialists were removed", async () => {
    await migrateToLatest(database, migrationsBefore(dropSpecialistsMigrationName));
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    await sql`create table specialists (id text primary key);
      alter table threads add column specialist_id text;
      alter table plugin_versions add column specialist_manifest jsonb`.execute(database);
    const skill = { kind: "skill", fullName: "notes" };
    const specialist = { kind: "specialist", pluginId: "p", ownerUserId: userId };
    await sql`insert into plugin_owner_settings (owner_user_id, target_key, target, enabled, revision)
      values (${userId}, 'specialist', ${JSON.stringify(specialist)}::jsonb, false, 1),
        (${userId}, 'skill', ${JSON.stringify(skill)}::jsonb, false, 1)`.execute(database);
    await migrateToLatest(database);
    expect(
      (
        await sql`select table_name, column_name from information_schema.columns where table_schema='public' and (table_name='specialists' or column_name in ('specialist_id','specialist_manifest'))`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(await database.selectFrom("pluginOwnerSettings").select("target").execute()).toEqual([
      { target: skill },
    ]);
  });
  it("drops service integrations and keeps device, messaging and local-server rows", async () => {
    await migrateToLatest(database, migrationsBefore(dropSpecialistsMigrationName));
    const person = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const { userId, runnerId } = person;
    // The storage only databases made before this migration have.
    await sql`create table integration_provider_applications (id text primary key);
      create table mcp_oauth_credentials (connection_id text primary key);
      create table integration_application_source_defaults (provider text primary key);
      alter table integration_connections add column provider_application_id text,
        add column application_source jsonb, add column auth_method_id text,
        add column authorization_digest text, add column granted_scopes jsonb;
      alter table integration_installations add column adapter_snapshot jsonb;
      alter table integration_auth_attempts add column result_connection_id text;
      alter table integration_connections drop constraint integration_connections_connection_kind_check;
      alter table integration_installations drop constraint integration_installations_source_kind_check`.execute(
      database,
    );
    const installation = (id: string, sourceKind: string, pluginId: string | null) =>
      sql`insert into integration_installations
        (id, name, title, description, plugin_id, source_kind, trust, manifest, provenance, status, revision)
        values (${id}, ${id}, ${id}, '', ${pluginId}, ${sourceKind}, 'built-in', '{}', '{}', 'active', 1)`.execute(
        database,
      );
    const server = (id: string, installationId: string, transport: object, requirement: object) =>
      sql`insert into integration_servers
        (id, installation_id, name, transport, connection_requirement, status, tool_generation)
        values (${id}, ${installationId}, 'default', ${JSON.stringify(transport)}::jsonb,
          ${JSON.stringify(requirement)}::jsonb, 'active', 1)`.execute(database);
    const connection = (id: string, kind: string, serverId: string | null) =>
      sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name,
          capabilities, integration_server_id, granted_scopes, runner_id, device_id, integration_definition_id)
        values (${id}, ${userId}, ${kind}, ${kind}, 'computer', 'connected', ${id}, '[]',
          ${serverId}, '[]', ${kind === "computer" ? runnerId : null}, ${kind === "computer" ? runnerId : null},
          ${kind === "computer" ? "apple-calendar" : null})`.execute(database);
    const grant = (id: string, installationId: string, connectionId: string | null) =>
      sql`insert into integration_grants
        (access, id, owner_user_id, installation_id, connection_id, alias, is_default, created_by, status)
        values ('read', ${id}, ${userId}, ${installationId}, ${connectionId}, ${id}, false, ${userId},
          'active')`.execute(database);
    await installation("device", "built-in", null);
    await server(
      "device-server",
      "device",
      { type: "computer", definitionId: "apple-calendar" },
      {
        kind: "computer",
        definitionId: "apple-calendar",
      },
    );
    await installation("local", "plugin", "local-plugin");
    await server(
      "local-server",
      "local",
      { type: "runner", runnerId: null, launch: { type: "stdio", command: "./tv" } },
      { kind: "none" },
    );
    await installation("gmail", "built-in", null);
    await server(
      "gmail-server",
      "gmail",
      { type: "adapter", adapter: "openapi", definitionId: "gmail" },
      {
        kind: "provider",
        definitionId: "gmail",
        provider: "google",
        providerApplicationRequired: true,
      },
    );
    await installation("remote", "remote-mcp", null);
    await server(
      "remote-server",
      "remote",
      { type: "streamable-http", url: "https://mcp.example.test", headers: {} },
      { kind: "mcp-oauth" },
    );
    await connection("computer-connection", "computer", "device-server");
    await connection("channel-connection", "channel", null);
    await connection("google-account", "provider-account", null);
    await connection("mcp-account", "mcp-oauth", "remote-server");
    await sql`insert into mcp_oauth_credentials values ('mcp-account');
      insert into integration_provider_applications values ('google-app')`.execute(database);
    const channelCredential = createId("credential");
    const serviceCredential = createId("credential");
    for (const [id, connectionId] of [
      [channelCredential, "channel-connection"],
      [serviceCredential, "google-account"],
    ] as const) {
      await sql`insert into credentials(id,owner_id,name,provider,encrypted_payload,encryption_key_version,metadata)
        values(${id},${userId},${connectionId},'fixture',${Buffer.from("sealed-fixture")},1,'{}')`.execute(
        database,
      );
      await sql`update integration_connections set credential_id=${id} where id=${connectionId}`.execute(
        database,
      );
      await sql`insert into credential_access_audit(id,actor_id,credential_id,connection_id,purpose)
        values(${connectionId},${userId},${id},${connectionId},'channel-transport')`.execute(
        database,
      );
    }
    await grant("device-grant", "device", "computer-connection");
    await grant("local-grant", "local", null);
    await grant("gmail-grant", "gmail", "google-account");
    await grant("remote-grant", "remote", "mcp-account");
    await sql`insert into plugin_owner_settings (owner_user_id, target_key, target, enabled, revision)
      values (${userId}, '["service","gmail"]', '{"kind":"service","definitionId":"gmail"}', false, 1),
        (${userId}, '["device-app","apple-calendar"]', '{"kind":"device-app","definitionId":"apple-calendar"}', false, 1),
        (${userId}, '["plugin","local-plugin"]', '{"kind":"plugin","pluginId":"local-plugin"}', false, 2)`.execute(
      database,
    );

    await sql`create unique index if not exists integration_connections_definition_identity_unique
      on integration_connections(integration_definition_id, external_tenant_id, external_identity_id)
      nulls not distinct where connection_kind='provider-account' and external_identity_id is not null and status<>'revoked'`.execute(
      database,
    );
    const task = await legacyTask(person, "Existing task");
    const input = await legacyQueuedInput({
      threadId: task.id,
      requestedBy: userId,
      idempotencyKey: "service-upgrade-input",
      content: [{ type: "text", text: "Existing task" }],
    });
    const run = { id: input.run!.id, environmentId: person.environmentId };
    await sql`update runs set status='completed', completed_at=now() where id=${run.id}`.execute(
      database,
    );
    const seedTrigger = async (
      name: string,
      source: object,
      kind: "schedule" | "watch",
      program: string,
    ) => {
      const triggerId = createId("trigger");
      const revisionId = createId("triggerRevision");
      await database.transaction().execute(async (tx) => {
        await sql`insert into triggers(id,anchor_thread_id,created_by,idempotency_key,request_fingerprint,
          name,kind,status,current_revision_id,consecutive_failures)
          values(${triggerId},${task.id},${userId},${name},${name},${name},${kind},'active',${revisionId},0)`.execute(
          tx,
        );
        await sql`insert into trigger_revisions(id,trigger_id,ordinal,source,program,created_by)
          values(${revisionId},${triggerId},1,${JSON.stringify(source)}::jsonb,
            ${JSON.stringify({ language: "javascript", source: program, toolContractVersion: 4 })}::jsonb,${userId})`.execute(
          tx,
        );
        if (kind === "watch")
          await sql`insert into trigger_watch_activations(id,trigger_id,revision_id,environment_id,
            anchor_thread_id,created_by,desired,observed,execution_generation,restart_count,
            consecutive_failures,stdout_tail,stderr_tail)
            values(${createId("triggerWatchActivation")},${triggerId},${revisionId},${person.environmentId},
              ${task.id},${userId},'active','starting',1,0,0,'','')`.execute(tx);
      });
      return {
        trigger: { id: triggerId },
        revision: {
          id: revisionId,
          program: { language: "javascript", source: program, toolContractVersion: 5 },
        },
      };
    };
    const schedule = {
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    };
    const savedSchedule = await seedTrigger(
      "Saved schedule",
      schedule,
      "schedule",
      'export default async ({opensteer}) => opensteer.callTool("opensteer_task_list", {})',
    );
    const savedWatch = await seedTrigger(
      "Saved watch",
      { kind: "watch" },
      "watch",
      'export default async ({opensteer}) => { await opensteer.callTool("opensteer_task_list", {}); await new Promise(() => setInterval(() => {}, 1000)); }',
    );
    const retiredSchedule = await seedTrigger(
      "Schedule using a retired tool",
      schedule,
      "schedule",
      'export default async ({opensteer}) => opensteer.callTool("integration_call", {})',
    );
    const removedRequests: string[] = [];
    const keptRequests: string[] = [];
    for (const [kind, installationId, manifest] of [
      ["integration.install", "gmail", null],
      ["integration.input", "remote", null],
      ["integration.access", "gmail", null],
      [
        "integration.access",
        null,
        { kind: "catalog", definition: { id: "gmail", adapter: "openapi" } },
      ],
      ["integration.access", "device", null],
      ["integration.access", "local", null],
    ] as const) {
      const id = createId("request");
      const keep = installationId === "device" || installationId === "local";
      (keep ? keptRequests : removedRequests).push(id);
      const payload = {
        kind,
        access: "read",
        installationId,
        manifest,
        reason: "Existing request",
        requestedConnectionId: null,
        requestedServerId: null,
      };
      await sql`insert into requests (id,kind,mode,status,originating_thread_id,originating_run_id,call_id,requested_by,required_actor,presentation,payload)
        values (${id},${kind},'durable','pending',${task.id},${run.id},${id},${userId},'requester',
        '{"kind":"external","title":"Existing request","subject":{"kind":"integration.access","id":"app"}}',${JSON.stringify(payload)}::jsonb)`.execute(
        database,
      );
      await sql`insert into integration_request_details(request_id,access,installation_id,manifest) values(${id},'read',${installationId},${JSON.stringify(manifest)}::jsonb)`.execute(
        database,
      );
      await sql`insert into request_continuations(request_id,status) values(${id},'waiting')`.execute(
        database,
      );
      const row = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const request = keep ? requestFromRow(row) : { id, kind, payload };
      for (const type of [
        "request.opened",
        "request.updated",
        "request.resolved",
        "request.cancelled",
      ]) {
        await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
        await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
          select deployment_id,sequence,${createId("event")},${task.id},${run.id},${run.environmentId},${type},
          ${JSON.stringify(type === "request.cancelled" ? { requestId: id, reason: "resource-deleted" } : { request: type === "request.resolved" ? { ...request, status: "declined", resolvedAt: new Date().toISOString(), resolvedBy: userId, response: { kind: "external", value: { decision: "declined" } } } : request })}::jsonb from deployment_event_state`.execute(
          database,
        );
      }
    }
    for (const [kind, payload] of [
      ["integration.install", {}],
      ["integration.input", {}],
      ["integration.access", { installationId: "gmail", manifest: null }],
      [
        "integration.access",
        { installationId: null, manifest: { kind: "catalog", definition: { adapter: "openapi" } } },
      ],
    ] as const) {
      const id = createId("request");
      for (const [type, data] of [
        ["request.opened", { request: { id, kind, payload } }],
        ["request.cancelled", { requestId: id, reason: "resource-deleted" }],
      ] as const) {
        await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
        await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
          select deployment_id,sequence,${createId("event")},${task.id},${run.id},${run.environmentId},${type},
          ${JSON.stringify(data)}::jsonb from deployment_event_state`.execute(database);
      }
    }
    await sql`create schema plugin_engine; create table plugin_engine.kept_data(id text primary key);
      insert into plugin_engine.kept_data values('engine-data')`.execute(database);
    const toolEventId = createId("event");
    await sql`update deployment_event_state set sequence=sequence+1`.execute(database);
    await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
      select deployment_id,sequence,${toolEventId},${task.id},${run.id},${run.environmentId},'tool.started',
      '{"callId":"old-call","tool":{"name":"integration_call","namespace":"opensteer"},"arguments":{},"integration":{"integration":"Gmail"}}' from deployment_event_state`.execute(
      database,
    );
    await migrateToLatest(database, migrationProvider({ personalCurrentState: false }));

    expect(
      (
        await sql<{
          indexname: string;
        }>`select indexname from pg_indexes where schemaname = 'public'
        and indexname in ('messages_created_at', 'thread_inputs_updated_at') order by indexname`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ indexname: "messages_created_at" }, { indexname: "thread_inputs_updated_at" }]);
    expect(
      (await database.selectFrom("requests").select("id").execute()).map(({ id }) => id).sort(),
    ).toEqual(keptRequests.sort());
    expect(
      (await database.selectFrom("integrationRequestDetails").select("requestId").execute())
        .map(({ requestId }) => requestId)
        .sort(),
    ).toEqual(keptRequests.sort());
    const historical = await sql<{ data: { request?: { id: string }; requestId?: string } }>`
      select data from deployment_events where type like 'request.%'`.execute(database);
    expect(historical.rows.map(({ data }) => data.request?.id ?? data.requestId).sort()).toEqual(
      keptRequests.flatMap((id) => Array<string>(4).fill(id)).sort(),
    );
    const oldTool = (
      await sql<{
        data: unknown;
      }>`select data from deployment_events where event_id=${toolEventId}`.execute(database)
    ).rows[0]!;
    expect(oldTool.data).toMatchObject({ tool: { name: "retired_service", namespace: "history" } });
    expect(oldTool.data).not.toHaveProperty("integration");
    expect((await sql`select * from plugin_engine.kept_data`.execute(database)).rows).toEqual([
      { id: "engine-data" },
    ]);
    await sql`drop schema plugin_engine cascade`.execute(database);
    const ids = async (table: string) =>
      (
        await sql<{ id: string }>`select id from ${sql.table(table)} order by id`.execute(database)
      ).rows.map(({ id }) => id);
    expect(await ids("integration_installations")).toEqual(["device", "local"]);
    expect(await ids("integration_servers")).toEqual(["device-server", "local-server"]);
    expect(await ids("integration_connections")).toEqual([
      "channel-connection",
      "computer-connection",
    ]);
    expect(await ids("integration_grants")).toEqual(["device-grant", "local-grant"]);
    expect(await ids("credentials")).toEqual([channelCredential]);
    expect(
      (
        await sql<{
          name: string | null;
        }>`select to_regclass('public.integration_connections_definition_identity_unique')::text as name`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ name: null }]);
    expect(await ids("credential_access_audit")).toEqual(["channel-connection"]);
    expect(await database.selectFrom("pluginOwnerSettings").select("targetKey").execute()).toEqual(
      [],
    );
    expect(
      await database
        .selectFrom("pluginAgentSettings")
        .select(["pluginId", "access"])
        .orderBy("pluginId")
        .execute(),
    ).toEqual([
      { pluginId: "app_device_computer-connection", access: "off" },
      { pluginId: "app_server_local-server", access: "off" },
    ]);
    // Before 0057 drops the legacy program column, verify 0034 upgraded v4 -> v5 on clean rows only.
    for (const saved of [savedSchedule, savedWatch]) {
      expect(
        (
          await sql<{
            program: unknown;
          }>`select program from trigger_revisions where id = ${saved.revision.id}`.execute(
            database,
          )
        ).rows[0],
      ).toMatchObject({ program: saved.revision.program });
    }
    expect(
      (
        await sql<{
          program: unknown;
        }>`select program from trigger_revisions where id = ${retiredSchedule.revision.id}`.execute(
          database,
        )
      ).rows[0],
    ).toMatchObject({ program: { toolContractVersion: 4 } });
    await migrateToLatest(database);
    const triggers = new TriggerStore(database);
    for (const saved of [savedSchedule, savedWatch]) {
      const detail = await triggers.getForOwner(saved.trigger.id, userId, 1, personTaskReader);
      expect(detail?.revision.script).toBeNull();
      expect(detail?.revision.legacySource).toBe(saved.revision.program.source);
      expect(detail?.trigger.status).toBe("paused");
    }
    const retiredDetail = await triggers.getForOwner(
      retiredSchedule.trigger.id,
      userId,
      1,
      personTaskReader,
    );
    expect(retiredDetail?.revision.script).toBeNull();
    expect(retiredDetail?.revision.legacySource).toBe(retiredSchedule.revision.program.source);
    expect(
      (await triggers.getForOwner(savedWatch.trigger.id, userId, 1, personTaskReader))?.activation,
    ).toMatchObject({
      desired: "stopped",
    });
    expect(
      (
        await sql`select table_name, column_name from information_schema.columns where table_schema='public'
          and (table_name in ('integration_provider_applications', 'mcp_oauth_credentials', 'integration_application_source_defaults')
            or column_name in ('provider_application_id', 'application_source', 'auth_method_id', 'authorization_digest', 'granted_scopes', 'adapter_snapshot', 'result_connection_id'))`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await expect(
      sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name, capabilities)
        values ('late-account', ${userId}, 'provider-account', 'google', 'computer', 'connected',
          'Late', '[]')`.execute(database),
    ).rejects.toThrow("integration_connections_connection_kind_check");
    expect(
      (await database.selectFrom("requests").select("id").execute()).map(({ id }) => id).sort(),
    ).toEqual(keptRequests.sort());
    expect(
      await database
        .selectFrom("toolCalls")
        .select("tool")
        .where("callId", "=", "old-call")
        .executeTakeFirst(),
    ).toMatchObject({ tool: { name: "retired_service", namespace: "history" } });
  });
  it("upgrades existing queued inputs with fresh context disabled in the table and work view", async () => {
    await migrateToLatest(database, migrationsBefore("0005_thread_input_fresh_context"));
    const ownerFixture = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const { userId } = ownerFixture;
    const thread = await legacyTask(ownerFixture, "before-fresh-context");
    const input = await legacyQueuedInput({
      content: [{ type: "text", text: "Already queued" }],
      idempotencyKey: "before-upgrade",
      requestedBy: userId,
      threadId: thread.id,
    });
    await migrateToLatest(database);
    for (const table of ["threadInputs", "threadWorkInputs"] as const) {
      expect(
        await database.selectFrom(table).select(["messageId", "freshContext"]).execute(),
      ).toEqual([{ messageId: input.message.id, freshContext: false }]);
    }
  });
  it("projects Account ownership changes and fences an acknowledgement from before revocation", async () => {
    await migrateToLatest(database);
    const { userId } = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      issuer: "https://accounts.invalid",
      providerId: "oidc:account",
    });
    const accountId = "account-owner";
    const id = createId("authAccount");
    await database
      .insertInto("authAccounts")
      .values({ id, userId, providerId: "oidc:account", accountId })
      .execute();
    const [pending] = await directory.claimPending();
    expect(pending).toMatchObject({ userId, present: true, generation: 1 });
    if (!pending) throw new Error("Owner directory projection was not queued");
    await directory.refreshUser(userId);
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", userId)
      .execute();
    await expect(directory.complete(pending)).resolves.toBe(false);
    const [removed] = await directory.claimPending();
    expect(removed).toMatchObject({ userId, present: false, generation: 2 });
    await database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", userId)
      .execute();
    const [restored] = await directory.claimPending();
    expect(restored).toMatchObject({ userId, present: true, generation: 3 });
    await database.deleteFrom("authAccounts").where("id", "=", id).execute();
    expect(await directory.claimPending()).toEqual([
      expect.objectContaining({ userId, present: false, generation: 4 }),
    ]);
  });
  it("preserves personal operation journals and production upsert identities", async () => {
    await migrateToLatest(database);
    const operation = (
      await sql<{
        dataType: string;
      }>`select data_type from information_schema.columns where table_schema='public' and table_name='personal_remote_account_link' and column_name='account_operation'`.execute(
        database,
      )
    ).rows;
    expect(operation).toEqual([{ dataType: "jsonb" }]);
    const revision = (
      await sql<{
        columnDefault: string;
      }>`select column_default from information_schema.columns where table_schema='public' and table_name='delegations' and column_name='revision'`.execute(
        database,
      )
    ).rows;
    expect(revision).toEqual([{ columnDefault: "1" }]);
    expect(
      (
        await sql`select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and ((table_name='plugin_owner_settings' and column_name='revision') or (table_name='personal_desktop_update' and column_name='detail')) order by table_name`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        tableName: "personal_desktop_update",
        columnName: "detail",
        dataType: "text",
        isNullable: "YES",
      },
      {
        tableName: "plugin_owner_settings",
        columnName: "revision",
        dataType: "integer",
        isNullable: "NO",
      },
    ]);
    const constraints = (
      await sql<{
        name: string;
        definition: string;
      }>`select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'browser_session_uses'::regclass and contype='u' order by conname`.execute(
        database,
      )
    ).rows;
    expect(constraints).toEqual([
      {
        name: "browser_session_uses_identity",
        definition: "UNIQUE NULLS NOT DISTINCT (session_id, thread_id, run_id, tab_id)",
      },
    ]);
    const indexes = await catalog();
    expect(indexes.find(({ name }) => name === "delegations_result_message")?.definition).toMatch(
      /^CREATE INDEX .*\(result_message_id\)/u,
    );
    expect(
      indexes.find(({ name }) => name === "automation_failure_notices_occurrence_id_key")
        ?.definition,
    ).toContain("UNIQUE INDEX");
    expect(indexes.find(({ name }) => name === "threads_creator_created")?.definition).toContain(
      "created_by, created_at DESC, id DESC",
    );
  });
  it("migrates existing device policies without widening shell access or binding sessions", async () => {
    await migrateToLatest(database, migrationsBefore("0008_devices"));
    const fixture = await seedPersonalFixture(database, "/tmp/pre-devices-home");
    const original = { reach: "nobody", commands: false, forwarding: true, shares: [] };
    await sql`update runners set access_policy = ${JSON.stringify(original)}::jsonb`.execute(
      database,
    );
    await migrateToLatest(database);
    const runner = await database
      .selectFrom("devices")
      .select("accessPolicy")
      .where("id", "=", DeviceIdSchema.parse(fixture.runnerId))
      .executeTakeFirstOrThrow();
    expect(runner.accessPolicy).toEqual({ ...original, browser: true, apps: true });
    const columns = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns where table_name='auth_sessions' and column_name='device_id'`.execute(
      database,
    );
    expect(columns.rows).toEqual([{ name: "device_id" }]);
  });
  it("applies both kinds' tables once and survives restart", async () => {
    await migrateToLatest(database);
    const before = await catalog();
    expect(before.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "personal_settings",
        "threads",
        "client_sync_state",
        "transcript_items",
        "team_messages",
        "team_agent_requests",
        "personal_team_requests",
        "team_topics",
        "team_topic_grants",
        "team_notes",
        "team_note_versions",
      ]),
    );
    expect(
      before.filter((row) =>
        /workspace|project_runtime|effective_membership|team_run_tickets|team_channel_changes|team_reactions|team_command_receipts|team_message_search|knowledge/.test(
          row.name,
        ),
      ),
    ).toEqual([]);
    await database.destroy();
    database = createDatabase({ connectionString: clone.url });
    await migrateToLatest(database);
    expect(await catalog()).toEqual(before);
    expect(
      (
        await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
          database,
        )
      ).rows,
    ).toEqual(Object.keys(await migrationProvider().getMigrations()).map((name) => ({ name })));
  });
  it.each([
    ["app_versions", "size_bytes", "integer", "NO"],
    ["computer_app_setup_requests", "app", "jsonb", "NO"],
    ["computer_app_setup_requests", "server", "jsonb", "NO"],
    ["integration_connections", "computer_app", "jsonb", "NO"],
    ["plugin_owner_settings", "revision", "integer", "NO"],
    ["delegations", "revision", "integer", "NO"],
    ["tab_layouts", "items", "jsonb", "NO"],
    ["machine_access_events", "id", "bigint", "YES"],
  ])("preserves the private storage contract for %s.%s", async (table, column, type, identity) => {
    await migrateToLatest(database);
    const result = await sql<{ dataType: string; isIdentity: string }>`
      select data_type, is_identity from information_schema.columns
      where table_schema='public' and table_name=${table} and column_name=${column}
    `.execute(database);
    expect(result.rows).toEqual([{ dataType: type, isIdentity: identity }]);
  });
  it("starts credentials at a positive generation and keys browser attachments by session and binding", async () => {
    await migrateToLatest(database);
    const generation = await sql<{ columnDefault: string }>`
      select column_default from information_schema.columns
      where table_schema='public' and table_name='integration_connections' and column_name='credential_generation'
    `.execute(database);
    expect(generation.rows).toEqual([{ columnDefault: "1" }]);
    const key = await sql<{ columns: string[] }>`
      select array_agg(a.attname::text order by k.ordinality) as columns
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
      where c.conrelid='browser_session_attachments'::regclass and c.contype='p'
    `.execute(database);
    expect(key.rows[0]?.columns).toEqual(["session_id", "agent_binding_id"]);
  });
  it("publishes one authority generation per owner at commit and rolls invalidations back", async () => {
    await migrateToLatest(database);
    const owner = await createOwner();
    const generation = () =>
      database
        .selectFrom("integrationAuthorityGenerations")
        .select("generation")
        .where("ownerUserId", "=", owner)
        .executeTakeFirst();
    await database.transaction().execute(async (tx) => {
      await sql`insert into integration_connections
        (id, owner_user_id, connection_kind, provider, connection_method, status, display_name, capabilities)
        values ('connection', ${owner}, 'channel', 'fixture', 'computer', 'connected', 'Initial', '[]')`.execute(
        tx,
      );
      await sql`update integration_connections set display_name = 'Changed' where id = 'connection'`.execute(
        tx,
      );
      expect(await generation()).toBeUndefined();
      expect(
        await tx.selectFrom("integrationAuthorityPending").select("ownerUserId").execute(),
      ).toEqual([{ ownerUserId: owner }]);
    });
    expect(await generation()).toEqual({ generation: 1 });
    const rejection = new Error("rejected mutation");
    await expect(
      database.transaction().execute(async (tx) => {
        await sql`update integration_connections set display_name = 'Rolled back' where id = 'connection'`.execute(
          tx,
        );
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(await generation()).toEqual({ generation: 1 });
    expect(await database.selectFrom("integrationAuthorityPending").selectAll().execute()).toEqual(
      [],
    );
  });
  it("rejects a legacy ledger before changing its schema or data", async () => {
    await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null); insert into kysely_migration values('0001_baseline','old'); create table retained(value text); insert into retained values('untouched')`.execute(
      database,
    );
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
    expect((await sql`select * from retained`.execute(database)).rows).toEqual([
      { value: "untouched" },
    ]);
    expect((await sql`select * from kysely_migration`.execute(database)).rows).toEqual([
      { name: "0001_baseline", timestamp: "old" },
    ]);
  });
  it.each([false, true])(
    "refuses unversioned data with an empty ledger present: %s",
    async (emptyLedger) => {
      await sql`create table retained(value text)`.execute(database);
      if (emptyLedger)
        await sql`create table kysely_migration(name varchar(255) primary key,timestamp varchar(255) not null)`.execute(
          database,
        );
      const before = await catalog();
      await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
      expect(await catalog()).toEqual(before);
    },
  );
  it("refuses an unknown forward lineage before writing", async () => {
    await migrateToLatest(database);
    await sql`insert into kysely_migration values('9999_future','future')`.execute(database);
    const before = await catalog();
    await expect(migrateToLatest(database)).rejects.toBeInstanceOf(MigrationLineageError);
    expect(await catalog()).toEqual(before);
  });
});

it("migrates baseline read positions, including the declared message-only and newer-active exceptions", async () => {
  const { migrationProvider } = await import("./migrations.js");
  const migrations = await migrationProvider().getMigrations();
  await migrateToLatest(database, {
    getMigrations: async () => ({
      [personalTeamBaselineName]: migrations[personalTeamBaselineName]!,
    }),
  });
  const person = await seedPersonalFixture(database, "/tmp/opensteer-visit-migration");
  const principal = await database
    .selectFrom("principals")
    .select("id")
    .where("userId", "=", person.userId)
    .executeTakeFirstOrThrow();
  await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id) values('harness',${person.environmentId},'codex','Codex','{}',1,'isolated',true,true,'codex')`.execute(
    database,
  );
  await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values('chain',100,100,0,0)`.execute(
    database,
  );
  const completedAt = new Date("2026-01-02T00:00:00.000Z");
  const updatedAt = new Date("2026-01-03T00:00:00.000Z");
  const cases = [
    { name: "missing-marker", status: "completed", unread: true },
    { name: "read", status: "completed", marker: 1, unread: false },
    { name: "unread-failed", status: "failed", marker: 0, unread: true },
    { name: "interrupted", status: "interrupted", unread: true },
    { name: "newer-active", status: "completed", active: true, unread: false },
    { name: "blank-only", blank: true, unread: false },
    { name: "message-after-completion", status: "completed", afterCompletion: true, unread: false },
    { name: "blank-completion", status: "completed", blank: true, unread: true },
    { name: "voice", status: "completed", voice: true, unread: true },
    { name: "future-read", status: "completed", marker: 1, future: true, unread: false },
    {
      name: "microsecond-unread",
      status: "completed",
      marker: 0,
      messageAt: "2026-01-02T00:00:00.000500Z",
      completedAt: "2026-01-02T00:00:00.000900Z",
      unread: true,
    },
  ];
  for (const item of cases) {
    const id = `thr_${item.name}`;
    await sql`insert into threads(id,lineage_root_thread_id,purpose,listed,title,icon_source,color,environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id)
      values(${id},${id},${item.voice ? "voice" : "task"},${!item.voice},${item.name},'provisional','blue',${person.environmentId},'harness','{}',${person.userId},${principal.id})`.execute(
      database,
    );
    await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content,created_at)
      values(${`msg_${item.name}`},${id},1,'assistant',${principal.id},'{"kind":"agent"}',${JSON.stringify([{ type: "text", text: item.blank ? "" : "Reply" }])},${item.messageAt ?? (item.future ? new Date("2099-01-01") : item.afterCompletion ? updatedAt : completedAt)})`.execute(
      database,
    );
    if (item.status) {
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,activation_input_id,causal_chain_id,access_mode,status,completed_at)
        values(${`run_${item.name}`},${id},${person.environmentId},'harness','{}',${person.userId},${principal.id},'{}',0,${`msg_${item.name}`},${`msg_${item.name}`},'chain','full-access',${item.status},${item.completedAt ?? (item.future ? new Date("2099-01-01") : completedAt)})`.execute(
        database,
      );
    }
    if (item.active)
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,activation_input_id,causal_chain_id,access_mode,status)
      select 'run_active',thread_id,environment_id,harness_instance_id,model_selection,requested_by,actor_principal_id,authority_source,1,seed_input_id,activation_input_id,causal_chain_id,access_mode,'running' from runs where id = ${`run_${item.name}`}`.execute(
        database,
      );
    if (item.marker !== undefined)
      await sql`insert into thread_read_markers(thread_id,user_id,sequence,updated_at) values(${id},${person.userId},${item.marker},${updatedAt})`.execute(
        database,
      );
  }
  await migrateToLatest(database, migrationProvider({ personalCurrentState: false }));
  const { threadUnreadPredicate, latestRunCompletion } = await import("./thread-visits.js");
  const rows = (
    await sql<{
      id: string;
      unread: boolean;
      lastVisitedAt: Date;
      updatedAt: Date;
    }>`select thread.id, visit.last_visited_at, visit.updated_at,
    ${threadUnreadPredicate(latestRunCompletion(sql`thread.id`), sql`visit.last_visited_at`)} as unread
    from threads thread join thread_visits visit on visit.thread_id = thread.id order by thread.id`.execute(
      database,
    )
  ).rows;
  for (const item of cases) {
    const row = rows.find((row) => row.id === `thr_${item.name}`)!;
    expect(row.unread, item.name).toBe(item.unread);
    if (item.marker !== undefined) expect(row.updatedAt).toEqual(updatedAt);
    if (item.status && !item.active && !item.future)
      expect(row.lastVisitedAt).toEqual(new Date(completedAt.getTime() - (item.unread ? 1 : 0)));
  }
  expect(
    (
      await sql<{
        present: boolean;
      }>`select to_regclass('thread_read_markers') is not null as present`.execute(database)
    ).rows[0]?.present,
  ).toBe(false);
  expect(
    (
      await sql<{
        future: boolean;
      }>`select exists(select 1 from runs where completed_at > now()) as future`.execute(database)
    ).rows[0]?.future,
  ).toBe(false);
  // Message history is never rewritten; readers compare its millisecond truncation.
  expect(
    (
      await sql<{
        id: string;
        createdAt: string;
      }>`select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as created_at
        from messages where id in ('msg_future-read', 'msg_microsecond-unread') order by id`.execute(
        database,
      )
    ).rows,
  ).toEqual([
    { id: "msg_future-read", createdAt: "2099-01-01 00:00:00.000000" },
    { id: "msg_microsecond-unread", createdAt: "2026-01-02 00:00:00.000500" },
  ]);
});

it("keeps pre-tabs/apps history and recent places readable without live tabs", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const browser = {
    kind: "browser",
    sessionId: `bsn_${crypto.randomUUID()}`,
    surfaceId: "legacy/page:1",
  };
  const app = { kind: "app", machineId: publisher.runnerId, appKey: "com.apple.Notes" };
  const phone = { kind: "phone", machineId: publisher.runnerId, display: "main" };
  const places = [browser, app, phone, browser, app, phone];
  const nativeWindow = { id: 42, title: "Notes" };
  const unchanged = [
    {
      type: "app.published",
      data: { appId: `app_${crypto.randomUUID()}`, version: 1, title: "Existing app" },
    },
    {
      type: "tool.started",
      data: {
        callId: "computer:legacy",
        tool: { namespace: "integrations", name: "computer.bind" },
        arguments: { window: nativeWindow.id },
      },
    },
    {
      type: "tool.completed",
      data: {
        callId: "computer:legacy",
        isError: false,
        output: createToolOutput(JSON.stringify({ window: nativeWindow })),
      },
    },
    { type: "place.entered", data: { tabId: "already-current", title: "Current", site: null } },
  ];
  const fixtures = [
    ...places.map((place, index) => ({
      type: "place.entered",
      data: {
        place,
        title: `Historical ${index}`,
        site: place.kind === "browser" ? "https://example.com" : null,
      },
    })),
    ...unchanged,
  ];
  for (const fixture of fixtures)
    await sql`with next as (update deployment_event_state set sequence=sequence+1 returning *)
      insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
      select deployment_id,sequence,${createId("event")},${publisher.threadId},${publisher.runId},${publisher.environmentId},${fixture.type},${JSON.stringify(fixture.data)}::jsonb from next`.execute(
      database,
    );
  const legacyRows = async () =>
    (
      await sql<{ sequence: string; createdAt: Date; data: unknown }>`
    select * from deployment_events order by sequence
  `.execute(database)
    ).rows;
  const parseLegacy = (row: Awaited<ReturnType<typeof legacyRows>>[number]) =>
    AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
  const before = await legacyRows();
  expect(() => parseLegacy(before[0]!)).toThrow();
  await migrateToLatest(database, migrationsBefore(personalCurrentStateMigrationName));
  const after = await legacyRows();
  expect(after.map(({ data: _data, ...row }) => row)).toEqual(
    before.map(({ data: _data, ...row }) => row),
  );
  expect(after.slice(places.length)).toEqual(before.slice(places.length));
  const events = after.map(parseLegacy);
  for (const event of events) expect(AgentEventViewSchema.parse(event)).toEqual(event);
  const migrated = events.slice(0, places.length).map((event, index) => {
    const place = PlaceEnteredEventViewSchema.parse(event);
    expect(place.data).toEqual({
      tabId: place.data.tabId,
      title: `Historical ${index}`,
      site: places[index]!.kind === "browser" ? "https://example.com" : null,
    });
    return place;
  });
  const ids = migrated.map((event) => TabIdSchema.parse(event.data.tabId));
  expect(ids.slice(0, 3)).toEqual(ids.slice(3));
  expect(new Set(ids).size).toBe(3);
  expect(ids[0]).toBe(browser.surfaceId);
  for (const id of [ids[1], ids[2]])
    expect(id).toMatch(/^tab_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  for (const id of ids)
    expect(parseReferenceHref(tabReferenceHref(id))).toEqual({ kind: "tab", id });
  expect(await resolvePersonalReferences(database, { ownerId: publisher.userId, ids })).toEqual(
    [...new Set(ids)].map((id) => ({ id, status: "unavailable" })),
  );
  await migrateToLatest(database, migrationsBefore(personalCurrentStateMigrationName));
  expect(await legacyRows()).toEqual(after);
  await migrateToLatest(database);
  expect(
    (
      await sql<{
        ledger: string | null;
      }>`select to_regclass('deployment_events') as ledger`.execute(database)
    ).rows,
  ).toEqual([{ ledger: null }]);
  expect(
    await database
      .selectFrom("toolCalls")
      .select(["callId", "status"])
      .where("runId", "=", publisher.runId)
      .execute(),
  ).toEqual([expect.objectContaining({ status: "completed" })]);
});

it("reaches the same tabs/apps schema fresh and after preserving existing publications", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const html = `app_${crypto.randomUUID()}`;
  const server = `app_${crypto.randomUUID()}`;
  const secondServer = `app_${crypto.randomUUID()}`;
  for (const appId of [html, server, secondServer]) {
    await sql`insert into apps(id,thread_id,run_id,title,latest_version) values(${appId},${publisher.threadId},${publisher.runId},'Preserved',1)`.execute(
      database,
    );
    const serverSpec =
      appId === server || appId === secondServer
        ? JSON.stringify({
            folder: { computerId: publisher.runnerId, path: "/tmp/migrated-server" },
            command: "node server.mjs",
          })
        : null;
    await sql`insert into app_versions(app_id,version,sha256,size_bytes,server,created_by_run,publish_key) values(${appId},1,${serverSpec ? null : "a".repeat(64)},${serverSpec ? null : 10},${serverSpec}::jsonb,${publisher.runId},${appId})`.execute(
      database,
    );
  }
  await migrateToLatest(database);
  const rows = (
    await sql<{
      id: string;
      ownerId: string;
      computerId: string;
      name: string;
      threadId: string | null;
      runId: string | null;
    }>`select id,owner_id,computer_id,name,thread_id,run_id from apps order by id`.execute(database)
  ).rows;
  expect(rows).toHaveLength(3);
  for (const row of rows)
    expect(row).toMatchObject({
      ownerId: publisher.userId,
      computerId: publisher.runnerId,
      name: "Preserved",
      threadId: publisher.threadId,
      runId: publisher.runId,
    });
  const ports = (
    await sql<{
      appId: string;
      port: number;
      desiredState: string;
    }>`select app_id,port,desired_state from app_servers order by app_id`.execute(database)
  ).rows;
  expect(ports).toHaveLength(2);
  expect(new Set(ports.map((row) => row.port)).size).toBe(2);
  for (const row of ports) {
    expect(row.port).toBeGreaterThanOrEqual(49152);
    expect(row.port).toBeLessThanOrEqual(65535);
    expect(row.desiredState).toBe("running");
  }
  await sql`delete from runs where id=${publisher.runId}`.execute(database);
  expect((await sql`select run_id from apps`.execute(database)).rows).toEqual(
    Array.from({ length: 3 }, () => ({ runId: null })),
  );
  await sql`update causal_chains set root_message_id=null where id=${publisher.causalChainId}`.execute(
    database,
  );
  await sql`delete from threads where id=${publisher.threadId}`.execute(database);
  expect((await sql`select thread_id from apps`.execute(database)).rows).toEqual(
    Array.from({ length: 3 }, () => ({ threadId: null })),
  );
  expect((await sql`select * from app_versions`.execute(database)).rows).toHaveLength(3);
  await migrateToLatest(database);
  expect(
    (await sql`select app_id,port,desired_state from app_servers order by app_id`.execute(database))
      .rows,
  ).toEqual(ports);
  const upgraded = await catalog();
  await sql`drop schema public cascade;create schema public`.execute(database);
  await migrateToLatest(database);
  expect(await catalog()).toEqual(upgraded);
});

it("enforces generic tab identity, descriptor shape, and fixed server ports on a fresh database", async () => {
  await migrateToLatest(database);
  const person = await seedPersonalFixture(database, "/tmp/tabs-contract-migration");
  const tab = (id: string) =>
    sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,opened_by) values(${id},${person.userId},'phone',${person.runnerId},'Phone','"person"')`.execute(
      database,
    );
  await tab("first");
  await expect(tab("second")).rejects.toThrow(/unique/u);
  await sql`update personal_tabs set closed_at=now() where id='first'`.execute(database);
  await expect(tab("second")).rejects.toThrow(/unique/u);
  await expect(
    sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,opened_by) values('page',${person.userId},'page',${person.runnerId},'Missing URL','"person"')`.execute(
      database,
    ),
  ).rejects.toThrow(/check constraint/u);
  const columns = (
    await sql<{
      tableName: string;
      columnName: string;
    }>`select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('apps','personal_tabs','runners','tab_layouts')`.execute(
      database,
    )
  ).rows;
  expect(columns.filter((row) => row.columnName === "tab_opened_at")).toEqual([]);
  expect(
    (
      await sql`select to_regclass('browser_tab_layouts') as old_layout,to_regclass('browser_tab_groups') as old_groups,to_regclass('browser_tab_group_members') as old_members`.execute(
        database,
      )
    ).rows,
  ).toEqual([{ oldLayout: null, oldGroups: null, oldMembers: null }]);
});

it("keeps a server's recorded home when the publishing computer can no longer be derived", async () => {
  await migrateToLatest(database, migrationsBefore(tabsAndAppsMigrationName));
  const publisher = await seedPrivatePublisher(database);
  const html = `app_${crypto.randomUUID()}`,
    server = `app_${crypto.randomUUID()}`;
  for (const appId of [html, server]) {
    await sql`insert into apps(id,thread_id,run_id,title,latest_version) values(${appId},${publisher.threadId},${publisher.runId},'Existing',1)`.execute(
      database,
    );
    const spec =
      appId === server
        ? JSON.stringify({
            folder: { computerId: publisher.runnerId, path: "/tmp/saved-app" },
            command: "node server.mjs",
          })
        : null;
    await sql`insert into app_versions(app_id,version,sha256,size_bytes,server,created_by_run,publish_key) values(${appId},1,${spec ? null : "a".repeat(64)},${spec ? null : 10},${spec}::jsonb,${publisher.runId},${appId})`.execute(
      database,
    );
  }
  await sql`update execution_environments set runner_id=null where id=${publisher.environmentId}`.execute(
    database,
  );
  await migrateToLatest(database);
  expect((await sql`select id,computer_id from apps`.execute(database)).rows).toEqual([
    { id: server, computerId: publisher.runnerId },
  ]);
  expect((await sql`select app_id from app_versions`.execute(database)).rows).toEqual([
    { appId: server },
  ]);
});

it("applies 0113_automations_contract in one migration from pre-script state and matches a fresh catalog", async () => {
  await migrateToLatest(database, migrationsBefore("0113_automations_contract"));
  const fixture = await seedPersonalFixture(database, "/tmp/automations-contract-migration");
  const task = await legacyTask(fixture, "Automations contract anchor");
  const principalId =
    (await sql<{ id: string }>`select id from principals limit 1`.execute(database)).rows[0]?.id ??
    `usr:${fixture.userId}`;

  const legacyScheduleId = `trg_${crypto.randomUUID()}`;
  const legacyScheduleRevId = `trv_${crypto.randomUUID()}`;
  const legacyWebhookId = `trg_${crypto.randomUUID()}`;
  const legacyWebhookRevId = `trv_${crypto.randomUUID()}`;
  const legacyWatchId = `trg_${crypto.randomUUID()}`;
  const legacyWatchRevId = `trv_${crypto.randomUUID()}`;
  const legacyWatchActId = `twa_${crypto.randomUUID()}`;
  const memoryPassId = `trg_${crypto.randomUUID()}`;
  const memoryPassRevId = `trv_${crypto.randomUUID()}`;
  const archivedLegacyId = `trg_${crypto.randomUUID()}`;
  const archivedLegacyRevId = `trv_${crypto.randomUUID()}`;
  const inFlightCmdId = `cmd_${crypto.randomUUID()}`;
  const inFlightOccId = `toc_${crypto.randomUUID()}`;
  const pendingLegacyCmdId = `cmd_${crypto.randomUUID()}`;
  const pendingLegacyOccId = `toc_${crypto.randomUUID()}`;
  const futureFireAt = new Date(Date.now() + 3_600_000);
  const legacyProgram = {
    language: "javascript",
    source: "export default async function () { return { legacy: true }; }",
    toolContractVersion: 5,
  };
  const scheduleSource = {
    kind: "schedule",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  };

  await database.transaction().execute(async (tx) => {
    await sql`insert into triggers(
      id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
      current_revision_id, consecutive_failures, next_fire_at
    ) values
      (${legacyScheduleId}, ${task.id}, ${fixture.userId}, 'leg-sched', 'fp-1', ${"Legacy\u202E\n\tschedule\u200D"}, 'schedule', 'active', ${legacyScheduleRevId}, 2, ${futureFireAt}),
      (${legacyWebhookId}, ${task.id}, ${fixture.userId}, 'leg-hook', 'fp-2', ${"\u202E\u200D\n "}, 'webhook', 'active', ${legacyWebhookRevId}, 0, null),
      (${legacyWatchId}, ${task.id}, ${fixture.userId}, 'leg-watch', 'fp-3', 'Legacy watch', 'watch', 'active', ${legacyWatchRevId}, 1, null),
      (${archivedLegacyId}, ${task.id}, ${fixture.userId}, 'arch-leg', 'fp-6', 'Archived legacy', 'schedule', 'archived', ${archivedLegacyRevId}, 0, null)
    `.execute(tx);
    await sql`insert into triggers(
      id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
      current_revision_id, consecutive_failures, next_fire_at, system_role
    ) values (
      ${memoryPassId}, ${task.id}, ${fixture.userId}, 'mem-pass', 'fp-5', 'Memory light pass',
      'schedule', 'active', ${memoryPassRevId}, 0, ${futureFireAt}, 'memory-light'
    )`.execute(tx);
    await sql`insert into trigger_revisions(id, trigger_id, ordinal, source, program, created_by) values
      (${legacyScheduleRevId}, ${legacyScheduleId}, 1, ${JSON.stringify(scheduleSource)}::jsonb, ${JSON.stringify(legacyProgram)}::jsonb, ${fixture.userId}),
      (${legacyWebhookRevId}, ${legacyWebhookId}, 1, '{"kind":"webhook"}'::jsonb, ${JSON.stringify(legacyProgram)}::jsonb, ${fixture.userId}),
      (${legacyWatchRevId}, ${legacyWatchId}, 1, '{"kind":"watch"}'::jsonb, ${JSON.stringify(legacyProgram)}::jsonb, ${fixture.userId}),
      (${memoryPassRevId}, ${memoryPassId}, 1, ${JSON.stringify(scheduleSource)}::jsonb, ${JSON.stringify(legacyProgram)}::jsonb, ${fixture.userId}),
      (${archivedLegacyRevId}, ${archivedLegacyId}, 1, ${JSON.stringify(scheduleSource)}::jsonb, ${JSON.stringify(legacyProgram)}::jsonb, ${fixture.userId})
    `.execute(tx);
    await sql`insert into trigger_watch_activations(
      id, trigger_id, revision_id, anchor_thread_id, environment_id, created_by,
      desired, observed, execution_generation, restart_count, consecutive_failures, stdout_tail, stderr_tail
    ) values (
      ${legacyWatchActId}, ${legacyWatchId}, ${legacyWatchRevId}, ${task.id}, ${fixture.environmentId}, ${fixture.userId},
      'active', 'running', 1, 0, 0, '', ''
    )`.execute(tx);
    // AA3(a): an in-flight v5 firing dispatched before 0113 must get frame_sent_at backfilled so
    // it settles to unknown after upgrade rather than returning to pending and failing.
    await sql`insert into commands(
      id, environment_id, thread_id, requested_by, actor_principal_id, authority_source,
      idempotency_key, type, payload, status
    ) values (
      ${inFlightCmdId}, ${fixture.environmentId}, ${task.id}, ${fixture.userId}, ${principalId},
      '{"kind":"person"}'::jsonb, 'in-flight-pre-0113', 'trigger.execute', '{}'::jsonb, 'dispatched'
    )`.execute(tx);
    await sql`insert into trigger_occurrences(
      id, trigger_id, revision_id, command_id, environment_id, source_key, event, status, stdout, stderr
    ) values (
      ${inFlightOccId}, ${legacyScheduleId}, ${legacyScheduleRevId}, ${inFlightCmdId}, ${fixture.environmentId},
      'schedule:in-flight', '{}'::jsonb, 'running', '', ''
    )`.execute(tx);
    // AB7: a pending firing queued for a legacy automation paused by 0113 must be canceled in place.
    await sql`insert into commands(
      id, environment_id, thread_id, requested_by, actor_principal_id, authority_source,
      idempotency_key, type, payload, status
    ) values (
      ${pendingLegacyCmdId}, ${fixture.environmentId}, ${task.id}, ${fixture.userId}, ${principalId},
      '{"kind":"person"}'::jsonb, 'pending-legacy-pre-0113', 'trigger.execute', '{}'::jsonb, 'pending'
    )`.execute(tx);
    await sql`insert into trigger_occurrences(
      id, trigger_id, revision_id, command_id, environment_id, source_key, event, status, stdout, stderr
    ) values (
      ${pendingLegacyOccId}, ${legacyScheduleId}, ${legacyScheduleRevId}, ${pendingLegacyCmdId}, ${fixture.environmentId},
      'schedule:pending-legacy', '{}'::jsonb, 'pending', '', ''
    )`.execute(tx);
  });

  await migrateToLatest(database);

  const backfilled = (
    await sql<{ frameSentAt: Date | null }>`
      select frame_sent_at as "frameSentAt" from commands where id = ${inFlightCmdId}
    `.execute(database)
  ).rows[0];
  expect(backfilled?.frameSentAt).not.toBeNull();

  const canceledLegacyOcc = (
    await sql<{ status: string; completedAt: Date | null }>`
      select status, completed_at as "completedAt" from trigger_occurrences where id = ${pendingLegacyOccId}
    `.execute(database)
  ).rows[0];
  expect(canceledLegacyOcc?.status).toBe("canceled");
  expect(canceledLegacyOcc?.completedAt).not.toBeNull();
  const canceledLegacyCmd = (
    await sql<{ status: string }>`
      select status from commands where id = ${pendingLegacyCmdId}
    `.execute(database)
  ).rows[0];
  expect(canceledLegacyCmd?.status).toBe("failed");

  const triggers = new Map(
    (
      await sql<{
        id: string;
        name: string;
        status: string;
        nextFireAt: Date | null;
        pauseReason: string | null;
        pausedBy: string | null;
        pausedAt: Date | null;
      }>`select id, name, status, next_fire_at, pause_reason, paused_by, paused_at from triggers`.execute(
        database,
      )
    ).rows.map((row) => [row.id, row]),
  );

  expect(triggers.get(legacyScheduleId)?.name).toBe("Legacy schedule");
  expect(triggers.get(legacyWebhookId)?.name).toBe("Automation");

  for (const id of [legacyScheduleId, legacyWebhookId, legacyWatchId]) {
    const row = triggers.get(id);
    expect(row?.status).toBe("paused");
    expect(row?.nextFireAt).toBeNull();
    expect(row?.pauseReason).toBe("Needs an update: ask your agent");
    expect(row?.pausedBy).toBe("system");
    expect(row?.pausedAt).not.toBeNull();
  }
  const watchAct = (
    await sql<{
      desired: string;
    }>`select desired from trigger_watch_activations where id = ${legacyWatchActId}`.execute(
      database,
    )
  ).rows[0];
  expect(watchAct?.desired).toBe("stopped");

  const legacyRev = (
    await sql<{
      script: unknown;
      legacySource: string | null;
    }>`select script, legacy_source from trigger_revisions where id = ${legacyScheduleRevId}`.execute(
      database,
    )
  ).rows[0];
  expect(legacyRev).toEqual({
    legacySource: legacyProgram.source,
    script: null,
  });

  // Memory pass and archived legacy automation stay untouched.
  expect(triggers.get(memoryPassId)?.status).toBe("active");
  expect(triggers.get(archivedLegacyId)?.status).toBe("archived");
  expect(triggers.get(archivedLegacyId)?.pauseReason).toBeNull();

  // Status allows 'unknown' directly and rejects invalid statuses; webhook_body stores raw bytes.
  await sql`update trigger_occurrences set status = 'unknown', webhook_body = ${Buffer.from("raw-bytes")} where id = ${inFlightOccId}`.execute(
    database,
  );
  await expect(
    sql`update trigger_occurrences set status = 'bogus' where id = ${inFlightOccId}`.execute(
      database,
    ),
  ).rejects.toThrow(/check constraint/u);

  // Secrets envelope constraint enforces paired encrypted_secrets and secrets_key_version.
  await expect(
    sql`update triggers set encrypted_secrets = ${Buffer.from("cipher")}, secrets_key_version = null where id = ${legacyScheduleId}`.execute(
      database,
    ),
  ).rejects.toThrow(/check constraint/u);

  // Notice reasons allow the new set and reject removed wake-limit-reached.
  await sql`insert into automation_failure_notices(id, trigger_id, reason, detail)
    values (${crypto.randomUUID()}, ${legacyScheduleId}, 'started-failing', 'exited 1')`.execute(
    database,
  );
  await sql`insert into automation_failure_notices(id, trigger_id, reason, detail)
    values (${crypto.randomUUID()}, ${legacyScheduleId}, 'outcome-unknown', 'computer rebooted')`.execute(
    database,
  );
  await expect(
    sql`insert into automation_failure_notices(id, trigger_id, reason, detail)
      values (${crypto.randomUUID()}, ${legacyScheduleId}, 'wake-limit-reached', 'nope')`.execute(
      database,
    ),
  ).rejects.toThrow(/check constraint/u);

  // Retired tables and columns are absent.
  const retiredTables = (
    await sql<{ name: string }>`
      select tablename as name from pg_tables
      where schemaname = 'public'
        and tablename in ('trigger_revision_scripts', 'automation_wakes', 'watch_control_requests')
    `.execute(database)
  ).rows;
  expect(retiredTables).toEqual([]);
  const removedColumns = (
    await sql<{ tableName: string; columnName: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'trigger_revisions' and column_name = 'program')
          or (table_name = 'trigger_occurrences' and column_name = 'outcome')
          or (table_name = 'triggers' and column_name in ('wake_limit_per_hour', 'webhook_secret_hash', 'consecutive_failures'))
          or (table_name = 'execution_environments' and column_name = 'max_active_watches'))
    `.execute(database)
  ).rows;
  expect(removedColumns).toEqual([]);

  // Fresh catalog matches upgraded catalog byte-for-byte.
  const upgraded = await catalog();
  await sql`drop schema public cascade;create schema public`.execute(database);
  await migrateToLatest(database);
  expect(await catalog()).toEqual(upgraded);
});
