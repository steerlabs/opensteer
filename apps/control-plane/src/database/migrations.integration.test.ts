import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneDatabase } from "./database.js";
import type { ControlPlaneDatabaseSchema } from "./schema.js";
import { CONTROL_PLANE_BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import {
  directoryVisibilityMigration,
  hostIdentityMigration,
  migrateControlPlaneToLatest,
  ownerDirectoryVisibilityMigration,
} from "./migrations.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("control-plane Host identity migration", () => {
  const databaseName = `opensteer_control_identity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({
      connectionString: urlForDatabase(databaseName),
      maxConnections: 2,
    });
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("drops the epoch while preserving the Account directory Host identity", async () => {
    await sql`
      insert into public.users(id, display_name, email)
      values ('acct_11111111-1111-4111-8111-111111111111', 'Owner', 'owner@example.test')
    `.execute(database);
    await sql`
      insert into public.deployments(
        id, owner_account_id, name, reachability, active_host_instance_id,
        authority_epoch, canonical_origin, host_key_fingerprint
      ) values (
        'dep_11111111-1111-4111-8111-111111111111',
        'acct_11111111-1111-4111-8111-111111111111',
        'Home',
        'canonical',
        'hst_11111111-1111-4111-8111-111111111111',
        9,
        'https://home.example.test',
        ${`sha256:${"a".repeat(43)}`}
      )
    `.execute(database);

    await hostIdentityMigration.up(database);

    const identity = await sql<{
      readonly hostInstanceId: string;
      readonly hostKeyFingerprint: string;
    }>`
      select active_host_instance_id as "hostInstanceId",
             host_key_fingerprint as "hostKeyFingerprint"
      from public.deployments
    `.execute(database);
    expect(identity.rows[0]).toEqual({
      hostInstanceId: "hst_11111111-1111-4111-8111-111111111111",
      hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    });

    const epochColumn = await sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'deployments'
        and column_name = 'authority_epoch'
    `.execute(database);
    expect(epochColumn.rows).toEqual([]);
  });
});

integration("control-plane owner directory visibility migration", () => {
  const databaseName = `opensteer_control_visibility_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({
      connectionString: urlForDatabase(databaseName),
      maxConnections: 2,
    });
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
    await hostIdentityMigration.up(database);
    await directoryVisibilityMigration.up(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("drops hide markers an owner left on their own deployment and keeps a member's", async () => {
    await sql`
      insert into public.users(id, display_name, email)
      values
        ('acct_22222222-2222-4222-8222-222222222222', 'Owner', 'owner@example.test'),
        ('acct_33333333-3333-4333-8333-333333333333', 'Member', 'member@example.test')
    `.execute(database);
    await sql`
      insert into public.deployments(
        id, owner_account_id, name, reachability, active_host_instance_id,
        canonical_origin, host_key_fingerprint, account_link
      ) values (
        'dep_22222222-2222-4222-8222-222222222222',
        'acct_22222222-2222-4222-8222-222222222222',
        'This computer',
        'routed',
        'hst_22222222-2222-4222-8222-222222222222',
        'http://127.0.0.1:60470',
        ${`sha256:${"b".repeat(43)}`},
        ${JSON.stringify({
          generation: "g".repeat(43),
          issuer: "https://accounts.example.test",
          subject: "acct_22222222-2222-4222-8222-222222222222",
        })}::jsonb
      )
    `.execute(database);
    await sql`
      insert into public.deployment_directory_visibility(deployment_id, account_id, hidden_at)
      values
        ('dep_22222222-2222-4222-8222-222222222222', 'acct_22222222-2222-4222-8222-222222222222', now()),
        ('dep_22222222-2222-4222-8222-222222222222', 'acct_33333333-3333-4333-8333-333333333333', now())
    `.execute(database);

    await ownerDirectoryVisibilityMigration.up(database);

    const remaining = await sql<{ readonly accountId: string }>`
      select account_id as "accountId" from public.deployment_directory_visibility
    `.execute(database);
    expect(remaining.rows).toEqual([{ accountId: "acct_33333333-3333-4333-8333-333333333333" }]);
  });
});

integration("control-plane baseline", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 2,
  });

  beforeAll(async () => migrateControlPlaneToLatest(database));
  afterAll(async () => database.destroy());

  it("contains the account-service schema without provider fleet tables", async () => {
    const result = await sql<{ readonly tableName: string }>`
      select table_name as "tableName"
      from information_schema.tables
      where table_schema = 'public'
    `.execute(database);
    const tables = new Set(result.rows.map((row) => row.tableName));

    for (const table of [
      "deployments",
      "deployment_connect_resources",
      "deployment_adoption_operations",
      "hosted_oauth_broker_attempts",
      "personal_host_account_link_challenges",
      "portal_sessions",
    ]) {
      expect(tables).toContain(table);
    }
    for (const table of [
      "cloud_computers",
      "cloud_computer_attachments",
      "managed_cloud_deployments",
      "managed_cloud_provisioning_intents",
    ]) {
      expect(tables).not.toContain(table);
    }
  });
});
