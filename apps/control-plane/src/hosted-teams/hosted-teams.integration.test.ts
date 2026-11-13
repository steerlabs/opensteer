import { generateKeyPairSync } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  HostedTeamBootstrapReceiptSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  DesiredHostedTeamsResponseSchema,
  HostedTeamViewSchema,
  ListHostedTeamsResponseSchema,
  accountHostedTeamAvailabilityPath,
  accountHostedTeamPath,
  accountHostedTeamRetryPath,
  accountHostedTeamsPath,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import {
  createId,
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
import {
  HostedTeamOperator,
  HostedTeamStore,
  HostedTeamSupersededError,
} from "./hosted-team-store.js";
import { hostedTeamSetupDeadlineMilliseconds } from "./hosted-team-bootstrap.js";
import { HostedTeamSetupTokenCipher } from "./setup-token-cipher.js";
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
  const cipher = new HostedTeamSetupTokenCipher(config.adoptionOperationKey);
  let ownerAnswer: boolean | undefined;
  const ownerChecks: ControlPlaneAccountId[] = [];
  const hostedTeams = new HostedTeamStore(database, {
    cipher,
    ownerCheck: async ({ accountId }) => {
      ownerChecks.push(accountId);
      return ownerAnswer === undefined ? undefined : { owner: ownerAnswer, onlyOwner: false };
    },
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
    ownerAnswer = undefined;
    ownerChecks.length = 0;
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

  it("creates a team once per request through the Account API, sealing its setup token", async () => {
    const bearer = await accountBearer(owner);
    const requestId = crypto.randomUUID();
    const create = () =>
      server.inject({
        method: "POST",
        url: accountHostedTeamsPath,
        headers: { authorization: bearer },
        payload: { requestId, name: "Acme Co", slug: "acme-co" },
      });
    const [first, second] = await Promise.all([create(), create()]);
    expect(first.statusCode).toBe(201);
    const team = HostedTeamViewSchema.parse(first.json());
    expect(HostedTeamViewSchema.parse(second.json()).id).toBe(team.id);
    expect(team).toMatchObject({
      name: "Acme Co",
      slug: "acme-co",
      origin: "https://acme-co.teams.opensteer.com",
      stage: "reserving",
    });
    expect(team.deploymentId).toBeUndefined();

    const [desired] = await desiredTeams();
    const row = await database
      .selectFrom("hostedTeams")
      .select(["sealedSetupToken"])
      .executeTakeFirstOrThrow();
    const token = cipher.open(team.id, 1, row.sealedSetupToken!);
    expect(desired).toMatchObject({ id: team.id, setupGeneration: 1 });
    expect(desired!.setupTokenDigest).toBe(digestSecret(token));
    const stored = await sql<{
      readonly row: string;
    }>`select hosted_teams::text as row from hosted_teams`.execute(database);
    expect(stored.rows[0]!.row).not.toContain(token);
    // Bound to its team and generation: the sealed value opens nowhere else.
    expect(() => cipher.open(team.id, 2, row.sealedSetupToken!)).toThrow();
    expect(() => cipher.open(crypto.randomUUID(), 1, row.sealedSetupToken!)).toThrow();

    const listed = await server.inject({
      method: "GET",
      url: accountHostedTeamsPath,
      headers: { authorization: bearer },
    });
    expect(ListHostedTeamsResponseSchema.parse(listed.json()).teams.map((t) => t.id)).toEqual([
      team.id,
    ]);
    const stranger = await accountBearer(await createAccount("stranger@example.test"));
    const peek = await server.inject({
      method: "GET",
      url: accountHostedTeamPath(team.id),
      headers: { authorization: stranger },
    });
    expect(peek.statusCode).toBe(404);
    const availability = async (slug: string) =>
      (
        await server.inject({
          method: "GET",
          url: `${accountHostedTeamAvailabilityPath}?${new URLSearchParams({ slug })}`,
          headers: { authorization: stranger },
        })
      ).json();
    expect(await availability("acme-co")).toEqual({ available: false, reason: "taken" });
    expect(await availability("admin")).toEqual({ available: false, reason: "reserved" });
    expect(await availability("a--b")).toEqual({ available: false, reason: "invalid" });
    expect(await availability("acme-two")).toEqual({ available: true });
    const unauthenticated = await server.inject({ method: "GET", url: accountHostedTeamsPath });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("holds the per-Account cap and each address under concurrent creates", async () => {
    const results = await Promise.allSettled(
      ["one", "two", "three", "four", "five"].map((slug) =>
        hostedTeams.create(owner, { requestId: crypto.randomUUID(), name: slug, slug }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(
      results.flatMap((result) => (result.status === "rejected" ? [result.reason.reason] : [])),
    ).toEqual(["hosted-team-limit-reached", "hosted-team-limit-reached"]);

    const [left, right] = [
      await createAccount("left@example.test"),
      await createAccount("right@example.test"),
    ];
    const race = await Promise.allSettled(
      [left, right].map((account) =>
        hostedTeams.create(account, { requestId: crypto.randomUUID(), name: "Same", slug: "same" }),
      ),
    );
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.find((result) => result.status === "rejected")).toMatchObject({
      reason: { reason: "hosted-team-address-taken" },
    });

    // A deleted team's address is never handed out again, and its slot frees up.
    const [first] = await hostedTeams.listForAccount(owner);
    await hostedTeams.remove(owner, first!.id);
    await expect(
      hostedTeams.create(left, { requestId: crypto.randomUUID(), name: "x", slug: first!.slug }),
    ).rejects.toMatchObject({ reason: "hosted-team-address-taken" });
    await expect(
      hostedTeams.create(owner, { requestId: crypto.randomUUID(), name: "six", slug: "six" }),
    ).resolves.toMatchObject({ stage: "reserving" });
  });

  it("advances stages only on reports for the current setup generation, and retries with a new token", async () => {
    const team = await createTeam("waiting");
    const stage = async () => (await hostedTeams.forAccount(owner, team.id))?.stage;
    await report(team.id, {
      phase: "provisioning",
      observedSetupGeneration: 0,
      setupGeneration: 1,
    });
    expect(await stage()).toBe("starting");
    expect((await report(team.id, { phase: "ready", observedSetupGeneration: 2 })).statusCode).toBe(
      404,
    );
    expect(await stage()).toBe("starting");
    await report(team.id, { phase: "ready", observedSetupGeneration: 1 });
    expect(await stage()).toBe("configuring");
    // A provisioner that doesn't say which generation it judged moves no stage.
    await report(team.id, { phase: "failed", observedSetupGeneration: 0 });
    expect(await stage()).toBe("configuring");
    await report(team.id, {
      phase: "failed",
      observedSetupGeneration: 0,
      setupGeneration: 1,
      message: "The team did not become ready; rollouts are held until it does.",
    });
    expect(await hostedTeams.forAccount(owner, team.id)).toMatchObject({
      stage: "failed",
      error: { message: "The team server didn’t start. Try again." },
    });

    const before = (await desiredTeams())[0]!;
    const retried = await server.inject({
      method: "POST",
      url: accountHostedTeamRetryPath(team.id),
      headers: { authorization: await accountBearer(owner) },
    });
    expect(retried.json()).toMatchObject({ stage: "starting" });
    const after = (await desiredTeams())[0]!;
    expect(after.setupGeneration).toBe(2);
    expect(after.setupTokenDigest).not.toBe(before.setupTokenDigest);
    // The Host still on the old generation says nothing about the new one.
    await report(team.id, { phase: "ready", observedSetupGeneration: 1 });
    expect(await stage()).toBe("starting");
    await report(team.id, { phase: "ready", observedSetupGeneration: 2, setupGeneration: 2 });
    expect(await stage()).toBe("configuring");
    const attempt = await hostedTeams.claimBootstrap();
    // Reports judged against generation 1 arrive late: they neither fail nor restart generation 2.
    for (const phase of ["failed", "provisioning"]) {
      const late = await report(team.id, { phase, observedSetupGeneration: 0, setupGeneration: 1 });
      expect(late.statusCode).toBe(200);
      expect(await stage()).toBe("configuring");
    }
    await expect(
      database
        .transaction()
        .execute((transaction) => hostedTeams.adoptionGuard(attempt!)(transaction)),
    ).resolves.toBeUndefined();
    expect(
      (await report(team.id, { phase: "failed", observedSetupGeneration: 0, setupGeneration: 3 }))
        .statusCode,
    ).toBe(404);
    // Retrying a team that hasn't failed changes nothing.
    await hostedTeams.retry(owner, team.id);
    expect((await desiredTeams())[0]!.setupGeneration).toBe(2);
  });

  it("fails a team that never got past starting, without trusting a report that names no generation", async () => {
    const stalled = await createTeam("stalled");
    const fresh = await createTeam("fresh");
    await report(stalled.id, {
      phase: "provisioning",
      observedSetupGeneration: 0,
      setupGeneration: 1,
    });
    // A provisioner from before setup generations: its failure could be about any generation.
    await report(stalled.id, { phase: "failed", observedSetupGeneration: 0 });
    const stage = async (id: HostedTeamView["id"]) =>
      (await hostedTeams.forAccount(owner, id))?.stage;
    expect(await stage(stalled.id)).toBe("starting");
    const deadline = (now: number) => new Date(now - hostedTeamSetupDeadlineMilliseconds);
    await sql`update hosted_teams set updated_at = now() - interval '1 second' * ${
      (hostedTeamSetupDeadlineMilliseconds + 2_000) / 1_000
    } where id = ${stalled.id}`.execute(database);
    expect(await hostedTeams.failStalledSetups(deadline(Date.now()))).toBe(1);
    expect(await hostedTeams.forAccount(owner, stalled.id)).toMatchObject({
      stage: "failed",
      error: { message: "The team server didn’t start. Try again." },
    });
    expect(await stage(fresh.id)).toBe("reserving");
    // A retry starts the clock again.
    await hostedTeams.retry(owner, stalled.id);
    expect(await hostedTeams.failStalledSetups(deadline(Date.now()))).toBe(0);
    expect(await stage(stalled.id)).toBe("starting");
    expect(
      await hostedTeams.failStalledSetups(
        deadline(Date.now() + hostedTeamSetupDeadlineMilliseconds + 1_000),
      ),
    ).toBe(2);
  });

  it("fences each bootstrap attempt to its claim", async () => {
    const team = await createTeam("fenced");
    await report(team.id, { phase: "ready", observedSetupGeneration: 1 });
    const now = Date.now();
    const first = await hostedTeams.claimBootstrap(new Date(now));
    expect(first).toMatchObject({ id: team.id, generation: 1, bootstrapped: false });
    expect(hostedTeams.openSetupToken(first!)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await hostedTeams.claimBootstrap(new Date(now + 1_000))).toBeUndefined();
    // The first attempt stalls past its lease; another replica takes the team over.
    const second = await hostedTeams.claimBootstrap(new Date(now + 3 * 60_000));
    expect(second!.attempt).toBe(first!.attempt + 1);
    await expect(
      hostedTeams.recordBootstrap(first!, { receipt: receiptFor(team.id) }),
    ).rejects.toBeInstanceOf(HostedTeamSupersededError);
    await expect(
      database
        .transaction()
        .execute((transaction) => hostedTeams.adoptionGuard(first!)(transaction)),
    ).rejects.toBeInstanceOf(HostedTeamSupersededError);
    await hostedTeams.failBootstrap(first!, "stale");
    expect((await hostedTeams.forAccount(owner, team.id))?.stage).toBe("configuring");
    await hostedTeams.failBootstrap(second!, "Setup didn’t finish. Try again.");
    expect((await hostedTeams.forAccount(owner, team.id))?.stage).toBe("failed");
  });

  it("lets the creator cancel until ready and only a Host-confirmed owner delete after", async () => {
    const pending = await createTeam("pending");
    const member = await createAccount("member@example.test");
    await expect(hostedTeams.remove(member, pending.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await hostedTeams.remove(owner, pending.id)).stage).toBe("deleting");
    expect(ownerChecks).toEqual([]);

    const team = await createTeam("owned");
    const deploymentId = await claim("https://owned.teams.opensteer.com");
    await database
      .updateTable("hostedTeams")
      .set({
        stage: "ready",
        deploymentId,
        bootstrapReceipt: JSON.stringify(receiptFor(team.id)),
      })
      .where("id", "=", team.id)
      .execute();
    await database
      .insertInto("deploymentDirectoryEntries")
      .values({
        deploymentId,
        accountId: member,
        generation: 1,
        present: true,
        observedAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    expect((await hostedTeams.forAccount(member, team.id))?.stage).toBe("ready");
    ownerAnswer = false;
    await expect(hostedTeams.remove(owner, team.id)).rejects.toMatchObject({
      reason: "hosted-team-owner-required",
    });
    // A Host that can't answer deletes nothing, not even for the team's creator.
    ownerAnswer = undefined;
    await expect(hostedTeams.remove(owner, team.id)).rejects.toMatchObject({
      code: "unavailable",
    });
    ownerAnswer = true;
    const deleting = await server.inject({
      method: "DELETE",
      url: accountHostedTeamPath(team.id),
      headers: { authorization: await accountBearer(member) },
    });
    expect(deleting.json()).toMatchObject({ id: team.id, stage: "deleting" });
    expect(ownerChecks).toEqual([owner, owner, member]);
    expect(await database.selectFrom("deployments").select("id").execute()).toEqual([]);
  });

  it("creates and follows a team from the portal without a setup link", async () => {
    const cookie = await portalCookie(owner);
    const form = await server.inject({
      method: "GET",
      url: "/teams/new",
      headers: { host: portalOrigin.host, cookie },
    });
    const requestId = /name="requestId" value="([^"]+)"/u.exec(form.body)?.[1];
    expect(requestId).toBeDefined();
    const created = await postForm(
      cookie,
      "/teams",
      new URLSearchParams({ requestId: requestId!, name: "Acme", slug: "acme" }).toString(),
    );
    expect(created.statusCode).toBe(303);
    const [team] = await hostedTeams.listForAccount(owner);
    expect(created.headers.location).toBe(`/teams/${team!.id}`);
    const progress = await server.inject({
      method: "GET",
      url: `/teams/${team!.id}`,
      headers: { host: portalOrigin.host, cookie },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.body).toContain("Setting up Acme");
    expect(progress.body).not.toContain("/setup#");
    const token = cipher.open(
      team!.id,
      1,
      (
        await database
          .selectFrom("hostedTeams")
          .select("sealedSetupToken")
          .executeTakeFirstOrThrow()
      ).sealedSetupToken!,
    );
    expect(progress.body).not.toContain(token);
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/teams/${team!.id}/status`,
          headers: { host: portalOrigin.host, cookie },
        })
      ).json(),
    ).toMatchObject({ id: team!.id, stage: "reserving" });
    const taken = await postForm(
      cookie,
      "/teams",
      new URLSearchParams({ requestId: crypto.randomUUID(), name: "A", slug: "acme" }).toString(),
    );
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toContain("That address is taken");
    const cross = await postForm(cookie, "/teams", "", "https://evil.test");
    expect(cross.statusCode).toBe(403);
    expect((await postForm(cookie, `/teams/${team!.id}/delete`)).statusCode).toBe(303);
    expect((await desiredTeams())[0]).toMatchObject({ state: "deleted", setupTokenDigest: null });
  });

  it("suspends, resumes and deletes through the operator path", async () => {
    await createTeam("abuse-case");
    const operator = new HostedTeamOperator(database);
    await operator.suspend("abuse-case", "spam report 42");
    const [suspended] = await desiredTeams();
    expect(suspended).toMatchObject({ state: "suspended" });
    expect(await hostedTeams.forAccount(owner, suspended!.id)).toMatchObject({
      stage: "failed",
      error: { message: "Opensteer suspended this team." },
    });
    await expect(hostedTeams.retry(owner, suspended!.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await operator.unsuspend("abuse-case");
    expect((await desiredTeams())[0]).toMatchObject({ state: "active" });
    await operator.deleteBySlug("abuse-case");
    expect((await desiredTeams())[0]).toMatchObject({ state: "deleted", setupTokenDigest: null });
  });

  it("deletes a team until the provisioner confirms, removing the Deployment adopted there", async () => {
    const team = await createTeam("gone");
    await claim("https://gone.teams.opensteer.com", await createAccount("claimant@example.test"));
    // A Host was adopted there, so only an owner it confirms may delete the team.
    await expect(hostedTeams.remove(owner, team.id)).rejects.toMatchObject({ code: "unavailable" });
    ownerAnswer = true;

    expect((await hostedTeams.remove(owner, team.id)).stage).toBe("deleting");
    expect(await desiredTeams()).toEqual([
      expect.objectContaining({ id: team.id, state: "deleted", setupTokenDigest: null }),
    ]);
    expect(await database.selectFrom("deployments").select("id").execute()).toEqual([]);
    expect((await hostedTeams.remove(owner, team.id)).stage).toBe("deleting");

    await report(team.id, { phase: "deleted", observedSetupGeneration: 1, hostImage: null });
    expect(await desiredTeams()).toEqual([]);
    await expect(hostedTeams.remove(owner, team.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps working with the rows and deletes a previous Account release writes", async () => {
    // The previous release inserts without the setup columns and deletes without clearing them.
    const id = crypto.randomUUID();
    await sql`insert into hosted_teams(id,slug,creator_account_id,state,setup_token_digest,setup_generation,phase)
      values(${id},'older',${owner},'active',${"a".repeat(64)},1,'provisioning')`.execute(database);
    expect(await hostedTeams.forAccount(owner, id)).toMatchObject({
      name: "older",
      stage: "reserving",
    });
    const sealed = await createTeam("sealed");
    await sql`update hosted_teams set state='deleted',setup_token_digest=null,deleted_at=now() where id=${sealed.id}`.execute(
      database,
    );
    const row = await database
      .selectFrom("hostedTeams")
      .select(["sealedSetupToken", "state"])
      .where("id", "=", sealed.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ sealedSetupToken: null, state: "deleted" });
  });

  it("deletes an Account's hosted teams with the Account", async () => {
    const cookie = await portalCookie(owner);
    await createTeam("with-account");
    const page = await server.inject({
      method: "GET",
      url: "/account/delete",
      headers: { host: portalOrigin.host, cookie },
    });
    expect(page.body).toContain("with-account.teams.opensteer.com");

    await new AccountDeletionService({ auth, connectLifecycle, store }).delete(owner);

    const rows = await database
      .selectFrom("hostedTeams")
      .select(["creatorAccountId", "state", "setupTokenDigest", "sealedSetupToken"])
      .execute();
    expect(rows).toEqual([
      { creatorAccountId: null, state: "deleted", setupTokenDigest: null, sealedSetupToken: null },
    ]);
  });

  it("keeps the Account, and says which team, when a team's Host can't say who else owns it", async () => {
    const cookie = await portalCookie(owner);
    await createTeam("unsettled");
    await claim("https://unsettled.teams.opensteer.com");
    ownerAnswer = undefined;
    const page = await postForm(cookie, "/account/delete");
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain(
      "Your Account wasn’t deleted: unsettled.teams.opensteer.com couldn’t confirm who else owns it.",
    );
    expect(page.body).not.toContain("Remote access may already be off");
    expect(
      await database.selectFrom("users").select("id").where("id", "=", owner).execute(),
    ).toEqual([{ id: owner }]);
    expect(
      await database
        .selectFrom("hostedTeams")
        .select("state")
        .where("slug", "=", "unsettled")
        .execute(),
    ).toEqual([{ state: "active" }]);
  });

  it("tombstones an Account's teams even when a release that predates them deletes the Account", async () => {
    await createTeam("older-release");

    // The previous Account release deletes the user row knowing nothing about hosted teams.
    await sql`delete from public.users where id = ${owner}`.execute(database);

    const row = await database
      .selectFrom("hostedTeams")
      .select(["creatorAccountId", "state", "setupTokenDigest", "sealedSetupToken", "deletedAt"])
      .where("slug", "=", "older-release")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      creatorAccountId: null,
      state: "deleted",
      setupTokenDigest: null,
      sealedSetupToken: null,
    });
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

  function createTeam(slug: string): Promise<HostedTeamView> {
    return hostedTeams.create(owner, { requestId: crypto.randomUUID(), name: slug, slug });
  }

  async function accountBearer(accountId: ControlPlaneAccountId): Promise<string> {
    const session = await (await auth.$context).internalAdapter.createSession(accountId);
    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          aud: publicOrigin.origin,
          iss: publicOrigin.origin,
          scope: "deployments:read deployments:write",
          sid: session.id,
          sub: accountId,
        },
      },
    });
    return `Bearer ${token}`;
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
    input: {
      phase: string;
      observedSetupGeneration: number;
      setupGeneration?: number;
      hostImage?: string | null;
      message?: string;
    },
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
    const id = DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`);
    await database
      .insertInto("deployments")
      .values({
        id,
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
    return id;
  }
});

function receiptFor(hostedTeamId: string) {
  return HostedTeamBootstrapReceiptSchema.parse({
    hostedTeamId,
    authority: {
      canonicalOrigin: "https://owned.teams.opensteer.com",
      deploymentId: DeploymentIdSchema.parse(`dep_${crypto.randomUUID()}`),
      hostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
      hostKeyFingerprint: HostKeyFingerprintSchema.parse(`sha256:${"A".repeat(43)}`),
    },
    ownerUserId: createId("user"),
    generalChannelId: createId("teamChannel"),
    completedAt: new Date().toISOString(),
  });
}

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
