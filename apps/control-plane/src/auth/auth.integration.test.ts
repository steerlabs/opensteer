import { createHash, createHmac } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  opensteerAccountNativeOAuthClients,
  opensteerDesktopAccountOAuthCallback,
  opensteerAccountDeleteOAuthScopes,
  opensteerDesktopOAuthClientId,
} from "@opensteer/core";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
  freshAccountSessionMilliseconds,
  type ControlPlaneAuth,
} from "./auth.js";
import type { ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { createControlPlaneServer } from "../server/server.js";
import { ControlPlaneStore } from "../database/store.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.auth.test.invalid");
const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  connectDomain: "connect.auth.test.invalid",
  connectCloudflare: {
    accountId: "a".repeat(32),
    apiToken: "test-cloudflare-api-token",
    credentialDerivationSecret: "d".repeat(32),
    workersRouteBypass: false,
    zoneId: "b".repeat(32),
  },
  databaseUrl: databaseUrl ?? "postgresql://unconfigured",
  environment: "test",
  googleClientId: "test-google-client",
  googleClientSecret: "test-google-secret",
  listenHost: "127.0.0.1",
  listenPort: 41_142,
  managedDeploymentDomain: "connect.auth.test.invalid",
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin,
};

integration("Account OAuth freshness PostgreSQL boundary", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, {
    managedDeploymentDomain: config.managedDeploymentDomain,
  });
  const connectLifecycle = new ConnectLifecycleService(database, {
    delete: async () => undefined,
    ensure: async () => Promise.reject(new Error("Connect is not used by this test")),
    readConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
    rotateConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
  });

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  beforeEach(async () => {
    await sql`
      truncate table
        oauth_consents,
        oauth_access_tokens,
        oauth_refresh_token,
        oauth_clients,
        auth_jwks,
        auth_rate_limits,
        auth_verifications,
        auth_sessions,
        auth_accounts,
        users
      cascade
    `.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        createdAt: now,
        displayName: "Account Owner",
        email: `owner-${accountId}@example.test`,
        emailVerified: true,
        id: accountId,
        image: null,
        updatedAt: now,
      })
      .execute();
    await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("persists authTime, requires prompt=login step-up, and preserves it across rotation", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      managedDeploymentDomain: config.managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const staleSession = await sessionCookie(auth, accountId);
      const staleAuthenticationTime = new Date(
        Date.now() - freshAccountSessionMilliseconds - 60_000,
      );
      await database
        .updateTable("authSessions")
        .set({ createdAt: staleAuthenticationTime })
        .where("id", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();

      const staleTokens = await authorizeAndExchange(server, staleSession.cookie, "consent");
      const staleRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked", "sessionId"])
        .where("sessionId", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(staleRefresh.authTime?.getTime()).toBe(staleAuthenticationTime.getTime());
      expect(staleRefresh.revoked).toBeNull();
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${staleTokens.accessToken}` }),
          { fresh: true, scope: "account:delete" },
        ),
      ).rejects.toMatchObject({ code: "recent_sign_in_required" });
      await expect(
        authenticator.authenticate(new Headers({ cookie: staleSession.cookie }), { fresh: true }),
      ).rejects.toMatchObject({ code: "recent_sign_in_required" });

      const stepUp = await beginAuthorization(server, staleSession.cookie, "login consent");
      expect(stepUp.pathname).toBe("/sign-in");
      expect(stepUp.searchParams.get("prompt")).toBe("login consent");

      const freshSession = await sessionCookie(auth, accountId);
      const freshTokens = await consentAndExchange(server, freshSession.cookie, stepUp);
      const freshRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked", "sessionId"])
        .where("sessionId", "=", freshSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(freshRefresh.authTime?.getTime()).toBe(freshSession.createdAt.getTime());
      expect(freshRefresh.revoked).toBeNull();
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${freshTokens.accessToken}` }),
          { fresh: true, scope: "account:delete" },
        ),
      ).resolves.toMatchObject({ accountId, kind: "bearer" });
      await expect(
        authenticator.authenticate(new Headers({ cookie: freshSession.cookie }), { fresh: true }),
      ).resolves.toMatchObject({ accountId, kind: "session" });

      const revoke = await server.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: opensteerDesktopOAuthClientId,
          resource: publicOrigin.origin,
          token: staleTokens.refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
        url: "/api/auth/oauth2/revoke",
      });
      expect(revoke.statusCode, revoke.body).toBe(200);
      const staleAfterStepUp = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked"])
        .where("sessionId", "=", staleSession.sessionId)
        .executeTakeFirstOrThrow();
      expect(staleAfterStepUp.authTime?.getTime()).toBe(staleAuthenticationTime.getTime());
      expect(staleAfterStepUp.revoked).toBeInstanceOf(Date);

      const rotated = await refreshTokens(server, freshTokens.refreshToken);
      const activeFreshRefresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["authTime", "revoked"])
        .where("sessionId", "=", freshSession.sessionId)
        .where("revoked", "is", null)
        .executeTakeFirstOrThrow();
      expect(activeFreshRefresh.authTime?.getTime()).toBe(freshSession.createdAt.getTime());
      await expect(
        authenticator.authenticate(
          new Headers({ authorization: `Bearer ${rotated.accessToken}` }),
          {
            fresh: true,
            scope: "account:delete",
          },
        ),
      ).resolves.toMatchObject({ accountId, kind: "bearer" });
    } finally {
      await server.close();
    }
  });

  it("rejects a retired native client's bearer and refresh tokens without ending the Account session", async () => {
    const auth = createControlPlaneAuth(database, config);
    const authenticator = new ControlPlaneAuthenticator(auth, database, publicOrigin);
    const server = await createControlPlaneServer({
      auth,
      authenticator,
      connectLifecycle,
      managedDeploymentDomain: config.managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const session = await sessionCookie(auth, accountId);
      const tokens = await authorizeAndExchange(server, session.cookie, "consent");
      const bearer = new Headers({ authorization: `Bearer ${tokens.accessToken}` });
      await expect(authenticator.authenticate(bearer)).resolves.toMatchObject({ accountId });

      await store.ensureOfficialNativeClients({
        clients: config.nativeOAuthClients.filter(
          (client) => client.clientId !== opensteerDesktopOAuthClientId,
        ),
      });

      await expect(authenticator.authenticate(bearer)).rejects.toMatchObject({
        code: "unauthorized",
      });
      expect((await requestRefresh(server, tokens.refreshToken)).statusCode).not.toBe(200);
      await expect(
        authenticator.authenticate(new Headers({ cookie: session.cookie })),
      ).resolves.toMatchObject({ accountId, kind: "session" });
    } finally {
      await server.close();
    }
  });
});

