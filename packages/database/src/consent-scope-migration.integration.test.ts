import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { consentScopeMigration, migrationProvider } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Integration requires the launcher's isolated PostgreSQL.
const integration = databaseUrl ? describe : describe.skip;

integration("consent scope upgrade", () => {
  const name = `opensteer_consent_${randomUUID().replaceAll("-", "")}`;
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  const urlFor = (databaseName: string) => {
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    await maintenance.query(`create database ${name}`);
    database = createDatabase({ connectionString: urlFor(name), maxConnections: 1 });
    const before = await new Migrator({ db: database, provider: migrationProvider() }).migrateTo(
      "0148_local_mcp_server_secrets",
    );
    if (before.error) throw before.error;
    // Released rows retain their real shape and constraints, without requiring live engines.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into users(id, display_name, email) values ('owner', 'Owner', 'owner@example.test');
        insert into principals(id, kind, user_id, display_name) values ('principal', 'user', 'owner', 'Owner');
        insert into execution_environments(id, name, kind) values ('computer', 'Computer', 'main');
        insert into harness_instances(id, environment_id, driver_kind, name, config, state_kind, source_id)
          values ('harness', 'computer', 'codex', 'Codex', '{}', 'isolated', 'openai');
        insert into plugins(id, name, scope, source, installed_by) values ('plugin', 'Invoices', 'deployment', '{}', 'owner');
        insert into plugin_versions(id, plugin_id, digest, manifest, specialist_manifest)
          values ('version', 'plugin', repeat('a', 64), '{"name":"invoices"}', '{"version":1,"models":[{"engine":"claude","model":"haiku"}],"access":[]}');
        insert into workspaces(id, name, status, created_by, kind, backing, color, slug)
        values ('main', 'Main', 'ready', 'owner', 'main', '{"kind":"local-directory","bindingId":"wbd_00000000-0000-4000-8000-000000000001","ownerEnvironmentId":"env_00000000-0000-4000-8000-000000000001","storageAuthorityId":null,"generation":1}', 'blue', null),
               ('project', 'Project', 'ready', 'owner', 'project', '{"kind":"local-directory","bindingId":"wbd_00000000-0000-4000-8000-000000000002","ownerEnvironmentId":"env_00000000-0000-4000-8000-000000000001","storageAuthorityId":null,"generation":1}', 'blue', 'project');
        insert into workspace_memberships(id, workspace_id, user_id, role, state)
          values ('main-owner', 'main', 'owner', 'owner', 'active'), ('project-owner', 'project', 'owner', 'owner', 'active');
        insert into specialists(id, workspace_id, plugin_id, plugin_version_id, owner_user_id, created_by, status, bindings)
          values ('specialist', 'main', 'plugin', 'version', 'owner', 'owner', 'ready', '[]');
        insert into threads(id, workspace_id, title, environment_id, harness_instance_id, created_by,
          created_by_principal_id, model_selection, lineage_root_thread_id, parent_thread_id, capability_profile_id, specialist_id, listed, color)
        select id, workspace, id, 'computer', 'harness', 'owner', 'principal',
          '{"providerId":"openai","modelId":"test","options":{}}'::jsonb, root, parent, profile, specialist, parent is null, 'blue'
        from (values
          ('main-root', 'main', 'main-root', null, 'main', null),
          ('project-root', 'project', 'project-root', null, 'workspace', null),
          ('main-worker', 'project', 'main-root', 'main-root', 'delegated', null),
          ('project-worker', 'project', 'project-root', 'project-root', 'delegated', null),
          ('specialist-thread', 'main', 'main-root', 'main-root', 'specialist', 'specialist'),
          ('specialist-worker', 'main', 'main-root', 'specialist-thread', 'delegated', null),
          ('owner-dm', 'main', 'owner-dm', null, 'main', null),
          ('external-dm', 'main', 'external-dm', null, 'workspace', null),
          ('slack-shared', 'main', 'slack-shared', null, 'workspace', null),
          ('discord-shared', 'main', 'discord-shared', null, 'workspace', null),
          ('shared-worker', 'main', 'slack-shared', 'slack-shared', 'delegated', null),
          ('main-trigger-worker', 'main', 'main-root', 'main-root', 'delegated', null),
          ('project-trigger-worker', 'project', 'project-root', 'project-root', 'delegated', null),
          ('shared-trigger-worker', 'main', 'discord-shared', 'discord-shared', 'delegated', null)
        ) as rows(id, workspace, root, parent, profile, specialist);
        insert into workspace_events(sequence, event_id, workspace_id, thread_id, environment_id, type, data, created_at)
          select row_number() over (partition by workspace_id order by id), 'event-' || id,
            workspace_id, id, 'computer', 'thread.created',
            jsonb_build_object('thread', jsonb_build_object('id', id, 'capabilityProfileId', capability_profile_id)), now()
          from threads;
        insert into channel_conversations(id, account_id, binding_id, binding_revision, workspace_id,
          external_conversation_id, conversation_type, provider, external_account_id)
        values ('owner-dm', 'account', 'binding', 1, 'main', 'owner-dm', 'dm', 'slack', 'bot'),
          ('external-dm', 'account', 'binding', 1, 'main', 'external-dm', 'dm', 'slack', 'bot'),
          ('slack-shared', 'account', 'binding', 1, 'main', 'slack-shared', 'channel', 'slack', 'bot'),
          ('discord-shared', 'account', 'binding', 1, 'main', 'discord-shared', 'group', 'discord', 'bot');
        insert into channel_conversation_contexts(conversation_id, authority_user_id, binding_revision, active_thread_id)
          select id, 'owner', 1, id from channel_conversations;
        insert into triggers(id, workspace_id, anchor_thread_id, created_by, idempotency_key,
          request_fingerprint, name, kind, status, current_revision_id)
        values ('main-trigger', 'main', 'main-root', 'owner', 'main-trigger', '{}', 'Main', 'schedule', 'active', 'revision'),
          ('project-trigger', 'project', 'project-root', 'owner', 'project-trigger', '{}', 'Project', 'schedule', 'active', 'revision'),
          ('shared-trigger', 'main', 'discord-shared', 'owner', 'shared-trigger', '{}', 'Shared', 'schedule', 'active', 'revision');
      `.execute(database);
    } finally {
      await sql`set session_replication_role = origin`.execute(database);
    }
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${name}`);
    await maintenance?.end();
  });

  it("maps root consent exactly, including shared conversations in the owner's Main", async () => {
    await database.transaction().execute((tx) => consentScopeMigration.up(tx));
    const rows = await sql<{ id: string; inheritsMain: boolean; specialistId: string | null }>`
      select id, inherits_main, specialist_id from threads order by id
    `.execute(database);
    expect(rows.rows).toEqual(
      [
        ["discord-shared", false, null],
        ["external-dm", false, null],
        ["main-root", true, null],
        ["main-trigger-worker", true, null],
        ["main-worker", true, null],
        ["owner-dm", true, null],
        ["project-root", false, null],
        ["project-trigger-worker", false, null],
        ["project-worker", false, null],
        ["shared-trigger-worker", false, null],
        ["shared-worker", false, null],
        ["slack-shared", false, null],
        ["specialist-thread", true, "specialist"],
        ["specialist-worker", true, "specialist"],
      ].map(([id, inheritsMain, specialistId]) => ({ id, inheritsMain, specialistId })),
    );
    const snapshots = await sql<{
      id: string;
      inheritsMain: boolean;
      specialistId: string | null;
      legacy: boolean;
    }>`
      select thread_id as id, (data #>> '{thread,inheritsMain}')::boolean as inherits_main,
        data #>> '{thread,specialistId}' as specialist_id,
        (data -> 'thread') ? 'capabilityProfileId' as legacy from workspace_events order by thread_id
    `.execute(database);
    expect(snapshots.rows).toEqual(rows.rows.map((row) => ({ ...row, legacy: false })));
    const columns = await sql<{
      columnName: string;
    }>`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'threads' and column_name = 'capability_profile_id'`.execute(
      database,
    );
    expect(columns.rows).toEqual([]);
    await expect(
      sql`update threads set inherits_main = true where id = 'slack-shared'`.execute(database),
    ).rejects.toThrow(/consent.*immutable/u);
    await expect(
      sql`update threads set specialist_id = null where id = 'specialist-worker'`.execute(database),
    ).rejects.toThrow(/specialist.*immutable/u);
    await expect(
      sql`update threads set lineage_root_thread_id = 'main-root' where id = 'slack-shared'`.execute(
        database,
      ),
    ).rejects.toThrow(/lineage.*immutable/u);
  });
});
