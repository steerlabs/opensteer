import { createHash, createHmac, randomUUID } from "node:crypto";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { createControlPlaneAuth, ControlPlaneAuthenticator } from "../auth/auth.js";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneDatabase } from "./database.js";
import type { ControlPlaneDatabaseSchema } from "./schema.js";
import { CONTROL_PLANE_BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import {
  accountNameRevisionMigration,
  betterAuth17Migration,
  directoryVisibilityMigration,
  hostIdentityMigration,
  migrateControlPlaneToLatest,
  ownerDirectoryVisibilityMigration,
} from "./migrations.js";
import { browserPoolMigration } from "../cloud-computers/pool-migration.js";
import { organizationsMigrationBeforeRemoval } from "./one-person-account-migration.test-support.js";

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

  it("contains the account-service schema without the retired fleet tables", async () => {
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
      "cloud_computers",
    ]) {
      expect(tables).toContain(table);
    }
    for (const table of [
      "cloud_computer_attachments",
      "managed_cloud_deployments",
      "managed_cloud_provisioning_intents",
    ]) {
      expect(tables).not.toContain(table);
    }
  });
});

integration("Better Auth 1.7 Account migration", () => {
  const databaseName = `opensteer_auth_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const issuer = new URL("https://accounts.example.test");
  const secret = "test-control-plane-secret-with-at-least-32-bytes";
  const userId = "acct_11111111-1111-4111-8111-111111111111";
  const token = "abcdefghijklmnopqrstuvwxyzABCDEF";
  const sessionToken = "legacy-account-session-token";
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;
  const urlForDatabase = (name: string) => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  };

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
    const hash = createHash("sha256").update(token).digest("base64url");
    await sql`
      insert into public.users (id, display_name, email, email_verified)
      values (${userId}, 'Owner', 'owner@example.test', true)
    `.execute(database);
    await sql`
      insert into public.auth_sessions (id, user_id, token, expires_at, created_at, updated_at)
      values ('legacy-session', ${userId}, ${sessionToken}, now() + interval '30 days', now(), now())
    `.execute(database);
    await sql`
      insert into public.oauth_clients
        (id, client_id, disabled, redirect_uris, token_endpoint_auth_method, grant_types,
         response_types, public, type, require_pkce, scopes)
      values ('legacy-client', 'legacy-native', false, '["opensteer://callback"]', 'none',
        '["authorization_code", "refresh_token"]', '["code"]', true, 'native', true,
        '["openid", "email", "offline_access", "deployments:read"]')
    `.execute(database);
    await sql`
      insert into public.oauth_refresh_token
        (id, token, client_id, session_id, user_id, expires_at, created_at, auth_time, scopes)
      values ('legacy-refresh', ${hash}, 'legacy-native', 'legacy-session', ${userId},
        now() + interval '30 days', now(), now(),
        '["openid", "email", "offline_access", "deployments:read"]');
    `.execute(database);
    await betterAuth17Migration.up(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("retains a 1.6 registration, session and hashed refresh credential", async () => {
    const auth = createControlPlaneAuth(database, { authSecret: secret, publicOrigin: issuer });
    const signature = createHmac("sha256", secret).update(sessionToken).digest("base64");
    const cookie = `__Secure-__Host-opensteer.account=${encodeURIComponent(`${sessionToken}.${signature}`)}`;
    const authenticator = new ControlPlaneAuthenticator(auth, database, issuer);
    await expect(authenticator.authenticate(new Headers({ cookie }))).resolves.toMatchObject({
      accountId: userId,
      kind: "session",
    });
    const response = await auth.handler(
      new Request(new URL("/api/auth/oauth2/token", issuer), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "legacy-native",
          grant_type: "refresh_token",
          refresh_token: token,
          resource: issuer.origin,
        }),
      }),
    );
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      id_token: string;
    };
    expect(response.status, JSON.stringify(body)).toBe(200);
    const originalKey = decodeProtectedHeader(body.access_token).kid;
    await database.updateTable("authJwks").set({ alg: null, crv: null }).execute();
    const { token: nextSignedToken } = await auth.api.signJWT({
      body: { payload: { iss: issuer.origin, sub: userId } },
    });
    expect(decodeProtectedHeader(nextSignedToken).kid).toBe(originalKey);
    const keys = createLocalJWKSet(await auth.api.getJwks());
    await expect(
      jwtVerify(body.access_token, keys, { issuer: issuer.origin }),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(nextSignedToken, keys, { issuer: issuer.origin }),
    ).resolves.toBeDefined();
    const claims = decodeJwt(body.access_token);
    expect(claims).toMatchObject({
      iss: issuer.origin,
      sub: userId,
      sid: "legacy-session",
      azp: "legacy-native",
    });
    expect([claims.aud].flat()).toContain(issuer.origin);
    await expect(
      authenticator.authenticate(new Headers({ authorization: `Bearer ${body.access_token}` }), {
        scope: "deployments:read",
      }),
    ).resolves.toMatchObject({ accountId: userId });
    const userInfo = await auth.handler(
      new Request(new URL("/api/auth/oauth2/userinfo", issuer), {
        headers: { authorization: `Bearer ${body.access_token}` },
      }),
    );
    expect(userInfo.status).toBe(200);
    expect(await userInfo.json()).toMatchObject({
      sub: userId,
      email: "owner@example.test",
      email_verified: true,
    });
    const idClaims = decodeJwt(body.id_token);
    expect(idClaims).toMatchObject({ sub: userId, email: "owner@example.test" });
    const accessRevoke = await auth.handler(
      new Request(new URL("/api/auth/oauth2/revoke", issuer), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "legacy-native",
          token: body.access_token,
          token_type_hint: "access_token",
        }),
      }),
    );
    expect(accessRevoke.status).toBe(400);
    expect(await accessRevoke.json()).toMatchObject({ error: "unsupported_token_type" });
    const revoke = await auth.handler(
      new Request(new URL("/api/auth/oauth2/revoke", issuer), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "legacy-native",
          token: body.refresh_token,
          token_type_hint: "refresh_token",
          resource: issuer.origin,
        }),
      }),
    );
    expect(revoke.status).toBe(200);
  });
});

integration("Account name revision migration", () => {
  const databaseName = `opensteer_account_names_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;
  const urlForDatabase = (name: string) => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  };
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({ connectionString: urlForDatabase(databaseName) });
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("replaces whole-email fallback names and keeps names people were given", async () => {
    await sql`
      insert into public.users (id, display_name, email, email_verified) values
        ('acct_00000000-0000-4000-8000-000000000001', 'ada.lovelace@example.test', 'ada.lovelace@example.test', true),
        ('acct_00000000-0000-4000-8000-000000000002', 'Grace Hopper', 'grace@example.test', true)
    `.execute(database);
    await accountNameRevisionMigration.up(database);
    const rows = await sql<{ displayName: string; nameRevision: string }>`
      select display_name, name_revision from public.users order by id
    `.execute(database);
    expect(rows.rows).toEqual([
      { displayName: "Ada Lovelace", nameRevision: "1" },
      { displayName: "Grace Hopper", nameRevision: "1" },
    ]);
  });
});

