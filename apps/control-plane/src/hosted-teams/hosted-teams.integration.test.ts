import { generateKeyPairSync } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { DesiredHostedTeamsResponseSchema } from "@opensteer/control-plane-protocol/hosted-teams";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  opensteerAccountNativeOAuthClients,
} from "@opensteer/core";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountDeletionService } from "../account/account-deletion.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
  type ControlPlaneAuth,
} from "../auth/auth.js";
import type { ControlPlaneConfig } from "../config.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import { portalCallbackUri, portalOAuthClientId, portalOAuthScopes } from "../portal/portal.js";
import { PortalSessionStore } from "../portal/portal-sessions.js";
import { createControlPlaneServer } from "../server/server.js";
import { HostedTeamStore } from "./hosted-team-store.js";
import { googleServiceAccountVerifier } from "./provisioner-routes.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
// Runs only under pnpm test:integration, which provides the database.
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.hosted-teams.test.invalid");
const portalOrigin = new URL("https://portal.hosted-teams.test.invalid");
const provisionerEmail = "team-provisioner@opensteer-test.iam.gserviceaccount.com";
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  connectDomain: "connect.hosted-teams.test.invalid",
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
  listenPort: 41_143,
  portalOrigin,
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin,
};

const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

integration("Hosted teams", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const store = new ControlPlaneStore(database, publicOrigin, { portalOrigin });
  const hostedTeams = new HostedTeamStore(database);
  const portalSessions = new PortalSessionStore(database);
  const connectLifecycle = new ConnectLifecycleService(database, {
    delete: async () => undefined,
    ensure: async () => Promise.reject(new Error("Connect is not used by this test")),
    readConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
    rotateConnectorToken: async () => Promise.reject(new Error("Connect is not used by this test")),
  });
  let auth: ControlPlaneAuth;
  let server: Awaited<ReturnType<typeof createControlPlaneServer>>;
  let owner: ControlPlaneAccountId;

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
    auth = createControlPlaneAuth(database, config);
    const publicJwk = { ...(await exportJWK(googleKey.publicKey)), kid: "google", alg: "RS256" };
    server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      hostedTeams: {
        store: hostedTeams,
        verifyProvisioner: googleServiceAccountVerifier({
          audience: publicOrigin.origin,
          email: provisionerEmail,
          keys: createLocalJWKSet({ keys: [publicJwk] }),
        }),
      },
      portalOrigin,
      portalSessions,
      publicOrigin,
      store,
    });
  });

  beforeEach(async () => {
    await sql`truncate table users, hosted_teams cascade`.execute(database);
    await store.ensureOfficialPortalClient({
      clientId: portalOAuthClientId,
      redirectUri: portalCallbackUri(portalOrigin),
      scopes: portalOAuthScopes,
    });
    owner = await createAccount("owner@example.test");
  });

  afterAll(async () => {
    await server.close();
    await database.destroy();
  });

  it("admits only the configured provisioner's Google identity", async () => {
    const desired = (authorization?: string) =>
      server.inject({
        method: "GET",
        url: "/v1/hosted-teams/desired",
        headers: authorization ? { authorization } : {},
      });

    expect((await desired()).statusCode).toBe(401);
    expect(
      (await desired(`Bearer ${await idToken({ audience: "https://elsewhere.test" })}`)).statusCode,
    ).toBe(401);
    expect(
      (await desired(`Bearer ${await idToken({ issuer: "https://evil.test" })}`)).statusCode,
    ).toBe(401);
    expect(
      (await desired(`Bearer ${await idToken({ key: otherKey.privateKey })}`)).statusCode,
    ).toBe(401);
    expect(
      (
        await desired(
          `Bearer ${await idToken({ email: "someone@opensteer-test.iam.gserviceaccount.com" })}`,
        )
      ).statusCode,
    ).toBe(403);
    expect((await desired(`Bearer ${await idToken({ emailVerified: false })}`)).statusCode).toBe(
      403,
    );

    const allowed = await desired(`Bearer ${await idToken()}`);
    expect(allowed.statusCode).toBe(200);
    expect(DesiredHostedTeamsResponseSchema.parse(allowed.json())).toEqual({ teams: [] });
  });

  it("creates a team whose setup link reaches only the creator, and stores only its digest", async () => {
    const cookie = await portalCookie(owner);
    const created = await createTeam(cookie, "Acme-Co");
    expect(created.statusCode).toBe(200);
    expect(created.headers["cache-control"]).toBe("no-store");
    const setupUrl = setupLinkIn(created.body);
    expect(setupUrl.origin).toBe("https://acme-co.teams.opensteer.com");
    expect(setupUrl.pathname).toBe("/setup");
    const token = setupUrl.hash.slice(1);

    const [team] = await desiredTeams();
    expect(team).toMatchObject({
      slug: "acme-co",
      state: "active",
      setupGeneration: 1,
      setupTokenDigest: digestSecret(token),
    });
    const stored = await sql<{
      readonly row: string;
    }>`select hosted_teams::text as row from hosted_teams`.execute(database);
    expect(stored.rows[0]!.row).not.toContain(token);

    const stranger = await portalCookie(await createAccount("stranger@example.test"));
    const peek = await server.inject({
      method: "GET",
      url: `/teams/${team!.id}/status`,
      headers: { host: portalOrigin.host, cookie: stranger },
    });
    expect(peek.statusCode).toBe(404);
  });

  it("refuses reserved, malformed and taken addresses, and a fourth live team", async () => {
    const cookie = await portalCookie(owner);
    expect((await createTeam(cookie, "admin")).statusCode).toBe(400);
    expect((await createTeam(cookie, "a--b")).statusCode).toBe(400);
    expect((await createTeam(cookie, "-ab")).statusCode).toBe(400);
    expect((await createTeam(cookie, "one")).statusCode).toBe(200);
    const other = await portalCookie(await createAccount("other@example.test"));
    const taken = await createTeam(other, "one");
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toContain("That address is taken");
    expect((await createTeam(cookie, "two")).statusCode).toBe(200);
    expect((await createTeam(cookie, "three")).statusCode).toBe(200);
    const fourth = await createTeam(cookie, "four");
    expect(fourth.statusCode).toBe(409);
    expect(fourth.body).toContain("You can have 3 hosted teams");

    const [one] = await desiredTeams();
    await postForm(cookie, `/teams/${one!.id}/delete`);
    expect((await createTeam(cookie, "four")).statusCode).toBe(200);
    // A deleted team's address is never handed out again.
    expect((await createTeam(other, "one")).statusCode).toBe(409);
    const cross = await createTeam(cookie, "cross-origin", "https://evil.test");
    expect(cross.statusCode).toBe(403);
  });

  it("waits for the provisioner to run the newest setup link before opening it", async () => {
    const cookie = await portalCookie(owner);
    const first = setupLinkIn((await createTeam(cookie, "waiting")).body).hash.slice(1);
    const [team] = await desiredTeams();
    const status = async () =>
      (
        await server.inject({
          method: "GET",
          url: `/teams/${team!.id}/status`,
          headers: { host: portalOrigin.host, cookie },
        })
      ).json<{ readonly ready: boolean; readonly phase: string }>();
    expect(await status()).toMatchObject({ ready: false, phase: "provisioning" });
    expect(
      (await report(team!.id, { phase: "ready", observedSetupGeneration: 1 })).statusCode,
    ).toBe(200);
    expect(await status()).toMatchObject({ ready: true, phase: "ready" });

    const renewed = await postForm(cookie, `/teams/${team!.id}/setup-link`);
    expect(renewed.statusCode).toBe(200);
    const second = setupLinkIn(renewed.body).hash.slice(1);
    expect(second).not.toBe(first);
    const [rotated] = await desiredTeams();
    expect(rotated).toMatchObject({ setupGeneration: 2, setupTokenDigest: digestSecret(second) });
    expect(await status()).toMatchObject({ ready: false });
    expect(
      (await report(team!.id, { phase: "ready", observedSetupGeneration: 3 })).statusCode,
    ).toBe(404);
    await report(team!.id, { phase: "ready", observedSetupGeneration: 2 });
    expect(await status()).toMatchObject({ ready: true });

    await claim("https://waiting.teams.opensteer.com");
    const afterClaim = await postForm(cookie, `/teams/${team!.id}/setup-link`);
    expect(afterClaim.statusCode).toBe(409);
  });

  it("suspends, resumes and deletes through the operator path", async () => {
    const cookie = await portalCookie(owner);
    await createTeam(cookie, "abuse-case");
    await hostedTeams.suspend("abuse-case", "spam report 42");
    const [suspended] = await desiredTeams();
    expect(suspended).toMatchObject({ state: "suspended" });
    expect((await postForm(cookie, `/teams/${suspended!.id}/setup-link`)).statusCode).toBe(409);
    await hostedTeams.unsuspend("abuse-case");
    expect((await desiredTeams())[0]).toMatchObject({ state: "active" });
    await hostedTeams.deleteBySlug("abuse-case");
    expect((await desiredTeams())[0]).toMatchObject({ state: "deleted", setupTokenDigest: null });
  });

  it("deletes a team until the provisioner confirms, removing the Deployment adopted there", async () => {
    const cookie = await portalCookie(owner);
    await createTeam(cookie, "gone");
    const [team] = await desiredTeams();
    const claimant = await createAccount("claimant@example.test");
    await claim("https://gone.teams.opensteer.com", claimant);

    const deleted = await postForm(cookie, `/teams/${team!.id}/delete`);
    expect(deleted.statusCode).toBe(303);
    expect(await desiredTeams()).toEqual([
      expect.objectContaining({ id: team!.id, state: "deleted", setupTokenDigest: null }),
    ]);
    const deployments = await database.selectFrom("deployments").select("id").execute();
    expect(deployments).toEqual([]);
    expect((await postForm(cookie, `/teams/${team!.id}/delete`)).statusCode).toBe(404);

    await report(team!.id, { phase: "deleted", observedSetupGeneration: 1, hostImage: null });
    expect(await desiredTeams()).toEqual([]);
  });

  it("deletes an Account's hosted teams with the Account", async () => {
    const cookie = await portalCookie(owner);
    await createTeam(cookie, "with-account");
    const page = await server.inject({
      method: "GET",
      url: "/account/delete",
      headers: { host: portalOrigin.host, cookie },
    });
    expect(page.body).toContain("with-account.teams.opensteer.com");

    await new AccountDeletionService({ auth, connectLifecycle, store }).delete(owner);

    const rows = await database
      .selectFrom("hostedTeams")
      .select(["creatorAccountId", "state", "setupTokenDigest"])
      .execute();
    expect(rows).toEqual([{ creatorAccountId: null, state: "deleted", setupTokenDigest: null }]);
  });

  it("tombstones an Account's teams even when a release that predates them deletes the Account", async () => {
    const cookie = await portalCookie(owner);
    await createTeam(cookie, "older-release");

    // The previous Account release deletes the user row knowing nothing about hosted teams.
    await sql`delete from public.users where id = ${owner}`.execute(database);

    const row = await database
      .selectFrom("hostedTeams")
      .select(["creatorAccountId", "state", "setupTokenDigest", "deletedAt"])
      .where("slug", "=", "older-release")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ creatorAccountId: null, state: "deleted", setupTokenDigest: null });
    expect(row.deletedAt).toBeInstanceOf(Date);
    const desired = await hostedTeams.desired();
    expect(desired.find((team) => team.slug === "older-release")?.state).toBe("deleted");
  });

  async function createAccount(email: string): Promise<ControlPlaneAccountId> {
    const id = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const now = new Date();
    await database
      .insertInto("users")
      .values({
        id,
        displayName: email,
        email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    return id;
  }

  async function portalCookie(accountId: ControlPlaneAccountId): Promise<string> {
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(accountId);
    const created = await portalSessions.create({ accountId, accountSessionId: session.id });
    return `__Host-opensteer.portal=${encodeURIComponent(created.token)}`;
  }

  function createTeam(cookie: string, slug: string, origin = portalOrigin.origin) {
    return postForm(cookie, "/teams", `slug=${encodeURIComponent(slug)}`, origin);
  }

  function postForm(cookie: string, url: string, payload = "", origin = portalOrigin.origin) {
    return server.inject({
      method: "POST",
      url,
      payload,
      headers: {
        host: portalOrigin.host,
        origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
  }

  async function desiredTeams() {
    const response = await server.inject({
      method: "GET",
      url: "/v1/hosted-teams/desired",
      headers: { authorization: `Bearer ${await idToken()}` },
    });
    return DesiredHostedTeamsResponseSchema.parse(response.json()).teams;
  }

  async function report(
    id: string,
    input: { phase: string; observedSetupGeneration: number; hostImage?: string | null },
  ) {
    return server.inject({
      method: "POST",
      url: `/v1/hosted-teams/${id}/status`,
      headers: { authorization: `Bearer ${await idToken()}` },
      payload: {
        hostImage: `ghcr.io/steerlabs/opensteer-team-host@sha256:${"a".repeat(64)}`,
        ...input,
      },
    });
  }

  async function claim(origin: string, accountId: ControlPlaneAccountId = owner) {
    await database
      .insertInto("deployments")
      .values({
        id: DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`),
        ownerAccountId: accountId,
        name: "Team",
        reachability: "canonical",
        activeHostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
        hostKeyFingerprint: HostKeyFingerprintSchema.parse(`sha256:${"A".repeat(43)}`),
        canonicalOrigin: origin,
        lifecycle: "active",
        oidcClientId: null,
        authorityEnvelope: null,
        accountLink: null,
      })
      .execute();
  }
});

async function idToken(
  overrides: {
    readonly audience?: string;
    readonly email?: string;
    readonly emailVerified?: boolean;
    readonly issuer?: string;
    readonly key?: CryptoKey | import("node:crypto").KeyObject;
  } = {},
): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? provisionerEmail,
    email_verified: overrides.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "google" })
    .setIssuer(overrides.issuer ?? "https://accounts.google.com")
    .setAudience(overrides.audience ?? publicOrigin.origin)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(overrides.key ?? googleKey.privateKey);
}

function setupLinkIn(body: string): URL {
  const match = /"setupUrl":"(https:\/\/[^"]+)"/u.exec(body);
  if (!match) throw new Error("The page carries no setup link");
  return new URL(match[1]!);
}