async function authorizeAndExchange(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  prompt: "consent",
) {
  return consentAndExchange(server, cookie, await beginAuthorization(server, cookie, prompt));
}

async function beginAuthorization(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  prompt: "consent" | "login consent",
): Promise<URL> {
  const verifier = `desktop-pkce-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const authorization = new URL("/api/auth/oauth2/authorize", publicOrigin);
  authorization.searchParams.set("client_id", opensteerDesktopOAuthClientId);
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("max_age", prompt === "login consent" ? "0" : "900");
  authorization.searchParams.set("prompt", prompt);
  authorization.searchParams.set("redirect_uri", opensteerDesktopAccountOAuthCallback);
  authorization.searchParams.set("resource", publicOrigin.origin);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", opensteerAccountDeleteOAuthScopes.join(" "));
  authorization.searchParams.set("state", crypto.randomUUID());
  const response = await server.inject({
    headers: { accept: "application/json", cookie },
    method: "GET",
    url: authorization.pathname + authorization.search,
  });
  expect(response.statusCode, response.body).toBe(200);
  const page = new URL(String(response.json<{ url?: unknown }>().url), publicOrigin);
  page.searchParams.set("test_verifier", verifier);
  return page;
}

async function consentAndExchange(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  authorizationPage: URL,
) {
  const verifier = authorizationPage.searchParams.get("test_verifier");
  authorizationPage.searchParams.delete("test_verifier");
  expect(verifier).toBeTruthy();
  const consent = await server.inject({
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: publicOrigin.origin,
    },
    method: "POST",
    payload: new URLSearchParams({
      decision: "accept",
      oauth_query: authorizationPage.search.slice(1),
    }).toString(),
    url: "/consent",
  });
  expect(consent.statusCode, consent.body).toBe(302);
  const callback = new URL(String(consent.headers.location));
  expect(`${callback.protocol}${callback.pathname}`).toBe(opensteerDesktopAccountOAuthCallback);
  expect(callback.searchParams.get("iss")).toBe(publicOrigin.origin);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: opensteerDesktopOAuthClientId,
      code: code ?? "",
      code_verifier: verifier ?? "",
      grant_type: "authorization_code",
      redirect_uri: opensteerDesktopAccountOAuthCallback,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
  expect(token.statusCode, token.body).toBe(200);
  const body = token.json<{ access_token?: unknown; refresh_token?: unknown }>();
  expect(body).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token) };
}

async function refreshTokens(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  refreshToken: string,
) {
  const response = await requestRefresh(server, refreshToken);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ access_token?: unknown; refresh_token?: unknown }>();
  expect(body).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token) };
}

function requestRefresh(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  refreshToken: string,
) {
  return server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: opensteerDesktopOAuthClientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
}

async function sessionCookie(auth: ControlPlaneAuth, userId: ControlPlaneAccountId) {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", config.authSecret).update(session.token).digest("base64");
  return {
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    createdAt: new Date(session.createdAt),
    sessionId: session.id,
  };
}