integration("browser pool expand-only migration (0036_browser_pool)", () => {
  const databaseName = `opensteer_browser_pool_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;
  const urlForDatabase = (name: string) => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  };
  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({ connectionString: urlForDatabase(databaseName) });
    await migrateControlPlaneToLatest(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("defaults existing Cloud Computers to browser_mode='local' and enforces S1 schema invariants", async () => {
    // Ensure a pre-existing-style insert (omitting new columns) defaults cleanly to local.
    await sql`
      insert into public.users (id, display_name, email, email_verified)
      values ('acct_00000000-0000-4000-8000-000000000099', 'Ada', 'ada@example.test', true)
    `.execute(database);
    await sql`
      insert into public.cloud_computers (
        id, account_id, generation, state, hostname, region, server_type, release,
        readiness_started_at, phase, stripe_checkout_id, stripe_customer_id,
        stripe_subscription_id, stripe_price_id, billing_currency, billing_status,
        created_at, updated_at
      ) values (
        'cc_00000000-0000-4000-8000-000000000099',
        'acct_00000000-0000-4000-8000-000000000099',
        1, 'active', 'cc-99.home.example.test', 'us-central1-a', 'default', '{}'::jsonb,
        now(), 'ready', 'cs_99', 'cus_99', 'sub_99', 'price_1', 'usd', 'active', now(), now()
      )
    `.execute(database);
    const computer = await sql<{ browserMode: string; browserSlotErasedAt: Date | null }>`
      select browser_mode, browser_slot_erased_at from public.cloud_computers
      where id = 'cc_00000000-0000-4000-8000-000000000099'
    `.execute(database);
    expect(computer.rows[0]).toEqual({ browserMode: "local", browserSlotErasedAt: null });

    // S1: no port columns on browser_pool_hosts.
    const portCols = await sql<{ columnName: string }>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'browser_pool_hosts'
        and column_name ~ '(^|_)port$'
    `.execute(database);
    expect(portCols.rows).toEqual([]);
    expect(browserPoolMigration).toBeDefined();
  });
});

