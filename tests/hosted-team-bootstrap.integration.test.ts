import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { AdoptionOperationCipher } from "../apps/control-plane/src/adoption/adoption-operation-crypto.js";
import { BetterAuthAccountAdoptionCompletionGrantIssuer } from "../apps/control-plane/src/adoption/adoption-grant-issuer.js";
import { HttpHostAccountAdoptionProofVerifier } from "../apps/control-plane/src/adoption/adoption-verifier.js";
import { AccountDeletionService } from "../apps/control-plane/src/account/account-deletion.js";
import { ConnectLifecycleService } from "../apps/control-plane/src/account/connect-lifecycle.js";
import {
  ControlPlaneAuthenticator,
  createControlPlaneAuth,
} from "../apps/control-plane/src/auth/auth.js";
import type { ControlPlaneConfig } from "../apps/control-plane/src/config.js";
import { createControlPlaneDatabase } from "../apps/control-plane/src/database/database.js";
import type { ControlPlaneDatabaseSchema } from "../apps/control-plane/src/database/schema.js";
import { ControlPlaneStore } from "../apps/control-plane/src/database/store.js";
import {
  HostedTeamBootstrapper,
  hostedTeamOwnerCheck,
} from "../apps/control-plane/src/hosted-teams/hosted-team-bootstrap.js";
import { HttpHostedTeamHost } from "../apps/control-plane/src/hosted-teams/hosted-team-host.js";
import { HostedTeamStore } from "../apps/control-plane/src/hosted-teams/hosted-team-store.js";
import { HostedTeamSetupTokenCipher } from "../apps/control-plane/src/hosted-teams/setup-token-cipher.js";
import { createControlPlaneServer } from "../apps/control-plane/src/server/server.js";
import { createHostRuntime, type TeamHostRuntime } from "../apps/host/src/runtime/runtime.js";
import { parseHostConfig } from "../packages/config/src/index.js";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "../packages/control-plane-protocol/src/index.js";
import { opensteerAccountNativeOAuthClients, type UserId } from "../packages/core/src/index.js";
import type { DatabaseSchema } from "../packages/database/src/schema.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { TeamMembersStore } from "../packages/database/src/team-members-store.js";
import { oidcIdentityProviderIdForIssuer } from "../packages/identity/src/index.js";
import { freePort } from "../packages/shared/src/loopbackPort.test-support.js";
import { digestSecret } from "../packages/shared/src/secretDigest.js";

const issuer = new URL("https://accounts.opensteer.com");
const portalOrigin = new URL("https://app.opensteer.com");
const origin = "https://acme.teams.opensteer.com";
const operationKey = Buffer.alloc(32, 7).toString("base64url");
const accountConfig: ControlPlaneConfig = {
  adoptionOperationKey: operationKey,
  personalAccountLinkOperationKey: Buffer.alloc(32, 3).toString("base64url"),
  authSecret: "hosted-team-bootstrap-secret-with-at-least-32-bytes",
  connectDomain: "connect.hosted-team-bootstrap.invalid",
  connectCloudflare: {
    accountId: "a".repeat(32),
    apiToken: "test-cloudflare-api-token",
    credentialDerivationSecret: "d".repeat(32),
    workersRouteBypass: false,
    zoneId: "b".repeat(32),
  },
  databaseUrl: "postgresql://unconfigured",
  environment: "test",
  googleClientId: "test-google-client",
  googleClientSecret: "test-google-secret",
  listenHost: "127.0.0.1",
  listenPort: 41_144,
  portalOrigin,
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  publicOrigin: issuer,
};

