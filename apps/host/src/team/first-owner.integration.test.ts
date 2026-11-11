import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createId, HostKeyFingerprintSchema } from "@opensteer/core";
import {
  ConsumeHostAccountAdoptionProofResponseSchema,
  ControlPlaneAccountIdSchema,
  HostAccountAdoptionCompletionGrantSchema,
  AdoptExistingDeploymentRequestSchema,
} from "@opensteer/control-plane-protocol";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamMembersStore } from "@opensteer/database/team-members";
import {
  IdentityService,
  TeamIdentityAdmission,
  type VerifiedAccountAdoptionGrant,
} from "@opensteer/identity";
import { createControlPlaneDatabase } from "../../../control-plane/src/database/database.js";
import { ControlPlaneStore } from "../../../control-plane/src/database/store.js";
import { AdoptionOperationCipher } from "../../../control-plane/src/adoption/adoption-operation-crypto.js";
import { sql } from "kysely";

let fixture: Awaited<ReturnType<typeof createTeamFixture>>;
let control: Awaited<ReturnType<typeof cloneTestDatabase>>;
beforeEach(async () => {
  fixture = await createTeamFixture();
  await fixture.database.deleteFrom("teamMembers").execute();
  await fixture.database.deleteFrom("users").execute();
  control = await cloneTestDatabase("controlPlane");
});
afterEach(async () => {
  await control?.drop();
  await fixture?.close();
});

