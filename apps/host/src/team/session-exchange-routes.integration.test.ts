import { randomUUID } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
  type TeamIdentityAssertionClaims,
} from "@opensteer/control-plane-protocol";
import {
  HostKeyFingerprintSchema,
  createId,
  opensteerHostNativeOAuthClients,
  type NativeOAuthClient,
  type TeamInviteSecret,
} from "@opensteer/core";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamMembersStore } from "@opensteer/database/team-members";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import { IdentityService, TeamIdentityAdmission } from "@opensteer/identity";
import {
  TeamEntryRefusalReasonSchema,
  TeamSessionExchangeResponseSchema,
  teamSessionExchangePath,
} from "@opensteer/protocol";
import Fastify from "fastify";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RemoteTeamIdentityAssertionVerifier } from "../access/team-identity-assertion-verifier.js";
import { installHostHttpBoundary } from "../server/host-http-boundary.js";
import { registerTeamSessionExchangeRoute } from "./session-exchange-routes.js";

// Skipped outside the PostgreSQL launcher, which provides the database URL.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const teamOrigin = "https://team.example.invalid";
const issuer = "https://account.opensteer.example";
const providerId = "oidc.opensteer-account.fixture";
const hostKeyFingerprint = HostKeyFingerprintSchema.parse(`sha256:${"A".repeat(43)}`);