type Step = "discover" | "state" | "exchange" | "proof" | "consume" | "complete" | "owner";
const steps: Record<string, Step> = {
  "/.well-known/opensteer": "discover",
  "/v1/team/setup/state": "state",
  "/v1/team/setup/exchange": "exchange",
  "/v1/team/setup/adoption/proof": "proof",
  "/v1/team/setup/adoption/complete": "complete",
  "/v1/team/setup/owner": "owner",
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/**
 * Account and one hosted team's Host, in process, talking over fetch routed by origin. A fault
 * drops one call to the team Host before it arrives or after the Host answered.
 */
async function startHostedTeam() {
  const routes = new Map<string, FastifyInstance>();
  const faults: { step: Step; when?: "before" | "after"; during?: () => Promise<void> }[] = [];
  const seen: Step[] = [];
  const route =
    (faulted: boolean): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const app = routes.get(url.origin);
      if (!app) throw new TypeError(`fetch failed: ${url.origin}`);
      const step = url.pathname.endsWith("/consume")
        ? "consume"
        : (steps[url.pathname] as Step | undefined);
      const fault =
        faulted && step ? faults.find((candidate) => candidate.step === step) : undefined;
      if (fault) faults.splice(faults.indexOf(fault), 1);
      if (step && faulted) seen.push(step);
      if (fault?.during) await fault.during();
      if (fault?.when === "before") throw new TypeError("fetch failed: connection reset");
      const headers: Record<string, string> = { host: url.host };
      request.headers.forEach((value, name) => (headers[name] = value));
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      const response = await app.inject({
        method: request.method as "GET",
        url: `${url.pathname}${url.search}`,
        headers,
        ...(body ? { payload: body } : {}),
      });
      if (fault?.when === "after") throw new TypeError("fetch failed: response lost");
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [String(value)])
          responseHeaders.append(name, item);
      }
      return new Response(
        [204, 304].includes(response.statusCode) ? null : new Uint8Array(response.rawPayload),
        { status: response.statusCode, headers: responseHeaders },
      );
    };
  const toHost = route(true);
  const toAccount = route(false);

  const control = await cloneTestDatabase("controlPlane");
  closers.push(() => control.drop());
  const { database: accounts } = await ownTestDatabaseProducer(control.url, async () => {
    const database = createControlPlaneDatabase({ connectionString: control.url });
    return { database, close: () => database.destroy() };
  });
  const auth = createControlPlaneAuth(accounts, accountConfig);
  const store = new ControlPlaneStore(accounts, issuer, {
    portalOrigin,
    adoptionCompletionGrantIssuer: new BetterAuthAccountAdoptionCompletionGrantIssuer(auth, issuer),
    adoptionOperationCipher: new AdoptionOperationCipher(operationKey),
    adoptionProofVerifier: new HttpHostAccountAdoptionProofVerifier({ fetch: toHost }),
  });
  const host = new HttpHostedTeamHost({ fetch: toHost });
  const cipher = new HostedTeamSetupTokenCipher(operationKey);
  const teams = new HostedTeamStore(accounts, {
    cipher,
    ownerCheck: hostedTeamOwnerCheck({
      host,
      issuer,
      sign: async (claims) => (await auth.api.signJWT({ body: { payload: claims } })).token,
    }),
  });
  const connectLifecycle = new ConnectLifecycleService(accounts, {
    delete: async () => undefined,
    ensure: async () => Promise.reject(new Error("Connect is not used")),
    readConnectorToken: async () => Promise.reject(new Error("Connect is not used")),
    rotateConnectorToken: async () => Promise.reject(new Error("Connect is not used")),
  });
  const server = await createControlPlaneServer({
    auth,
    authenticator: new ControlPlaneAuthenticator(auth, accounts, issuer),
    connectLifecycle,
    hostedTeams: { store: teams, verifyProvisioner: async () => undefined },
    portalOrigin,
    publicOrigin: issuer,
    store,
  });
  closers.push(() => server.close());
  routes.set(issuer.origin, server);

  let clock = Date.now();
  const errors: unknown[] = [];
  const bootstrapper = new HostedTeamBootstrapper({
    teams,
    accounts: store,
    host,
    issuer,
    onError: (error) => errors.push(error),
    now: () => clock,
  });
  const creator = await createAccount(accounts, "maya@example.test", "Maya");
  const created = await teams.create(creator, {
    requestId: crypto.randomUUID(),
    name: "Acme",
    slug: "acme",
  });
  const sealed = await accounts
    .selectFrom("hostedTeams")
    .select("sealedSetupToken")
    .where("id", "=", created.id)
    .executeTakeFirstOrThrow();
  const token = cipher.open(created.id, 1, sealed.sealedSetupToken!);

  const hostClone = await cloneTestDatabase("host");
  closers.push(() => hostClone.drop());
  const directory = await mkdtemp(join(tmpdir(), "hosted-team-"));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  const { runtime } = await ownTestDatabaseProducer(hostClone.url, async () => {
    const runtime = await createHostRuntime(
      parseHostConfig({
        OPENSTEER_MODE: "development",
        OPENSTEER_DEPLOYMENT_KIND: "team",
        OPENSTEER_DEPLOYMENT_NAME: "Acme",
        OPENSTEER_DATABASE_URL: hostClone.url,
        OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
        OPENSTEER_HOST_DATA_DIR: directory,
        OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST: digestSecret(token),
        OPENSTEER_CANONICAL_ORIGIN: origin,
        OPENSTEER_BIND_ADDRESS: "127.0.0.1",
        OPENSTEER_PORT: String(await freePort()),
      }),
      {
        accountControlFetch: toAccount,
        accountDirectoryFetch: toAccount,
        accountDirectoryIntervalMs: 100,
      },
    );
    return { runtime, close: () => runtime.close() };
  });
  if (runtime.kind !== "team") throw new Error("Expected a team Host");
  const team = runtime as TeamHostRuntime;
  closers.push(() => team.close());
  routes.set(origin, team.app);
  const hostDatabase = team.team.access.database as Kysely<DatabaseSchema>;

  /** Runs one bootstrap pass after any backoff, as the worker's next tick would. */
  async function pass() {
    clock += 3 * 60_000;
    return bootstrapper.runOnce();
  }
  async function stage() {
    return (await teams.forAccount(creator, created.id))?.stage;
  }
  async function ready() {
    await vi.waitFor(
      async () => {
        // The Host publishes its directory on its own schedule; Account promotes on arrival.
        expect(await stage()).toBe("ready");
      },
      { timeout: 15_000, interval: 50 },
    );
  }
  async function owners() {
    return hostDatabase
      .selectFrom("teamMembers as m")
      .innerJoin("authAccounts as a", "a.userId", "m.userId")
      .select(["a.accountId", "m.role", "m.state", "m.userId"])
      .orderBy("a.accountId")
      .execute();
  }
  return {
    accounts,
    auth,
    bootstrapper,
    connectLifecycle,
    created,
    creator,
    errors,
    faults,
    hostDatabase,
    owners,
    pass,
    ready,
    report: () =>
      teams.reportStatus(created.id, {
        phase: "ready",
        hostImage: null,
        observedSetupGeneration: 1,
      }),
    seen,
    server,
    stage,
    store,
    team,
    teams,
  };
}

