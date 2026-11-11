import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  opensteerAccountNativeOAuthClients,
  type DeploymentId,
} from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
} from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
  freshAccountSessionMilliseconds,
  type ControlPlaneAuth,
} from "../auth/auth.js";
import type { ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import {
  portalCallbackUri,
  portalDeleteAccountPath,
  portalOAuthClientId,
  portalOAuthScopes,
  portalSignInPath,
  portalSignOutPath,
} from "./portal.js";
import { PortalSessionStore } from "./portal-sessions.js";
import { createControlPlaneServer } from "../server/server.js";
import { ControlPlaneStore } from "../database/store.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.portal.test.invalid");
const testDomain = "portal.test.invalid";
const accountHost = publicOrigin.host;
const portalSessionCookieName = "__Host-opensteer.portal";
const portalFlowCookieName = "__Host-opensteer.portal-flow";
const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  connectDomain: "connect.portal.test.invalid",
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
  portalOrigin: new URL(`https://${testDomain}`),
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin,
};

integration("Opensteer web portal", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, {
    portalOrigin: new URL(`https://${testDomain}`),
  });
  const portalSessions = new PortalSessionStore(database);
  const connectLifecycle = new ConnectLifecycleService(database, {
    delete: async () => undefined,
    ensure: async () => Promise.reject(new Error("Connect is not used by this test")),
    readConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
    rotateConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
  });
  let auth: ControlPlaneAuth;
  let server: Awaited<ReturnType<typeof createControlPlaneServer>>;

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
    auth = createControlPlaneAuth(database, config);
    server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      portalOrigin: new URL(`https://${testDomain}`),
      portalSessions,
      publicOrigin,
      store,
    });
  });

  beforeEach(async () => {
    // Truncating accounts cascades into every account-referencing table,
    // including the OAuth clients, so the portal client is seeded per test the
    // same way the runtime seeds it at startup.
    await sql`truncate table users cascade`.execute(database);
    await store.ensureOfficialPortalClient({
      clientId: portalOAuthClientId,
      redirectUri: portalCallbackUri(new URL(`https://${testDomain}`)),
      scopes: portalOAuthScopes,
    });
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        id: accountId,
        displayName: "Portal Owner",
        email: "portal-owner@example.test",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  });

  afterAll(async () => {
    await server.close();
    await database.destroy();
  });

  it("updates the official portal callback and presentation on startup", async () => {
    await database
      .updateTable("oauthClients")
      .set({
        redirectUris: JSON.stringify(["https://old.test/auth/callback"]),
        uri: "https://old.test",
      })
      .where("clientId", "=", portalOAuthClientId)
      .execute();
    const store = new ControlPlaneStore(database, publicOrigin, {
      portalOrigin: config.portalOrigin,
    });
    await store.ensureOfficialPortalClient({
      clientId: portalOAuthClientId,
      redirectUri: portalCallbackUri(config.portalOrigin),
      scopes: portalOAuthScopes,
    });
    const client = await database
      .selectFrom("oauthClients")
      .select(["uri", "redirectUris"])
      .where("clientId", "=", portalOAuthClientId)
      .executeTakeFirstOrThrow();
    expect(client.uri).toBe(config.portalOrigin.origin);
    expect(client.redirectUris).toEqual([portalCallbackUri(config.portalOrigin)]);
  });

  it("renders the signed-out portal immediately, with no redirect and no cookie", async () => {
    const response = await server.inject({ headers: portalHeaders(), method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Sign in");
    expect(response.body).toContain(`<link rel="preconnect" href="${publicOrigin.origin}">`);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("sends the Account root to the portal and keeps its auth moments off the apex", async () => {
    const accountRoot = await server.inject({
      headers: { host: accountHost },
      method: "GET",
      url: "/",
    });
    expect(accountRoot.statusCode).toBe(302);
    expect(accountRoot.headers.location).toBe(`https://${testDomain}/`);

    const signInOnApex = await server.inject({
      headers: portalHeaders(),
      method: "GET",
      url: "/sign-in",
    });
    expect(signInOnApex.statusCode).toBe(404);
    const authOnApex = await server.inject({
      headers: portalHeaders(),
      method: "GET",
      url: "/.well-known/openid-configuration",
    });
    expect(authOnApex.statusCode).toBe(404);
    const portalPathOnAccountHost = await server.inject({
      headers: { host: accountHost },
      method: "GET",
      url: portalSignInPath,
    });
    expect(portalPathOnAccountHost.statusCode).toBe(404);
  });

  it("signs in through the explicit portal OAuth flow", async () => {
    const flow = await runSignInFlow(await signedSessionCookie(accountId));
    expect(location(flow.signIn)).toContain("prompt=none");
    expect(flow.callback.statusCode).toBe(303);
    expect(flow.callback.headers.location).toBe("/");
    expect(cookieFor(flow.callback, portalFlowCookieName)).toContain("Max-Age=0");

    const portal = await server.inject({
      headers: portalHeaders({ cookie: sessionCookiePair(flow.callback) }),
      method: "GET",
      url: "/",
    });
    expect(portal.statusCode, portal.body).toBe(200);
    expect(portal.body).toContain("Your Opensteer");
    expect(portal.body).toContain("portal-owner@example.test");
    expect(portal.body).toContain(`action="${portalSignOutPath}"`);

    // The portal keeps no OAuth token from the exchange it just completed.
    const tokens = await database
      .selectFrom("oauthRefreshToken")
      .select((expression) => expression.fn.countAll().as("count"))
      .where("clientId", "=", portalOAuthClientId)
      .executeTakeFirstOrThrow();
    expect(Number(tokens.count)).toBe(0);
  });

  it("renders the signed-out portal when no Account session answers", async () => {
    const flow = await runSignInFlow();

    expect(flow.authorize.statusCode).toBe(302);
    expect(new URL(location(flow.authorize)).searchParams.get("error")).toBe("login_required");
    expect(flow.callback.statusCode).toBe(200);
    expect(flow.callback.body).toContain("Sign in");

    // With the hint gone the next visit renders instead of looping.
    const next = await server.inject({ headers: portalHeaders(), method: "GET", url: "/" });
    expect(next.statusCode).toBe(200);
  });

  it("renders sign-in for a stale portal session", async () => {
    const response = await server.inject({
      headers: portalHeaders({ cookie: `${portalSessionCookieName}=ops_stale` }),
      method: "GET",
      url: "/",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign in");
    expect(cookieFor(response, portalSessionCookieName)).toContain("Max-Age=0");
  });

  it("restarts sign-in when the callback state is missing, stale, or forged", async () => {
    const signIn = await server.inject({
      headers: portalHeaders(),
      method: "GET",
      url: portalSignInPath,
    });
    const flowCookie = cookiePair(signIn, portalFlowCookieName);
    const state = new URL(location(signIn)).searchParams.get("state");
    expect(state).toBeTruthy();

    const withoutFlow = await server.inject({
      headers: portalHeaders(),
      method: "GET",
      url: `/auth/callback?code=abc&state=${state}`,
    });
    expect(withoutFlow.statusCode).toBe(400);
    expect(withoutFlow.body).toContain("Start sign-in again");

    const mismatched = await server.inject({
      headers: portalHeaders({ cookie: flowCookie }),
      method: "GET",
      url: "/auth/callback?code=abc&state=someone-elses-state",
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.body).toContain("Start sign-in again");

    const foreignIssuer = await server.inject({
      headers: portalHeaders({ cookie: flowCookie }),
      method: "GET",
      url: `/auth/callback?code=abc&state=${state}&iss=https%3A%2F%2Fevil.example`,
    });
    expect(foreignIssuer.statusCode).toBe(400);
    expect(foreignIssuer.body).toContain("Start sign-in again");

    const spentCode = await server.inject({
      headers: portalHeaders({ cookie: flowCookie }),
      method: "GET",
      url: `/auth/callback?code=never-issued&state=${state}`,
    });
    expect(spentCode.statusCode).toBe(400);
    expect(spentCode.body).toContain("Start sign-in again");
  });

  it("returns to a validated same-origin path and refuses anything else", async () => {
    const cookie = await signedSessionCookie(accountId);
    const deepLink = await runSignInFlow(
      cookie,
      `${portalSignInPath}?return=${encodeURIComponent("/deployments")}`,
    );
    expect(deepLink.callback.statusCode).toBe(303);
    expect(deepLink.callback.headers.location).toBe("/deployments");

    const offSite = await runSignInFlow(
      cookie,
      `${portalSignInPath}?return=${encodeURIComponent("//evil.example/steal")}`,
    );
    expect(offSite.callback.statusCode).toBe(303);
    expect(offSite.callback.headers.location).toBe("/");
  });

  it("lists canonical Deployments without treating directory presence as Host health", async () => {
    const cookie = await portalSessionCookie();
    const empty = await server.inject({
      headers: portalHeaders({ cookie }),
      method: "GET",
      url: "/",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("Set up Opensteer");
    expect(empty.body).toContain("Opensteers you set up or join show up here.");

    const ready = await registerDeployment("First <Server>", "first-server");
    await publishPresence(ready);
    await registerDeployment("Second Server", "second-server");
    const listed = await server.inject({
      headers: portalHeaders({ cookie }),
      method: "GET",
      url: "/",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain("First &lt;Server&gt;");
    expect(listed.body).not.toContain("First <Server>");
    expect(listed.body).toContain(`https://second-server.${testDomain}`);
    expect(listed.body).not.toContain(">Needs attention<");
    expect(listed.body).not.toContain(">Ready<");
    expect(listed.body).not.toContain("Open this deployment to check");
    expect(listed.body).not.toContain("Set up Opensteer");
  });

  it("signs out of the portal and of the Account session that proved it", async () => {
    const flow = await runSignInFlow(await signedSessionCookie(accountId));
    const cookie = sessionCookiePair(flow.callback);

    const crossOrigin = await server.inject({
      headers: portalHeaders({ cookie, origin: publicOrigin.origin }),
      method: "POST",
      url: portalSignOutPath,
    });
    expect(crossOrigin.statusCode).toBe(403);

    const signedOut = await server.inject({
      headers: portalHeaders({ cookie, origin: `https://${testDomain}` }),
      method: "POST",
      url: portalSignOutPath,
    });
    expect(signedOut.statusCode).toBe(303);
    expect(signedOut.headers.location).toBe("/");
    expect(cookieFor(signedOut, portalSessionCookieName)).toContain("Max-Age=0");

    const sessions = await database
      .selectFrom("authSessions")
      .select((expression) => expression.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(sessions.count)).toBe(0);
    const portalRows = await database
      .selectFrom("portalSessions")
      .select((expression) => expression.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(portalRows.count)).toBe(0);

    // The Account session is gone, so the next silent attempt is refused.
    const retry = await runSignInFlow();
    expect(new URL(location(retry.authorize)).searchParams.get("error")).toBe("login_required");
  });

  it("keeps Account sign-out cookies host scoped", async () => {
    const response = await server.inject({
      headers: {
        cookie: await signedSessionCookie(accountId),
        host: accountHost,
        origin: publicOrigin.origin,
      },
      method: "POST",
      url: "/sign-out",
    });

    expect(response.statusCode).toBe(303);
  });

  describe("Account deletion", () => {
    const secondAccountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const accountExists = async (id: ControlPlaneAccountId) =>
      (await database.selectFrom("users").select("id").where("id", "=", id).executeTakeFirst()) !==
      undefined;
    const age = () =>
      database
        .updateTable("authSessions")
        .set({ createdAt: new Date(Date.now() - freshAccountSessionMilliseconds - 60_000) })
        .where("userId", "=", accountId)
        .execute();
    const post = (cookie: string, origin = `https://${testDomain}`) =>
      server.inject({
        headers: portalHeaders({ cookie, origin }),
        method: "POST",
        url: portalDeleteAccountPath,
      });
    /** Signs in as `signedInAs`, through a forced login, from the flow this page started. */
    const proveIdentity = async (cookie: string, signedInAs: ControlPlaneAccountId) => {
      const start = await server.inject({
        headers: portalHeaders({ cookie }),
        method: "GET",
        url: portalDeleteAccountPath,
      });
      expect(start.statusCode, start.body).toBe(303);
      const signIn = await server.inject({
        headers: portalHeaders({ cookie }),
        method: "GET",
        url: location(start),
      });
      expect(signIn.statusCode, signIn.body).toBe(302);
      const authorizeUrl = new URL(location(signIn));
      expect(authorizeUrl.searchParams.get("prompt")).toBe("login");
      expect(authorizeUrl.searchParams.get("max_age")).toBe("0");
      const forced = await server.inject({
        headers: { host: accountHost, cookie: await signedSessionCookie(accountId) },
        method: "GET",
        url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      });
      expect(new URL(location(forced), publicOrigin).pathname).toBe("/sign-in");
      // After that login the provider resumes this same request for whoever signed in.
      authorizeUrl.searchParams.delete("prompt");
      authorizeUrl.searchParams.delete("max_age");
      const authorized = await server.inject({
        headers: { host: accountHost, cookie: await signedSessionCookie(signedInAs) },
        method: "GET",
        url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
      });
      const callbackUrl = new URL(location(authorized));
      expect(callbackUrl.origin).toBe(`https://${testDomain}`);
      return server.inject({
        headers: portalHeaders({
          cookie: `${cookie}; ${cookiePair(signIn, portalFlowCookieName)}`,
        }),
        method: "GET",
        url: `${callbackUrl.pathname}${callbackUrl.search}`,
      });
    };

    beforeEach(async () => {
      const now = new Date();
      await database
        .insertInto("users")
        .values({
          id: secondAccountId,
          displayName: "Second Account",
          email: "second-account@example.test",
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    });

    it("names what it removes, then deletes the Account and ends the session", async () => {
      const cookie = await portalSessionCookie();
      await registerDeployment("Team server", "team-server");
      const page = await server.inject({
        headers: portalHeaders({ cookie }),
        method: "GET",
        url: portalDeleteAccountPath,
      });
      expect(page.statusCode, page.body).toBe(200);
      expect(page.body).toContain("portal-owner@example.test");
      expect(page.body).toContain("Team server");

      const forged = await post(cookie, publicOrigin.origin);
      expect(forged.statusCode).toBe(403);
      expect(await accountExists(accountId)).toBe(true);

      const deleted = await post(cookie);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(cookieFor(deleted, portalSessionCookieName)).toContain("Max-Age=0");
      expect(await accountExists(accountId)).toBe(false);
      expect(await database.selectFrom("deployments").selectAll().execute()).toEqual([]);
      expect(await accountExists(secondAccountId)).toBe(true);
    });

    it("asks a person who signed in long ago to prove it first", async () => {
      const cookie = await portalSessionCookie();
      await age();
      const refused = await post(cookie);
      expect(refused.statusCode).toBe(303);
      expect(await accountExists(accountId)).toBe(true);

      const proven = await proveIdentity(cookie, accountId);
      expect(proven.statusCode, proven.body).toBe(303);
      expect(location(proven)).toBe(portalDeleteAccountPath);
      const freshCookie = sessionCookiePair(proven);
      const deleted = await post(freshCookie);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(await accountExists(accountId)).toBe(false);
    });

    it("never moves the session to a different Account while proving identity", async () => {
      const cookie = await portalSessionCookie();
      await age();
      const proven = await proveIdentity(cookie, secondAccountId);
      expect(proven.statusCode, proven.body).toBe(409);
      expect(proven.headers["set-cookie"]?.toString() ?? "").not.toContain(
        `${portalSessionCookieName}=ops_`,
      );
      expect(await accountExists(accountId)).toBe(true);
      expect(await accountExists(secondAccountId)).toBe(true);
    });
  });

  async function runSignInFlow(accountCookie?: string, signInUrl = `${portalSignInPath}?silent=1`) {
    const signIn = await server.inject({
      headers: portalHeaders(),
      method: "GET",
      url: signInUrl,
    });
    expect(signIn.statusCode).toBe(302);
    const flowCookie = cookiePair(signIn, portalFlowCookieName);
    const authorizeUrl = new URL(location(signIn));
    expect(authorizeUrl.origin).toBe(publicOrigin.origin);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `https://${testDomain}/auth/callback`,
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const authorize = await server.inject({
      headers: {
        host: accountHost,
        ...(accountCookie === undefined ? {} : { cookie: accountCookie }),
      },
      method: "GET",
      url: `${authorizeUrl.pathname}${authorizeUrl.search}`,
    });
    const callbackUrl = new URL(location(authorize));
    expect(callbackUrl.origin).toBe(`https://${testDomain}`);
    const callback = await server.inject({
      headers: portalHeaders({ cookie: flowCookie }),
      method: "GET",
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
    });
    return { authorize, callback, signIn };
  }

  async function portalSessionCookie(): Promise<string> {
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(accountId);
    const created = await portalSessions.create({
      accountId,
      accountSessionId: session.id,
    });
    return `${portalSessionCookieName}=${encodeURIComponent(created.token)}`;
  }

  async function signedSessionCookie(ownerAccountId: ControlPlaneAccountId): Promise<string> {
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(ownerAccountId);
    const signature = createHmac("sha256", config.authSecret)
      .update(session.token)
      .digest("base64");
    return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  }

  async function registerDeployment(name: string, slug: string): Promise<DeploymentId> {
    const deploymentId = DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`);
    const hostInstanceId = HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`);
    const hostKeys = generateKeyPairSync("ed25519");
    const hostSpki = hostKeys.publicKey.export({ format: "der", type: "spki" });
    const hostKeyFingerprint = HostKeyFingerprintSchema.parse(
      `sha256:${createHash("sha256").update(hostSpki).digest("base64url")}`,
    );
    const canonicalOrigin = `https://${slug}.${testDomain}`;
    const authority = {
      canonicalOrigin,
      deploymentId,
      hostInstanceId,
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: {
        kind: "team" as const,
      },
    };
    const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse({
      document: authority,
      publicKey: { algorithm: "Ed25519", spki: hostSpki.toString("base64url") },
      signature: sign(null, hostDiscoverySigningBytes(authority), hostKeys.privateKey).toString(
        "base64url",
      ),
    });
    const now = new Date();
    await database
      .insertInto("deployments")
      .values({
        id: deploymentId,
        ownerAccountId: accountId,
        canonicalOrigin,
        name,
        activeHostInstanceId: hostInstanceId,
        hostKeyFingerprint,
        reachability: "canonical",
        lifecycle: "active",
        oidcClientId: null,
        authorityEnvelope,
        directoryGeneration: 1,
        accountLink: null,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("deploymentConnect")
      .values({
        deploymentId,
        generation: 0,
        observedAt: null,
        origin: null,
        state: "disabled",
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return deploymentId;
  }

  async function publishPresence(deploymentId: DeploymentId): Promise<void> {
    const now = new Date();
    await database
      .insertInto("deploymentDirectoryEntries")
      .values({
        accountId,
        deploymentId,
        generation: 1,
        observedAt: now,
        present: true,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  }
});

function portalHeaders(
  extra: { readonly cookie?: string; readonly origin?: string } = {},
): Record<string, string> {
  return {
    host: testDomain,
    ...(extra.cookie === undefined ? {} : { cookie: extra.cookie }),
    ...(extra.origin === undefined ? {} : { origin: extra.origin }),
  };
}

function setCookies(response: { readonly headers: Record<string, unknown> }): readonly string[] {
  const header = response.headers["set-cookie"];
  if (header === undefined) return [];
  return Array.isArray(header) ? header.map(String) : [String(header)];
}

function cookieFor(response: { readonly headers: Record<string, unknown> }, name: string): string {
  const cookie = setCookies(response).find((entry) => entry.startsWith(`${name}=`));
  expect(cookie, `expected a ${name} cookie`).toBeTruthy();
  return cookie ?? "";
}

function cookiePair(response: { readonly headers: Record<string, unknown> }, name: string): string {
  return cookieFor(response, name).split(";", 1)[0] ?? "";
}

function sessionCookiePair(response: { readonly headers: Record<string, unknown> }): string {
  return cookiePair(response, portalSessionCookieName);
}

function location(response: { readonly headers: Record<string, unknown> }): string {
  return String(response.headers.location ?? "");
}
