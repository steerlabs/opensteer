import { createHmac } from "node:crypto";
import {
  ConnectOperationIdSchema,
  ControlPlaneErrorResponseSchema,
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  opensteerAccountNativeOAuthClients,
  DeploymentIdSchema,
  HostInstanceIdSchema,
} from "@opensteer/core";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
  type ControlPlaneAuth,
} from "../auth/auth.js";
import type { ControlPlaneConfig } from "../config.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { PortalSessionStore } from "../portal/portal-sessions.js";
import { createControlPlaneServer } from "./server.js";
import { ControlPlaneStore } from "../database/store.js";
import { ControlPlaneError } from "./errors.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://beta.front-door.test.invalid");
const testDomain = "managed.front-door.test.invalid";
const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  connectDomain: "connect.front-door.test.invalid",
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

integration("Opensteer Account host", () => {
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
    await sql`truncate table users cascade`.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        id: accountId,
        displayName: "Front Door Owner",
        email: "front-door-owner@example.test",
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

  it("sends the front door to the portal instead of serving one", async () => {
    const signedOut = await server.inject({ method: "GET", url: "/" });
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(`https://${testDomain}/`);

    const signedIn = await server.inject({
      headers: { cookie: await signedSessionCookie(auth, accountId) },
      method: "GET",
      url: "/",
    });
    expect(signedIn.statusCode).toBe(302);
    expect(signedIn.headers.location).toBe(`https://${testDomain}/`);
    expect(signedIn.headers["cache-control"]).toBe("no-store");
    expect(signedIn.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("rejects a missing or invalid consent transaction before rendering consent controls", async () => {
    const missing = await server.inject({ method: "GET", url: "/consent" });
    expect(missing.statusCode).toBe(400);
    expect(missing.headers["content-type"]).toContain("text/html");
    expect(missing.body).toContain("Start authorization again");
    expect(missing.body).not.toContain('name="decision"');

    const invalidPost = await server.inject({
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: publicOrigin.origin,
      },
      method: "POST",
      payload: new URLSearchParams({ decision: "accept", oauth_query: "invalid" }).toString(),
      url: "/consent",
    });
    expect(invalidPost.statusCode).toBe(400);
    expect(invalidPost.headers["content-type"]).toContain("text/html");
    expect(invalidPost.body).toContain("Start authorization again");
  });

  it("answers a browser with a page and an API client with JSON when a request fails", async () => {
    const page = await server.inject({
      headers: { "sec-fetch-mode": "navigate" },
      method: "GET",
      url: "/no-such-page",
    });
    expect(page.statusCode).toBe(404);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Nothing here");
    // An Account-host failure still offers a way on, to the portal.
    expect(page.body).toContain(`href="https://${testDomain}/"`);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");

    const api = await server.inject({ method: "GET", url: "/no-such-page" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: "Not Found", statusCode: 404 });

    const font = page.body.match(/href="(\/fonts\/sans-[0-9a-f]{16}\.woff2)"/u)?.[1];
    if (!font) throw new Error("The page does not preload its font");
    const served = await server.inject({ method: "GET", url: font });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("font/woff2");
    expect(served.headers["cache-control"]).toContain("immutable");
    expect(served.rawPayload.subarray(0, 4).toString("latin1")).toBe("wOF2");
    const unknown = await server.inject({ method: "GET", url: "/fonts/sans-0.woff2" });
    expect(unknown.statusCode).toBe(404);
  });

  it("forwards sign-out cookies and redirects to the front door", async () => {
    const response = await server.inject({
      headers: {
        cookie: await signedSessionCookie(auth, accountId),
        origin: publicOrigin.origin,
      },
      method: "POST",
      url: "/sign-out",
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/");
    expect(response.headers["set-cookie"]).toBeTruthy();
  });

  it("preserves the typed completed-operation result in the Account HTTP error", async () => {
    const authority = {
      credentialHash: "credential-hash",
      deploymentId: DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`),
      hostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
    };
    const completedOperation = {
      operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
      operationKind: "revoke" as const,
      generation: 7,
    };
    const authenticate = vi
      .spyOn(store, "authenticateHostCredential")
      .mockResolvedValueOnce(authority);
    const revoke = vi.spyOn(connectLifecycle, "revokeForHost").mockRejectedValueOnce(
      new ControlPlaneError("conflict", "Completed Connect operation was superseded", {
        reason: "connect-operation-completed-superseded",
        completedOperation,
      }),
    );
    try {
      const response = await server.inject({
        method: "DELETE",
        url: "/v1/host/connect",
        headers: { authorization: `Bearer osc_${"a".repeat(43)}` },
        payload: {
          hostInstanceId: authority.hostInstanceId,
          operationId: completedOperation.operationId,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(ControlPlaneErrorResponseSchema.parse(response.json())).toEqual({
        error: {
          code: "conflict",
          message: "Completed Connect operation was superseded",
          reason: "connect-operation-completed-superseded",
          completedOperation,
        },
      });
    } finally {
      authenticate.mockRestore();
      revoke.mockRestore();
    }
  });
});

async function signedSessionCookie(
  auth: ControlPlaneAuth,
  ownerAccountId: ControlPlaneAccountId,
): Promise<string> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(ownerAccountId);
  const signature = createHmac("sha256", config.authSecret).update(session.token).digest("base64");
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
}