async function createAccount(
  database: Kysely<ControlPlaneDatabaseSchema>,
  email: string,
  displayName: string,
): Promise<ControlPlaneAccountId> {
  const id = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
  const now = new Date();
  await database
    .insertInto("users")
    .values({
      id,
      displayName,
      email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function expectBootstrapped(system: Awaited<ReturnType<typeof startHostedTeam>>) {
  await system.ready();
  expect(await system.owners()).toEqual([
    expect.objectContaining({ accountId: system.creator, role: "owner", state: "active" }),
  ]);
  const channels = await system.hostDatabase
    .selectFrom("teamChannels")
    .select(["id", "name", "kind"])
    .execute();
  expect(channels).toEqual([expect.objectContaining({ name: "general", kind: "public" })]);
  const row = await system.accounts
    .selectFrom("hostedTeams")
    .select(["sealedSetupToken", "deploymentId", "bootstrapReceipt"])
    .where("id", "=", system.created.id)
    .executeTakeFirstOrThrow();
  expect(row.sealedSetupToken).toBeNull();
  expect(row.deploymentId).toBe(system.team.deployment.id);
  expect(row.bootstrapReceipt).toMatchObject({
    hostedTeamId: system.created.id,
    generalChannelId: channels[0]!.id,
  });
  const deployments = await system.accounts
    .selectFrom("deployments")
    .select(["id", "ownerAccountId"])
    .where("canonicalOrigin", "=", origin)
    .execute();
  expect(deployments).toEqual([{ id: system.team.deployment.id, ownerAccountId: system.creator }]);
  // Nothing sealed stays behind once the Host acknowledged the completion.
  const sealed = await system.accounts
    .selectFrom("deploymentAdoptionOperations")
    .select(["state", "sealedProvisioningBundle"])
    .where("state", "=", "completed")
    .execute();
  expect(sealed).toEqual([]);
}

it("sets up a hosted team from Account: owner, #general and directory, with nothing left to disclose", async () => {
  const system = await startHostedTeam();
  // The creator's phone, which wants outcomes; it hears once the team is ready.
  await sql`insert into notification_devices(id,account_id,installation_id,application,platform,token_ciphertext,token_hash,approvals_enabled,run_outcomes_enabled)
    values(${crypto.randomUUID()},${system.creator},${"i".repeat(16)},'mobile','android','sealed',${"h".repeat(43)},true,true)`.execute(
    system.accounts,
  );
  expect(await system.stage()).toBe("reserving");
  expect((await system.report()).configuring).toBe(true);
  expect(await system.stage()).toBe("configuring");
  await system.bootstrapper.runOnce();
  await expectBootstrapped(system);
  expect(system.errors).toEqual([]);
  // The creator signs in at the team through Account OIDC like anyone: the binding already exists.
  const linked = await system.hostDatabase
    .selectFrom("authAccounts")
    .select(["providerId", "accountId", "password", "accessToken"])
    .execute();
  expect(linked).toEqual([
    {
      providerId: oidcIdentityProviderIdForIssuer("opensteer-account", issuer.origin),
      accountId: system.creator,
      password: null,
      accessToken: null,
    },
  ]);
  const descriptor = (await system.team.app.inject({ url: "/.well-known/opensteer" })).json();
  expect(descriptor.capabilities).toContain("team-hosted-bootstrap-v1");
  const [general] = await system.hostDatabase.selectFrom("teamChannels").select("id").execute();
  const pushes = await system.accounts
    .selectFrom("notificationDeliveries")
    .select(["kind", "deploymentId", "teamTarget", "status"])
    .execute();
  expect(pushes).toEqual([
    {
      kind: "team-ready",
      deploymentId: system.team.deployment.id,
      teamTarget: {
        kind: "team-ready",
        origin,
        teamId: system.team.deployment.id,
        channelId: general!.id,
      },
      status: "pending",
    },
  ]);
});

for (const [step, when] of [
  ["discover", "before"],
  ["exchange", "after"],
  ["proof", "after"],
  ["consume", "after"],
  ["complete", "before"],
  ["complete", "after"],
] as const) {
  it(`recovers when the ${step} call is lost ${when} the team Host sees it`, async () => {
    const system = await startHostedTeam();
    await system.report();
    system.faults.push({ step, when });
    await system.bootstrapper.runOnce();
    expect(await system.stage()).toBe("configuring");
    await system.pass();
    await expectBootstrapped(system);
  });
}

/** The creator makes someone else an owner of the team and leaves it; answers the new owner. */
async function handOwnershipAway(system: Awaited<ReturnType<typeof startHostedTeam>>) {
  const [creator] = await system.owners();
  const other = await system.hostDatabase.transaction().execute(async (transaction) => {
    const id = `usr_${crypto.randomUUID()}` as UserId;
    await sql`insert into users(id,display_name,email,email_verified) values(${id},'Sam','sam@example.test',true)`.execute(
      transaction,
    );
    await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${id},'sam','owner','active',now(),now())`.execute(
      transaction,
    );
    return id;
  });
  await new TeamMembersStore(system.team.team.access).change(
    { kind: "human", userId: other },
    creator!.userId as UserId,
    "remove",
  );
  return other;
}

it("answers a replayed completion with the first receipt after the creator left and someone else owns the team", async () => {
  const system = await startHostedTeam();
  await system.report();
  system.faults.push({ step: "complete", when: "after" });
  await system.bootstrapper.runOnce();
  const [creator] = await system.owners();
  // Before Account hears back, the creator hands the team to someone else and leaves it.
  const other = await handOwnershipAway(system);
  await system.pass();
  await system.ready();
  const members = await system.hostDatabase
    .selectFrom("teamMembers")
    .select(["userId", "role", "state"])
    .orderBy("userId")
    .execute();
  expect(members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: creator!.userId, state: "removed" }),
      { userId: other, role: "owner", state: "active" },
    ]),
  );
  expect(members).toHaveLength(2);
  expect(await system.hostDatabase.selectFrom("teamChannels").select("id").execute()).toHaveLength(
    1,
  );
});

it("never brings back a creator this team removed, and fails setup instead", async () => {
  const system = await startHostedTeam();
  // The Host already knows this Account as someone it removed.
  const providerId = oidcIdentityProviderIdForIssuer("opensteer-account", issuer.origin);
  const userId = `usr_${crypto.randomUUID()}`;
  await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Maya','maya@example.test',true)`.execute(
    system.hostDatabase,
  );
  await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${`aac_${crypto.randomUUID()}`},${system.creator},${providerId},${userId})`.execute(
    system.hostDatabase,
  );
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},'maya','member','removed',now(),now())`.execute(
    system.hostDatabase,
  );
  await system.report();
  await system.bootstrapper.runOnce();
  expect(await system.stage()).toBe("failed");
  expect(await system.owners()).toEqual([
    expect.objectContaining({ accountId: system.creator, role: "member", state: "removed" }),
  ]);
  expect(await system.hostDatabase.selectFrom("teamChannels").select("id").execute()).toEqual([]);
});

it("drops an attempt whose team was cancelled mid-setup, leaving no Deployment behind", async () => {
  const system = await startHostedTeam();
  await system.report();
  system.faults.push({
    step: "proof",
    during: async () => {
      await system.teams.remove(system.creator, system.created.id);
    },
  });
  await system.bootstrapper.runOnce();
  expect(await system.stage()).toBe("deleting");
  expect(await system.accounts.selectFrom("deployments").select("id").execute()).toEqual([]);
  expect(await system.pass()).toBe(0);
  expect(await system.owners()).toEqual([]);
});

it("refuses a creator's cancel once the Host may hold an owner, even after ownership moved on", async () => {
  const system = await startHostedTeam();
  await system.report();
  // The Host committed the creator as owner; Account never heard back.
  system.faults.push({ step: "complete", when: "after" });
  await system.bootstrapper.runOnce();
  expect(await system.stage()).toBe("configuring");
  const sam = await handOwnershipAway(system);
  await expect(system.teams.remove(system.creator, system.created.id)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await system.stage()).toBe("configuring");
  expect(await system.accounts.selectFrom("deployments").select("id").execute()).toHaveLength(1);
  expect(
    await system.hostDatabase
      .selectFrom("teamMembers")
      .select(["userId", "role", "state"])
      .where("userId", "=", sam)
      .execute(),
  ).toEqual([{ userId: sam, role: "owner", state: "active" }]);
});

it("never lets a cancel and the owner's completion both win", async () => {
  const system = await startHostedTeam();
  await system.report();
  let cancelled: Promise<unknown> | undefined;
  system.faults.push({
    step: "complete",
    // The creator cancels after Account adopted the Host, while the completion is on its way.
    during: async () => {
      cancelled = system.teams.remove(system.creator, system.created.id).catch((error) => error);
      await cancelled;
    },
  });
  await system.bootstrapper.runOnce();
  expect(await cancelled).toMatchObject({ code: "conflict" });
  await expectBootstrapped(system);
});

it("deletes a ready team only for an owner its own Host names", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  const stranger = await createAccount(system.accounts, "stranger@example.test", "Stranger");
  await expect(system.teams.remove(stranger, system.created.id)).rejects.toMatchObject({
    code: "not_found",
  });
  // A member the directory lists sees the team but is not its owner.
  const member = await createAccount(system.accounts, "sam@example.test", "Sam");
  await system.accounts
    .insertInto("deploymentDirectoryEntries")
    .values({
      deploymentId: system.team.deployment.id,
      accountId: member,
      generation: 1,
      present: true,
      observedAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  expect((await system.teams.forAccount(member, system.created.id))?.stage).toBe("ready");
  await expect(system.teams.remove(member, system.created.id)).rejects.toMatchObject({
    reason: "hosted-team-owner-required",
  });
  // Once the Host no longer counts the creator as an owner, neither does Account.
  const [creator] = await system.owners();
  await system.hostDatabase
    .updateTable("teamMembers")
    .set({ role: "member" })
    .where("userId", "=", creator!.userId as UserId)
    .execute();
  await expect(system.teams.remove(system.creator, system.created.id)).rejects.toMatchObject({
    reason: "hosted-team-owner-required",
  });
  await system.hostDatabase
    .updateTable("teamMembers")
    .set({ role: "owner" })
    .where("userId", "=", creator!.userId as UserId)
    .execute();
  expect(system.seen.filter((step) => step === "owner").length).toBeGreaterThanOrEqual(2);
  expect((await system.teams.remove(system.creator, system.created.id)).stage).toBe("deleting");
  expect(await system.accounts.selectFrom("deployments").select("id").execute()).toEqual([]);
});

it("fails setup for a Host that already has an owner, without touching that owner", async () => {
  const system = await startHostedTeam();
  const someone = `usr_${crypto.randomUUID()}`;
  await sql`insert into users(id,display_name,email,email_verified) values(${someone},'Ola','ola@example.test',true)`.execute(
    system.hostDatabase,
  );
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${someone},'ola','owner','active',now(),now())`.execute(
    system.hostDatabase,
  );
  await system.report();
  await system.bootstrapper.runOnce();
  expect(await system.stage()).toBe("failed");
  const members = await system.hostDatabase
    .selectFrom("teamMembers")
    .select(["userId", "role", "state"])
    .execute();
  expect(members).toEqual([{ userId: someone, role: "owner", state: "active" }]);
  expect(await system.accounts.selectFrom("deployments").select("id").execute()).toEqual([]);
});

it("keeps a team another owner runs when its creator deletes their Account, handing it to them", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  const deploymentId = system.team.deployment.id;
  const providerId = oidcIdentityProviderIdForIssuer("opensteer-account", issuer.origin);
  /** Someone the directory lists, who is `role` on the team's own Host. */
  const person = async (email: string, role: "owner" | "member") => {
    const account = await createAccount(system.accounts, email, email.split("@")[0]!);
    await system.accounts
      .insertInto("deploymentDirectoryEntries")
      .values({
        deploymentId,
        accountId: account,
        generation: 1,
        present: true,
        observedAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const userId = `usr_${crypto.randomUUID()}`;
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},${email},${email},true)`.execute(
      system.hostDatabase,
    );
    await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${`aac_${crypto.randomUUID()}`},${account},${providerId},${userId})`.execute(
      system.hostDatabase,
    );
    await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},${email.split("@")[0]!},${role},'active',now(),now())`.execute(
      system.hostDatabase,
    );
    return account;
  };
  await person("ada@example.test", "member");
  const sam = await person("sam@example.test", "owner");
  // A member who hid the team before becoming its owner keeps no contradicting marker.
  await system.accounts
    .insertInto("deploymentDirectoryVisibility")
    .values({ deploymentId, accountId: sam, hiddenAt: new Date() })
    .execute();

  await new AccountDeletionService({
    auth: system.auth,
    connectLifecycle: system.connectLifecycle,
    hostedTeams: system.teams,
    store: system.store,
  }).delete(system.creator);

  expect(
    await system.accounts
      .selectFrom("hostedTeams")
      .select(["state", "creatorAccountId", "deploymentId"])
      .where("id", "=", system.created.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: "active", creatorAccountId: sam, deploymentId });
  expect(
    await system.accounts.selectFrom("deployments").select(["id", "ownerAccountId"]).execute(),
  ).toEqual([{ id: deploymentId, ownerAccountId: sam }]);
  // The team keeps its Account sign-in.
  expect(
    await system.accounts
      .selectFrom("oauthClients")
      .innerJoin("deployments", "deployments.oidcClientId", "oauthClients.clientId")
      .select("oauthClients.userId")
      .execute(),
  ).toEqual([{ userId: sam }]);
  expect(
    await system.accounts.selectFrom("deploymentDirectoryVisibility").select("accountId").execute(),
  ).toEqual([]);
  expect((await system.teams.forAccount(sam, system.created.id))?.stage).toBe("ready");
  expect(
    await system.accounts
      .selectFrom("users")
      .select("id")
      .where("id", "=", system.creator)
      .execute(),
  ).toEqual([]);
});

