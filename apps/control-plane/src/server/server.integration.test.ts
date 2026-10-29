import { createHmac } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  opensteerAccountNativeOAuthClients,
} from "@opensteer/core";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://beta.front-door.test.invalid");
const managedDeploymentDomain = "managed.front-door.test.invalid";
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
  managedDeploymentDomain,
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin,
};

integration("Opensteer Account host", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, { managedDeploymentDomain });
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
      managedDeploymentDomain,
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
    expect(signedOut.headers.location).toBe(`https://${managedDeploymentDomain}/`);

    const signedIn = await server.inject({
      headers: { cookie: await signedSessionCookie(auth, accountId) },
      method: "GET",
      url: "/",
    });
    expect(signedIn.statusCode).toBe(302);
    expect(signedIn.headers.location).toBe(`https://${managedDeploymentDomain}/`);
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

  it("authorizes only the public hostname and active canonical origins for edge TLS", async () => {
    const deployment = await registerDeployment("TLS Cloud", "tls-cloud");
    const own = await server.inject({
      method: "GET",
      url: "/v1/edge/tls-allow?domain=BETA.FRONT-DOOR.TEST.INVALID.",
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe("ok");

    const edgeRoot = await server.inject({
      method: "GET",
      url: `/v1/edge/tls-allow?domain=${managedDeploymentDomain.toUpperCase()}.`,
    });
    expect(edgeRoot.statusCode).toBe(200);
    expect(edgeRoot.body).toBe("ok");

    const active = await server.inject({
      method: "GET",
      url: "/v1/edge/tls-allow?domain=tls-cloud.managed.front-door.test.invalid",
    });
    expect(active.statusCode).toBe(200);

    await database.deleteFrom("deployments").where("id", "=", deployment).executeTakeFirstOrThrow();
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/edge/tls-allow?domain=tls-cloud.managed.front-door.test.invalid",
        })
      ).statusCode,
    ).toBe(404);
    expect((await server.inject({ method: "GET", url: "/v1/edge/tls-allow" })).statusCode).toBe(
      400,
    );
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/edge/tls-allow?domain=https%3A%2F%2Fexample.test",
        })
      ).statusCode,
    ).toBe(400);
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

  async function registerDeployment(name: string, slug: string) {
    const deploymentId = DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`);
    const now = new Date();
    await database
      .insertInto("deployments")
      .values({
        id: deploymentId,
        ownerAccountId: accountId,
        canonicalOrigin: `https://${slug}.${managedDeploymentDomain}`,
        name,
        activeHostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
        hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
        reachability: "canonical",
        lifecycle: "active",
        oidcClientId: null,
        authorityEnvelope: null,
        directoryGeneration: 1,
        accountLink: null,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return deploymentId;
  }
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
