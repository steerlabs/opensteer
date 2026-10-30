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
  betterAuth17Migration,
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
    expect(idClaims).toMatchObject({
      sub: userId,
      email: "owner@example.test",
      email_verified: true,
    });
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