it("deletes a team with its creator's Account when the creator is its only owner", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  await new AccountDeletionService({
    auth: system.auth,
    connectLifecycle: system.connectLifecycle,
    hostedTeams: system.teams,
    store: system.store,
  }).delete(system.creator);
  expect(
    await system.accounts
      .selectFrom("hostedTeams")
      .select(["state", "creatorAccountId"])
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: "deleted", creatorAccountId: null });
  expect(await system.accounts.selectFrom("deployments").select("id").execute()).toEqual([]);
});

/** Someone the directory lists for the team, who is `role` on its own Host when given one. */
async function listedPerson(
  system: Awaited<ReturnType<typeof startHostedTeam>>,
  email: string,
  role?: "owner" | "member",
) {
  const account = await createAccount(system.accounts, email, email.split("@")[0]!);
  await system.accounts
    .insertInto("deploymentDirectoryEntries")
    .values({
      deploymentId: system.team.deployment.id,
      accountId: account,
      generation: 1,
      present: true,
      observedAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  if (!role) return account;
  const providerId = oidcIdentityProviderIdForIssuer("opensteer-account", issuer.origin);
  const userId = `usr_${crypto.randomUUID()}`;
  const handle = email.split("@")[0]!.replace(/[^a-z0-9]/g, "");
  await sql`insert into users(id,display_name,email,email_verified) values(${userId},${email},${email},true)`.execute(
    system.hostDatabase,
  );
  await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${`aac_${crypto.randomUUID()}`},${account},${providerId},${userId})`.execute(
    system.hostDatabase,
  );
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},${handle},${role},'active',now(),now())`.execute(
    system.hostDatabase,
  );
  return account;
}

function deleteAccountOf(system: Awaited<ReturnType<typeof startHostedTeam>>) {
  return new AccountDeletionService({
    auth: system.auth,
    connectLifecycle: system.connectLifecycle,
    hostedTeams: system.teams,
    store: system.store,
  }).delete(system.creator);
}

async function teamAccountState(system: Awaited<ReturnType<typeof startHostedTeam>>) {
  return {
    team: await system.accounts
      .selectFrom("hostedTeams")
      .select(["state", "creatorAccountId"])
      .where("id", "=", system.created.id)
      .executeTakeFirstOrThrow(),
    deployments: await system.accounts
      .selectFrom("deployments")
      .select(["id", "ownerAccountId"])
      .execute(),
    creator: await system.accounts
      .selectFrom("users")
      .select("id")
      .where("id", "=", system.creator)
      .execute(),
  };
}

it("refuses to delete an Account while a team it created can't say who else owns it", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  const sam = await listedPerson(system, "sam@example.test", "owner");
  system.faults.push({ step: "discover", when: "before" });

  await expect(deleteAccountOf(system)).rejects.toMatchObject({
    code: "unavailable",
    reason: "hosted-team-owner-unconfirmed",
    message: expect.stringContaining("acme.teams.opensteer.com"),
  });
  expect(await teamAccountState(system)).toEqual({
    team: { state: "active", creatorAccountId: system.creator },
    deployments: [{ id: system.team.deployment.id, ownerAccountId: system.creator }],
    creator: [{ id: system.creator }],
  });

  // Once the Host answers, the same request hands the team over.
  await deleteAccountOf(system);
  expect((await teamAccountState(system)).team).toEqual({ state: "active", creatorAccountId: sam });
});