it("uses a setup admission to adopt an empty team, provisions Account OIDC, admits its owner and one invited member", async () => {
  const { database: accountDatabase } = await ownTestDatabaseProducer(control.url, async () => {
    const database = createControlPlaneDatabase({ connectionString: control.url });
    return { database, close: () => database.destroy() };
  });
  const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
  await accountDatabase
    .insertInto("users")
    .values({
      id: accountId,
      displayName: "Maya",
      email: "maya@example.invalid",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  const access = new TeamAccessStore(fixture.database);
  await access.initialize();
  const invites = new TeamInvitesStore(access, "https://team.example.invalid");
  const grants = new Map<string, VerifiedAccountAdoptionGrant>();
  let installed = 0;
  const authority = {
    canonicalOrigin: "https://team.example.invalid",
    deploymentId: fixture.deploymentId,
    hostInstanceId: fixture.hostInstanceId,
    hostKeyFingerprint: HostKeyFingerprintSchema.parse(`sha256:${"A".repeat(43)}`),
  };
  const admission = new TeamIdentityAdmission({
    access,
    invites,
    authority,
    grantVerifier: {
      async verify(grant) {
        const found = typeof grant === "string" ? grants.get(grant) : undefined;
        if (!found) throw new Error("Unverified Account grant");
        return found;
      },
    },
    async installAccountBundle(bundle) {
      expect(bundle.deployment.deploymentId).toBe(fixture.deploymentId);
      expect(bundle.hostCredential).toMatch(/^osc_/);
      installed++;
    },
  });
  const token = randomBytes(32).toString("base64url");
  const options = {
    deployment: { kind: "self-hosted" as const, name: "Acme" },
    exposure: "networked" as const,
    localPasswordEnabled: false,
    oidcProviders: [],
    publicOrigin: new URL(authority.canonicalOrigin),
    secret: "s".repeat(40),
    signupPolicy: "invite-only" as const,
    initialOwnerEnrollment: { token, expiresAt: new Date(Date.now() + 86400000) },
    team: admission,
  };
  const identity = new IdentityService(fixture.database, options);
  await identity.initialize();
  const exchanged = await identity.exchangeInitialOwnerEnrollment(
    token,
    new Headers({ origin: authority.canonicalOrigin }),
  );
  const cookie = exchanged.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const headers = new Headers({ cookie, origin: authority.canonicalOrigin });
  expect(
    (await fixture.database.selectFrom("authAdmissions").selectAll().executeTakeFirstOrThrow())
      .purpose,
  ).toBe("setup");
  const account = { issuer: "https://accounts.example.invalid", subject: accountId };
  const proof = await identity.issueSetupAccountAdoptionProof(headers, account);
  const accountStore = new ControlPlaneStore(accountDatabase, new URL(account.issuer), {
    portalOrigin: new URL("https://portal.example.invalid"),
    adoptionOperationCipher: new AdoptionOperationCipher(Buffer.alloc(32, 1).toString("base64url")),
    adoptionProofVerifier: {
      async verify(input) {
        const receipt = await identity.consumeAccountAdoptionProof({
          expectedAccount: input.account,
          expectedDeployment: input.authority,
          proofCredential: input.proofCredential,
          proofId: input.proofId,
        });
        return ConsumeHostAccountAdoptionProofResponseSchema.parse({
          proofId: receipt.proofId,
          account: receipt.account,
          authorizedBy: receipt.authorizedBy,
          authority: receipt.deployment,
          consumedAt: receipt.consumedAt.toISOString(),
        });
      },
    },
    adoptionCompletionGrantIssuer: {
      async issue(receipt) {
        const grant = HostAccountAdoptionCompletionGrantSchema.parse(
          `${"a".repeat(43)}.${randomBytes(32).toString("base64url")}.${"b".repeat(43)}`,
        );
        grants.set(grant, {
          proofId: receipt.proofId,
          account: receipt.account,
          authorizedBy: receipt.authorizedBy,
          consumedAt: new Date(receipt.consumedAt),
          deployment: receipt.authority,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 300000),
          grantId: `hag_${crypto.randomUUID()}`,
        });
        return grant;
      },
    },
  });
  const adopted = await accountStore.adoptExistingDeployment(
    accountId,
    AdoptExistingDeploymentRequestSchema.parse({
      name: "Acme",
      reachability: "canonical",
      authority,
      proof: { proofId: proof.proofId, proofCredential: proof.proofCredential },
    }),
  );
  await identity.completeTeamAccountAdoption(adopted.completionGrant, adopted.provisioningBundle);
  expect(installed).toBe(1);
  expect(await admission.hasOwner()).toBe(false);
  const provider = await fixture.database
    .selectFrom("accountDirectoryProvider")
    .selectAll()
    .executeTakeFirstOrThrow();
  async function verifiedAccount(name: string, subject: string) {
    const userId = createId("user");
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},${name},${`${name}@example.invalid`},true)`.execute(
      fixture.database,
    );
    await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${createId("authAccount")},${subject},${provider.providerId},${userId})`.execute(
      fixture.database,
    );
    return userId;
  }
  const userId = await verifiedAccount("Maya", accountId);
  const setup = await fixture.database
    .selectFrom("authAdmissions")
    .selectAll()
    .executeTakeFirstOrThrow();
  const results = await Promise.all([
    admission.admit(userId, setup),
    admission.admit(userId, setup),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(
    await fixture.database
      .selectFrom("teamMembers")
      .select(["role", "state"])
      .where("userId", "=", userId)
      .executeTakeFirst(),
  ).toEqual({ role: "owner", state: "active" });
  await expect(identity.exchangeInitialOwnerEnrollment(token)).rejects.toThrow();
  const invite = await invites.create({ kind: "human", userId }, createId("teamInvite"));
  const url = new URL(invite.url);
  const selector = url.pathname.split("/").pop()!;
  const invitation = await identity.exchangeTeamInvitation(
    selector,
    url.hash.slice(1),
    new Headers({ origin: authority.canonicalOrigin }),
  );
  expect(invitation.headers.getSetCookie().length).toBeGreaterThan(0);
  const invitedId = await verifiedAccount("Sam", `acct_${crypto.randomUUID()}`);
  const inviteAdmission = await fixture.database
    .selectFrom("authAdmissions")
    .selectAll()
    .where("purpose", "=", "invitation")
    .executeTakeFirstOrThrow();
  const generation = await admission.admit(invitedId, inviteAdmission);
  expect(await admission.sessionActive(invitedId, generation)).toBe(true);
  expect(
    (
      await fixture.database
        .selectFrom("teamMembers")
        .select("role")
        .where("userId", "=", invitedId)
        .executeTakeFirstOrThrow()
    ).role,
  ).toBe("member");
  expect(
    await fixture.database
      .selectFrom("accountDirectoryProjections")
      .select("present")
      .where("userId", "=", invitedId)
      .executeTakeFirst(),
  ).toEqual({ present: true });
  await new TeamMembersStore(access).change({ kind: "human", userId }, invitedId, "remove");
  expect(await admission.sessionActive(invitedId, generation)).toBe(false);
  expect(
    await fixture.database
      .selectFrom("accountDirectoryProjections")
      .select("present")
      .where("userId", "=", invitedId)
      .executeTakeFirst(),
  ).toEqual({ present: false });
  for (const row of await fixture.database
    .selectFrom("authAccounts")
    .select(["accessToken", "refreshToken", "idToken", "password"])
    .execute())
    expect(row).toEqual({ accessToken: null, refreshToken: null, idToken: null, password: null });
});

it("expires a setup capability across restart and rotates unfinished setup without reopening a claimed team", async () => {
  const access = new TeamAccessStore(fixture.database);
  await access.initialize();
  const invites = new TeamInvitesStore(access, "https://team.example.invalid");
  const authority = {
    canonicalOrigin: "https://team.example.invalid",
    deploymentId: fixture.deploymentId,
    hostInstanceId: fixture.hostInstanceId,
    hostKeyFingerprint: HostKeyFingerprintSchema.parse(`sha256:${"A".repeat(43)}`),
  };
  const team = new TeamIdentityAdmission({
    access,
    invites,
    authority,
    grantVerifier: {
      async verify() {
        throw new Error("No grant");
      },
    },
    async installAccountBundle() {
      throw new Error("No bundle");
    },
  });
  const token = randomBytes(32).toString("base64url");
  const common = {
    team,
    deployment: { kind: "self-hosted" as const, name: "Acme" },
    exposure: "networked" as const,
    localPasswordEnabled: false,
    oidcProviders: [],
    publicOrigin: new URL(authority.canonicalOrigin),
    secret: "s".repeat(40),
    signupPolicy: "invite-only" as const,
  };
  const identity = new IdentityService(fixture.database, {
    ...common,
    initialOwnerEnrollment: { token, expiresAt: new Date(Date.now() + 86400000) },
  });
  await identity.initialize();
  await identity.exchangeInitialOwnerEnrollment(token);
  await fixture.database
    .updateTable("ownerEnrollments")
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .execute();
  await expect(
    new IdentityService(fixture.database, {
      ...common,
      initialOwnerEnrollment: { token, expiresAt: new Date(Date.now() + 86400000) },
    }).exchangeInitialOwnerEnrollment(token),
  ).rejects.toThrow();
  const next = randomBytes(32).toString("base64url");
  const rotated = new IdentityService(fixture.database, {
    ...common,
    initialOwnerEnrollment: { token: next, expiresAt: new Date(Date.now() + 86400000) },
  });
  await rotated.initialize();
  await expect(rotated.exchangeInitialOwnerEnrollment(next)).resolves.toMatchObject({
    data: { admitted: true },
  });
  await expect(identity.exchangeInitialOwnerEnrollment(token)).rejects.toThrow();
});
