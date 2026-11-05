import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { migrationProvider } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Integration requires the launcher's isolated PostgreSQL.
const integration = databaseUrl ? describe : describe.skip;

integration("specialists adopt access upgrade", () => {
  const name = `opensteer_specialists_${randomUUID().replaceAll("-", "")}`;
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
      "0163_phone_tabs",
    );
    if (before.error) throw before.error;
    // Released rows retain their real shape and constraints, without requiring live engines.
    await sql`set session_replication_role = replica`.execute(database);
    try {
      await sql`
        insert into users(id, display_name, email) values ('owner', 'Owner', 'owner@example.test');
        insert into principals(id, kind, user_id, display_name) values ('principal', 'user', 'owner', 'Owner');
        insert into plugins(id, name, scope, source, installed_by) values ('plugin', 'Invoices', 'deployment', '{}', 'owner');
        insert into plugin_versions(id, plugin_id, digest, manifest, specialist_manifest)
          values ('version', 'plugin', repeat('a', 64), '{"name":"invoices"}', '{"version":1,"models":[{"engine":"claude","model":"haiku"}],"access":[]}');
        insert into workspaces(id, name, status, created_by, kind, backing, color, slug)
        values ('main', 'Main', 'ready', 'owner', 'main', '{"kind":"local-directory","bindingId":"wbd_00000000-0000-4000-8000-000000000001","ownerEnvironmentId":"env_00000000-0000-4000-8000-000000000001","storageAuthorityId":null,"generation":1}', 'blue', null),
               ('project', 'Project', 'ready', 'owner', 'project', '{"kind":"local-directory","bindingId":"wbd_00000000-0000-4000-8000-000000000002","ownerEnvironmentId":"env_00000000-0000-4000-8000-000000000001","storageAuthorityId":null,"generation":1}', 'blue', 'project');
        insert into workspace_memberships(id, workspace_id, user_id, role, state)
          values ('main-owner', 'main', 'owner', 'owner', 'active'), ('project-owner', 'project', 'owner', 'owner', 'active');
        insert into specialists(id, workspace_id, plugin_id, plugin_version_id, owner_user_id, created_by, status, bindings)
          values ('specialist', 'main', 'plugin', 'version', 'owner', 'owner', 'pending', '[{"requirement":0,"resourceId":"old-profile","level":"read"}]');
        insert into execution_environments(id, name, kind) values ('computer', 'Computer', 'main');
        insert into harness_instances(id, environment_id, driver_kind, name, config, state_kind, source_id)
          values ('harness', 'computer', 'pi', 'Pi', '{}', 'isolated', 'pi');
        insert into threads(id, workspace_id, title, environment_id, harness_instance_id, created_by,
          created_by_principal_id, model_selection, lineage_root_thread_id, specialist_id, inherits_main,
          listed, color)
        select id, 'main', id, 'computer', 'harness', 'owner', 'principal',
          '{"providerId":"pi","modelId":"test","options":{}}'::jsonb, id, specialist, true, true, 'blue'
        from (values
          ('specialist-thread', 'specialist'),
          ('busy-specialist-thread', 'specialist'),
          ('unstarted-specialist-thread', 'specialist'),
          ('plain-thread', null)
        ) as rows(id, specialist);
        insert into provider_sessions(id, thread_id, harness_instance_id, provider_session_reference,
          continuation_identity, binding_generation, status, active, state_layout)
        values
          ('old-session', 'specialist-thread', 'harness', 'native-old', '{"driverKind":"pi"}', 3, 'ready', true, 'thread'),
          ('busy-session', 'busy-specialist-thread', 'harness', 'native-busy', '{"driverKind":"pi"}', 3, 'ready', true, 'thread'),
          ('plain-session', 'plain-thread', 'harness', 'native-plain', '{"driverKind":"pi"}', 3, 'ready', true, 'thread');
        insert into runs(id, thread_id, environment_id, harness_instance_id, requested_by, run_ordinal,
          status, actor_principal_id, authority_source, model_selection, membership_generation,
          access_mode, activation_input_id, causal_chain_id, seed_input_id, provider_session_id)
        values ('busy-run', 'busy-specialist-thread', 'computer', 'harness', 'owner', 1, 'queued',
          'principal', '{}', '{"providerId":"pi","modelId":"test","options":{}}', 1, 'full-access',
          'input', 'chain', 'input', 'busy-session');
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

  it("readies registrations, moves started specialists to a fresh native session and drops bindings", async () => {
    const migrator = new Migrator({ db: database, provider: migrationProvider() });
    const result = await migrator.migrateTo("0164_specialists_adopt_access");
    if (result.error) throw result.error;
    expect(
      (
        await sql<{
          status: string;
        }>`select status from specialists where id = 'specialist'`.execute(database)
      ).rows,
    ).toEqual([{ status: "ready" }]);
    // Native sessions are tied to the old folder, so a started specialist Thread takes a fresh one.
    expect(
      (
        await sql<{
          threadId: string;
          active: boolean;
          providerSessionReference: string | null;
          continuationIdentity: unknown;
          stale: boolean;
        }>`select thread_id, active, provider_session_reference, continuation_identity, id = 'old-session' as stale
           from provider_sessions order by thread_id, active`.execute(database)
      ).rows,
    ).toEqual([
      {
        threadId: "busy-specialist-thread",
        active: true,
        providerSessionReference: "native-busy",
        continuationIdentity: { driverKind: "pi" },
        stale: false,
      },
      {
        threadId: "plain-thread",
        active: true,
        providerSessionReference: "native-plain",
        continuationIdentity: { driverKind: "pi" },
        stale: false,
      },
      {
        threadId: "specialist-thread",
        active: false,
        providerSessionReference: "native-old",
        continuationIdentity: { driverKind: "pi" },
        stale: true,
      },
      {
        threadId: "specialist-thread",
        active: true,
        providerSessionReference: null,
        continuationIdentity: { driverKind: "pi" },
        stale: false,
      },
    ]);
    expect(
      (
        await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'specialists' and column_name in ('bindings', 'auto_bind')`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await sql`insert into plugin_versions(id, plugin_id, digest, manifest, specialist_manifest)
      select 'next-version', plugin_id, repeat('b', 64), manifest, specialist_manifest from plugin_versions where id = 'version'`.execute(
      database,
    );
    const revision = async () =>
      (
        await sql<{
          revision: number;
        }>`select revision from plugin_owner_settings where owner_user_id = 'owner' and target->>'kind' = 'specialist' and target->>'pluginId' = 'plugin'`.execute(
          database,
        )
      ).rows[0]?.revision ?? 0;
    const before = await revision();
    await sql`update specialists set plugin_version_id = 'next-version' where id = 'specialist'`.execute(
      database,
    );
    expect(await revision()).toBe(before + 1);
    expect(
      (
        await sql<{
          pluginVersionId: string;
        }>`select plugin_version_id from specialists where id = 'specialist'`.execute(database)
      ).rows,
    ).toEqual([{ pluginVersionId: "next-version" }]);
  });
});