it("finds another owner however many people the directory lists before them", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  const listed: ControlPlaneAccountId[] = [];
  for (let index = 0; index < 55; index += 1)
    listed.push(await listedPerson(system, `member${index}@example.test`));
  // The owner sorts after every other listed person.
  const ownerAccount = ControlPlaneAccountIdSchema.parse(
    `acct_${"f".repeat(8)}-ffff-4fff-bfff-${"f".repeat(12)}`,
  );
  await system.accounts
    .insertInto("users")
    .values({
      id: ownerAccount,
      displayName: "Zed",
      email: "zed@example.test",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  await system.accounts
    .insertInto("deploymentDirectoryEntries")
    .values({
      deploymentId: system.team.deployment.id,
      accountId: ownerAccount,
      generation: 1,
      present: true,
      observedAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  const providerId = oidcIdentityProviderIdForIssuer("opensteer-account", issuer.origin);
  const userId = `usr_${crypto.randomUUID()}`;
  await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Zed','zed@example.test',true)`.execute(
    system.hostDatabase,
  );
  await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${`aac_${crypto.randomUUID()}`},${ownerAccount},${providerId},${userId})`.execute(
    system.hostDatabase,
  );
  await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},'zed','owner','active',now(),now())`.execute(
    system.hostDatabase,
  );

  await deleteAccountOf(system);
  expect(await teamAccountState(system)).toEqual({
    team: { state: "active", creatorAccountId: ownerAccount },
    deployments: [{ id: system.team.deployment.id, ownerAccountId: ownerAccount }],
    creator: [],
  });
});

it("hands over a ready team the previous Account release set up, which has no receipt", async () => {
  const system = await startHostedTeam();
  await system.report();
  await system.bootstrapper.runOnce();
  await system.ready();
  // The previous release finished setup without recording a bootstrap receipt.
  await system.accounts
    .updateTable("hostedTeams")
    .set({ bootstrapReceipt: null })
    .where("id", "=", system.created.id)
    .execute();
  const sam = await listedPerson(system, "sam@example.test", "owner");

  await deleteAccountOf(system);
  expect(await teamAccountState(system)).toEqual({
    team: { state: "active", creatorAccountId: sam },
    deployments: [{ id: system.team.deployment.id, ownerAccountId: sam }],
    creator: [],
  });
});