integration("team session exchange", () => {
  let accountKey: CryptoKey;
  let jwks: { keys: object[] };
  const hosts: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    accountKey = pair.privateKey;
    jwks = {
      keys: [{ ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "account-v1", use: "sig" }],
    };
  });
  afterEach(async () => {
    for (const close of hosts.splice(0)) await close();
  });

  it("enters an active member with tokens for the application the assertion names", async () => {
    const host = await teamHost();
    const desktop = await host.exchange(await host.assertion(host.owner));
    expect(desktop).toMatchObject({ status: 200, body: { admitted: false } });
    const entered = TeamSessionExchangeResponseSchema.parse(desktop.body);
    expect(entered.member).toMatchObject({ role: "owner", state: "active" });
    await expect(
      host.identity.authenticateNativeAccessToken(entered.tokens.access_token),
    ).resolves.toMatchObject({ application: "desktop" });

    const mobile = TeamSessionExchangeResponseSchema.parse(
      (await host.exchange(await host.assertion(host.owner, { surface: "mobile" }))).body,
    );
    await expect(
      host.identity.authenticateNativeAccessToken(mobile.tokens.access_token),
    ).resolves.toMatchObject({ application: "mobile" });
  });

  it("refuses a replayed, expired, misaddressed or foreign assertion", async () => {
    const host = await teamHost();
    const once = await host.assertion(host.owner);
    const [first, replay] = await Promise.all([host.exchange(once), host.exchange(once)]);
    expect([first.status, replay.status].sort()).toEqual([200, 401]);
    expect(await host.exchange(once)).toMatchObject(refused("assertion-invalid"));

    const now = Math.floor(Date.now() / 1_000);
    const foreignKey = (await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey;
    expect(
      await host.exchange(await host.assertion(host.owner, { iat: now - 120, exp: now - 60 })),
    ).toMatchObject(refused("assertion-expired"));
    for (const assertion of [
      await host.assertion(host.owner, {
        aud: "https://other.example.invalid",
        authority: { ...host.authority, canonicalOrigin: "https://other.example.invalid" },
      }),
      await host.assertion(host.owner, {}, foreignKey),
    ])
      expect(await host.exchange(assertion)).toMatchObject(refused("assertion-invalid"));
    for (const assertion of [
      await host.assertion(host.owner, {
        authority: { ...host.authority, hostInstanceId: createId("hostInstance") },
      }),
      await host.assertion(host.owner, {
        authority: { ...host.authority, deploymentId: createId("deployment") },
      }),
    ])
      expect(await host.exchange(assertion)).toMatchObject({
        status: 403,
        body: { error: { reason: "authority-changed" } },
      });
  });

  it("refuses an application this team Host does not serve", async () => {
    const host = await teamHost(
      opensteerHostNativeOAuthClients.filter(({ application }) => application === "desktop"),
    );
    expect(
      await host.exchange(await host.assertion(host.owner, { surface: "mobile" })),
    ).toMatchObject(refused("assertion-invalid"));
    expect(await host.exchange(await host.assertion(host.owner))).toMatchObject({ status: 200 });
  });

  it("admits a newcomer only through a valid invite", async () => {
    const host = await teamHost();
    const person = account();
    expect(await host.exchange(await host.assertion(person))).toMatchObject(
      refused("not-a-member"),
    );
    expect(await host.users(person)).toBe(0);

    const expired = await host.invite(new Date(Date.now() - 1_000));
    const revoked = await host.invite();
    await host.invites.revoke(host.ownerActor, revoked.id);
    const usedUp = await host.invite();
    const other = account();
    expect(await host.exchange(await host.assertion(other), usedUp.secret)).toMatchObject({
      status: 200,
      body: { admitted: true },
    });
    for (const [secret, reason] of [
      [expired.secret, "invite-expired"],
      [revoked.secret, "invite-invalid"],
      [usedUp.secret, "invite-used-up"],
      [{ ...usedUp.secret, verifier: "x".repeat(43) }, "invite-invalid"],
    ] as const)
      expect(await host.exchange(await host.assertion(person), secret)).toMatchObject(
        refused(reason),
      );
    expect(await host.users(person)).toBe(0);

    const invite = await host.invite();
    const joined = await host.exchange(await host.assertion(person), invite.secret);
    expect(joined).toMatchObject({
      status: 200,
      body: { admitted: true, member: { role: "member", state: "active" } },
    });
    expect(await host.published(person)).toBe(true);
    expect(await host.exchange(await host.assertion(person))).toMatchObject({
      status: 200,
      body: { admitted: false },
    });
  });

  it("re-admits a removed member only with an invite made after the removal", async () => {
    const host = await teamHost();
    const person = account();
    const before = await host.invite();
    const joined = TeamSessionExchangeResponseSchema.parse(
      (await host.exchange(await host.assertion(person), (await host.invite()).secret)).body,
    );
    await host.members.change(host.ownerActor, joined.member.userId, "remove");
    await expect(
      host.identity.authenticateNativeAccessToken(joined.tokens.access_token),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await host.exchange(await host.assertion(person))).toMatchObject(
      refused("not-a-member"),
    );
    expect(await host.exchange(await host.assertion(person), before.secret)).toMatchObject(
      refused("invite-invalid"),
    );
    const after = await host.invite();
    expect(await host.exchange(await host.assertion(person), after.secret)).toMatchObject({
      status: 200,
      body: { admitted: true, member: { role: "member", state: "active" } },
    });
  });

  it("refuses a disabled member", async () => {
    const host = await teamHost();
    await host.database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", host.ownerActor.userId)
      .execute();
    expect(await host.exchange(await host.assertion(host.owner))).toMatchObject(
      refused("not-a-member"),
    );
  });

  it("admits a person once when their exchanges race on one single-use invite", async () => {
    const host = await teamHost();
    const person = account();
    const invite = await host.invite();
    const results = await Promise.all(
      [0, 1, 2].map(async () => host.exchange(await host.assertion(person), invite.secret)),
    );
    expect(results.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(results.filter(({ body }) => (body as { admitted?: boolean }).admitted)).toHaveLength(1);
    expect(await host.users(person)).toBe(1);
    const row = await host.database
      .selectFrom("teamInvites")
      .select("usedCount")
      .where("id", "=", invite.id)
      .executeTakeFirstOrThrow();
    expect(row.usedCount).toBe(1);
  });

  async function teamHost(clients: readonly NativeOAuthClient[] = opensteerHostNativeOAuthClients) {
    const fixture = await createTeamFixture();
    const database = fixture.database;
    const access = new TeamAccessStore(database);
    await access.initialize();
    const invites = new TeamInvitesStore(access, teamOrigin);
    const members = new TeamMembersStore(access);
    const authority = {
      canonicalOrigin: teamOrigin,
      deploymentId: fixture.deploymentId,
      hostInstanceId: fixture.hostInstanceId,
      hostKeyFingerprint,
    };
    const identity = new IdentityService(database, {
      team: new TeamIdentityAdmission({
        access,
        invites,
        authority,
        grantVerifier: {
          async verify() {
            throw new Error("No adoption grant in this fixture");
          },
        },
        identityVerifier: new RemoteTeamIdentityAssertionVerifier({
          audience: teamOrigin,
          issuer: new URL(issuer),
          fetch: async () =>
            Response.json(jwks, { headers: { "content-type": "application/json" } }),
        }),
        async installAccountBundle() {
          throw new Error("No bundle in this fixture");
        },
      }),
      deployment: { kind: "team", name: "Acme" },
      hostKeyFingerprint,
      publicOrigin: new URL(teamOrigin),
      secret: "team-session-exchange-test-secret-0123456789",
      exposure: "networked",
      localPasswordEnabled: false,
      signupPolicy: "invite-only",
      oidcProviders: [],
      nativeOAuth: { clients },
    });
    await identity.initialize();
    const owner = account();
    await database
      .insertInto("accountDirectoryProvider")
      .values({ singletonKey: "opensteer-account", providerId, issuer })
      .execute();
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        accountId: owner,
        providerId,
        userId: fixture.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const app = Fastify();
    installHostHttpBoundary(app);
    registerTeamSessionExchangeRoute(app, { identity, members });
    await app.ready();
    hosts.push(async () => {
      await app.close();
      await database.destroy();
      await fixture.close();
    });
    const ownerActor = { kind: "human" as const, userId: fixture.userId };
    return {
      authority,
      database,
      identity,
      invites,
      members,
      owner,
      ownerActor,
      async assertion(
        subject: ControlPlaneAccountId,
        overrides: Partial<TeamIdentityAssertionClaims> = {},
        key: CryptoKey = accountKey,
      ) {
        const iat = Math.floor(Date.now() / 1_000);
        return new SignJWT({
          tokenUse: "opensteer-team-identity",
          iss: issuer,
          aud: teamOrigin,
          sub: subject,
          iat,
          exp: iat + 60,
          jti: `tig_${randomUUID()}`,
          account: { issuer, subject },
          email: `${subject}@example.test`,
          displayName: "Invited Person",
          authority,
          surface: "desktop",
          ...overrides,
        })
          .setProtectedHeader({ alg: "EdDSA", kid: "account-v1" })
          .sign(key);
      },
      async exchange(assertion: string, invite?: TeamInviteSecret) {
        const response = await app.inject({
          method: "POST",
          url: teamSessionExchangePath,
          payload: { assertion, ...(invite ? { invite } : {}) },
        });
        return { status: response.statusCode, body: response.json() as unknown };
      },
      async invite(expiresAt?: Date) {
        const created = await invites.create(ownerActor, createId("teamInvite"));
        if (expiresAt)
          await database
            .updateTable("teamInvites")
            .set({ expiresAt })
            .where("id", "=", created.invite.id)
            .execute();
        const url = new URL(created.url);
        return {
          id: created.invite.id,
          secret: { selector: url.pathname.split("/").pop()!, verifier: url.hash.slice(1) },
        };
      },
      async users(subject: ControlPlaneAccountId) {
        return (
          await database
            .selectFrom("authAccounts")
            .select("userId")
            .where("accountId", "=", subject)
            .execute()
        ).length;
      },
      async published(subject: ControlPlaneAccountId) {
        const row = await database
          .selectFrom("accountDirectoryProjections")
          .select("present")
          .where("accountId", "=", subject)
          .executeTakeFirst();
        return row?.present ?? false;
      },
    };
  }
});

function account(): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
}

function refused(reason: string) {
  return {
    status: reason === "assertion-invalid" || reason === "assertion-expired" ? 401 : 403,
    body: { error: { reason: TeamEntryRefusalReasonSchema.parse(reason) } },
  };
}