integration("organizations removed (0037_remove_organizations)", () => {
  const databaseName = `opensteer_one_person_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let maintenance: Pool;
  let database: Kysely<ControlPlaneDatabaseSchema>;
  const urlForDatabase = (name: string) => {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  };
  const assignee = "acct_00000000-0000-4000-8000-0000000000a1";
  const admin = "acct_00000000-0000-4000-8000-0000000000a2";
  const organization = "org_00000000-0000-4000-8000-0000000000b1";
  const assignment = "was_00000000-0000-4000-8000-0000000000c1";
  const personal = "cc_00000000-0000-4000-8000-0000000000d1";
  const work = "cc_00000000-0000-4000-8000-0000000000d2";
  const reservedTarget = "00000000-0000-4000-8000-0000000000e1";
  const computer = (id: string) =>
    sql<Record<string, unknown>>`select * from public.cloud_computers where id = ${id}`
      .execute(database)
      .then(({ rows }) => rows[0]);

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`create database ${databaseName}`);
    database = createControlPlaneDatabase({ connectionString: urlForDatabase(databaseName) });
    await migrateControlPlaneToLatest(database);
    // The release before this one: an organization's tables, its seat reservations on backup
    // targets, and the contracting migration not run yet.
    await organizationsMigrationBeforeRemoval.up(database);
    await sql`
      alter table public.cloud_computer_backup_targets
        add column reserved_organization_id text,
        add column organization_reservation_request_id uuid;
      delete from public.kysely_migration where name = '0037_remove_organizations';
    `.execute(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await maintenance?.query(`drop database if exists ${databaseName}`);
    await maintenance?.end();
  });

  it("refuses while an organization or its computer exists, changes nothing, and runs once an operator decided", async () => {
    await sql`
      insert into public.users (id, display_name, email, email_verified) values
        (${assignee}, 'Ada', 'ada@example.test', true),
        (${admin}, 'Grace', 'grace@example.test', true);
      insert into public.organizations (id, name, stripe_customer_id, stripe_subscription_id,
          stripe_price_id, billing_currency, billing_status, paid_seats, policy)
        values (${organization}, 'Workshop', 'cus_org', 'sub_org', 'price_seat', 'usd', 'active',
          2, '{"externalMaxMode":"approval-required","allowEverything":false,"allowTasks":false,"devices":"cloud-computer-only"}');
      insert into public.organization_members (organization_id, account_id, role) values
        (${organization}, ${admin}, 'admin'), (${organization}, ${assignee}, 'member');
      insert into public.cloud_computers (
        id, account_id, generation, state, hostname, region, server_type, release,
        readiness_started_at, phase, stripe_checkout_id, stripe_customer_id,
        stripe_subscription_id, stripe_price_id, billing_currency, billing_status,
        created_at, updated_at, sealed_setup_code, setup_code_digest
      ) values
        (${personal}, ${assignee}, 1, 'active', 'cc-d1.home.example.test', 'us-central1-a',
          'default', '{}'::jsonb, now(), 'ready', 'cs_d1', 'cus_d1', 'sub_d1', 'price_1', 'usd',
          'active', now(), now(), 'sealed-d1', 'digest-d1'),
        (${work}, null, 1, 'active', 'cc-d2.home.example.test', 'us-central1-a', 'default',
          '{}'::jsonb, now(), 'ready', ${`work:${assignment}`}, ${`work:${assignment}`},
          ${`work:${assignment}`}, ${`work:${assignment}`}, '', 'active', now(), now(),
          'sealed-d2', 'digest-d2');
      insert into public.work_assignments (id, organization_id, assignee_account_id,
          cloud_computer_id, request_id, state)
        values (${assignment}, ${organization}, ${assignee}, ${work}, ${randomUUID()}, 'active');
      update public.cloud_computers set work_assignment_id = ${assignment} where id = ${work};
      insert into public.cloud_computer_backup_targets (id, endpoint, bucket, prefix,
          sealed_credentials, principal_fingerprint, reserved_organization_id)
        values (${reservedTarget}, 'https://s3.example.test', 'backups', 'seat-1', 'sealed',
          'fingerprint-seat-1', ${organization});
    `.execute(database);
    const before = await computer(personal);
    const workBefore = await computer(work);
    const left = () =>
      sql<{ name: string }>`
        select table_name as name from information_schema.tables where table_schema = 'public'
          and (table_name like 'organization%' or table_name like 'work\\_%')
        union all select table_name || '.' || column_name from information_schema.columns
          where table_schema = 'public' and (column_name like '%organization%'
            or column_name = 'work_assignment_id')
        order by 1`
        .execute(database)
        .then(({ rows }) => rows.map(({ name }) => name));
    const shapeBefore = await left();
    expect(shapeBefore.length).toBeGreaterThan(0);

    // A computer someone paid for is never destroyed or orphaned by a migration: it refuses and
    // names what an operator must decide about.
    const refused = await migrateControlPlaneToLatest(database).then(
      () => null,
      (error: unknown) => error as Error & { cause?: Error },
    );
    expect(refused?.message).toContain("0037_remove_organizations");
    expect(String(refused?.cause?.message)).toContain(`Cloud Computer ${work}`);
    expect(String(refused?.cause?.message)).toContain(`organization ${organization}`);
    expect(await left()).toEqual(shapeBefore);
    expect(await computer(work)).toEqual(workBefore);
    expect(await computer(personal)).toEqual(before);

    // An operator decides: here, the computer is handed to the person who used it, and the
    // organization's records go. Then the migration runs, and keeps both computers.
    await sql`
      update public.cloud_computers set work_assignment_id = null, account_id = ${assignee}
        where id = ${work};
      delete from public.work_assignments;
      delete from public.organization_members;
      delete from public.organizations;
    `.execute(database);
    await migrateControlPlaneToLatest(database);
    expect(await left()).toEqual([]);
    expect(await computer(personal)).toEqual(before);
    expect(await computer(work)).toMatchObject({ account_id: assignee, state: "active" });
    // The seat it reserved is a free backup target.
    const target = await sql<{ id: string }>`
      select id from public.cloud_computer_backup_targets where id = ${reservedTarget}
        and computer_id is null and checkout_key is null`.execute(database);
    expect(target.rows).toEqual([{ id: reservedTarget }]);
  });
});
