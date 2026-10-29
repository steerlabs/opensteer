import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  AccountLinkGenerationSchema,
  AdoptExistingDeploymentRequestSchema,
  ConsumeHostAccountAdoptionProofResponseSchema,
  ControlPlaneAccountIdSchema,
  HostAccountAdoptionProofCredentialSchema,
  HostAccountAdoptionProofIdSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  PersonalHostAccountLinkOperationIdSchema,
  type PersonalHostAccountLinkOperationId,
  personalHostAccessRouteSigningBytes,
  personalHostAccountLinkProofSigningBytes,
  type ControlPlaneAccountId,
  type IssuePersonalHostAccountLinkChallengeResponse,
  maximumAccountDeployments,
} from "@opensteer/control-plane-protocol";
import { createId, HostKeyFingerprintSchema, type DeploymentId } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneAuth } from "../auth/auth.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { hashCredential } from "../auth/credentials.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { PersonalAccountLinkOperationCipher } from "./personal-account-link-operation-crypto.js";
import { PersonalRemoteAccountService } from "./personal-remote-account.js";
import { ControlPlaneStore } from "../database/store.js";
import { AdoptionOperationCipher } from "../adoption/adoption-operation-crypto.js";
import { BetterAuthAccountAdoptionCompletionGrantIssuer } from "../adoption/adoption-grant-issuer.js";
import {
  recordedLockOrderEdges,
  withLockOrderMode,
} from "@opensteer/database/test-support/lock-order";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const issuer = new URL("https://account.personal.test.invalid");

integration("Personal remote Account PostgreSQL boundary", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const signedClaims: unknown[] = [];
  const fakeAuth = {
    api: {
      signJWT: async ({ body }: { body: { payload: unknown } }) => {
        signedClaims.push(body.payload);
        return { token: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}` };
      },
    },
  } as unknown as ControlPlaneAuth;
  const service = new PersonalRemoteAccountService({
    auth: fakeAuth,
    database,
    issuer,
    operationCipher: new PersonalAccountLinkOperationCipher(
      Buffer.alloc(32, 11).toString("base64url"),
    ),
  });
  const ownerA = accountId();
  const ownerB = accountId();
  /** A store wired for the real Host-adoption entry point. */
  const adoptionStore = (target: typeof database) =>
    new ControlPlaneStore(target, issuer, {
      adoptionCompletionGrantIssuer: new BetterAuthAccountAdoptionCompletionGrantIssuer(
        fakeAuth,
        issuer,
      ),
      adoptionOperationCipher: new AdoptionOperationCipher("A".repeat(43)),
      adoptionProofVerifier: {
        verify: async (input) =>
          ConsumeHostAccountAdoptionProofResponseSchema.parse({
            account: input.account,
            authorizedBy: {
              sessionId: createId("authSession"),
              userId: createId("user"),
            },
            authority: input.authority,
            consumedAt: new Date().toISOString(),
            proofId: input.proofId,
          }),
      },
      managedDeploymentDomain: "connect.personal.test.invalid",
    });

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  beforeEach(async () => {
    signedClaims.length = 0;
    await sql`truncate table deployments, personal_host_account_link_challenges, users cascade`.execute(
      database,
    );
    const now = new Date();
    await database
      .insertInto("users")
      .values([account(ownerA, now), account(ownerB, now)])
      .execute();
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("links an existing loopback Personal Host exactly once without OIDC", async () => {
    await withLockOrderMode("enforce", async () => {
      const host = hostAuthority();
      const challenge = await issueChallenge(service, ownerA, host);
      const request = signedLinkRequest(challenge, host.privateKey);
      const acquisitionsStart = recordedLockOrderEdges.length;
      const [first, replay] = await Promise.all([
        service.completeLink(ownerA, request),
        service.completeLink(ownerA, request),
      ]);
      expect(replay.hostCredential).toBe(first.hostCredential);
      // Completion fences the User before its Challenge, never the reverse; the
      // forward edge also proves the checker observed this completion at all.
      const edges = recordedLockOrderEdges.slice(acquisitionsStart);
      const between = (from: string, to: string) =>
        edges.filter(
          (edge) =>
            new RegExp(`(?:^|:)${from}$`, "u").test(edge.from) &&
            new RegExp(`(?:^|:)${to}$`, "u").test(edge.to),
        );
      expect(between("users", "personal_host_account_link_challenges")).not.toEqual([]);
      expect(between("personal_host_account_link_challenges", "users")).toEqual([]);
      // Completion names no Deployment: none exists until the Host activates.
      expect(first).not.toHaveProperty("schemaVersion");
      expect(first).not.toHaveProperty("reservation");

      const deployment = await database
        .selectFrom("deployments")
        .select(["canonicalOrigin", "lifecycle", "oidcClientId", "ownerAccountId"])
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst();
      expect(deployment).toBeUndefined();
      const directory = new ControlPlaneStore(database, issuer, {
        managedDeploymentDomain: "connect.personal.test.invalid",
      });
      await expect(directory.listDeployments(ownerA)).resolves.toEqual([]);
      await expect(
        directory.authenticateHostCredential(`Bearer ${first.hostCredential}`),
      ).rejects.toMatchObject({ code: "unauthorized" });
      const activation = {
        challengeId: challenge.challengeId,
        linkGeneration: first.linkGeneration,
      };
      await expect(
        service.activateLink(`Bearer ${first.hostCredential}`, activation),
      ).resolves.toMatchObject({
        activated: true,
        deploymentId: host.authority.deploymentId,
      });
      await expect(
        service.activateLink(`Bearer ${first.hostCredential}`, activation),
      ).resolves.toMatchObject({ activated: true });
      await expect(directory.listDeployments(ownerA)).resolves.toMatchObject([
        { access: "owner", id: host.authority.deploymentId, lifecycle: "active" },
      ]);
      await expect(service.completeLink(ownerA, request)).rejects.toMatchObject({
        code: "conflict",
      });
    });
  });

  it("atomically rejects a cross-Account race for the same Host aliases", async () => {
    const host = hostAuthority();
    const results = await Promise.allSettled([
      issueChallenge(service, ownerA, host),
      issueChallenge(service, ownerB, host),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: { code: "conflict" } });
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("challengeId")
        .where("state", "=", "pending")
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it("replays the exact challenge after an issue response is lost", async () => {
    const host = hostAuthority();
    const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    const first = await issueChallenge(service, ownerA, host, operationId);
    const replay = await issueChallenge(service, ownerA, host, operationId);
    expect(replay).toEqual(first);
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("challengeId")
        .where("ownerAccountId", "=", ownerA)
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it("cancels pending and reserved Account operations without a timeout dead zone", async () => {
    const host = hostAuthority();
    const pendingOperationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    await issueChallenge(service, ownerA, host, pendingOperationId);
    await expect(
      service.cancelLinkOperation(ownerA, { operationId: pendingOperationId }),
    ).resolves.toMatchObject({ cancelled: true, operationId: pendingOperationId });
    await expect(
      service.cancelLinkOperation(ownerA, { operationId: pendingOperationId }),
    ).resolves.toMatchObject({ cancelled: true });

    const reservedOperationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    const challenge = await issueChallenge(service, ownerA, host, reservedOperationId);
    await service.completeLink(ownerA, signedLinkRequest(challenge, host.privateKey));
    await service.cancelLinkOperation(ownerA, {
      operationId: reservedOperationId,
    });

    await expect(issueChallenge(service, ownerB, host)).resolves.toBeDefined();
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("reports a cancel of an operation this Account never had as not found", async () => {
    const host = hostAuthority();
    await issueChallenge(service, ownerA, host);
    const strangerOperationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    await expect(
      service.cancelLinkOperation(ownerA, { operationId: strangerOperationId }),
    ).rejects.toMatchObject({ code: "not_found", reason: "personal-account-link-not-found" });
  });

  it("refuses to cancel an activated link from the Account side", async () => {
    const host = hostAuthority();
    const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    const challenge = await issueChallenge(service, ownerA, host, operationId);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    await service.activateLink(`Bearer ${completion.hostCredential}`, {
      challengeId: challenge.challengeId,
      linkGeneration: completion.linkGeneration,
    });
    await expect(service.cancelLinkOperation(ownerA, { operationId })).rejects.toMatchObject({
      code: "conflict",
      reason: "personal-account-link-already-active",
    });
  });

  it("supersedes this Account's own live operation when its client lost the journal", async () => {
    const host = hostAuthority();
    const lost = await issueChallenge(service, ownerA, host);
    const reissued = await issueChallenge(service, ownerA, host);
    expect(reissued.challengeId).not.toBe(lost.challengeId);
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("state")
        .where("challengeId", "=", lost.challengeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ state: "cancelled" });
    // The superseded challenge released its Deployment slot with its identity.
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("challengeId")
        .where("ownerAccountId", "=", ownerA)
        .where("state", "in", ["pending", "reserved"])
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      service.completeLink(ownerA, signedLinkRequest(reissued, host.privateKey)),
    ).resolves.not.toHaveProperty("schemaVersion");
  });

  it("supersedes a reserved operation and retires the Host credential it issued", async () => {
    const host = hostAuthority();
    const lost = await issueChallenge(service, ownerA, host);
    const stale = await service.completeLink(ownerA, signedLinkRequest(lost, host.privateKey));

    const reissued = await issueChallenge(service, ownerA, host);
    const fresh = await service.completeLink(ownerA, signedLinkRequest(reissued, host.privateKey));
    expect(fresh.hostCredential).not.toBe(stale.hostCredential);
    await expect(
      service.activateLink(`Bearer ${stale.hostCredential}`, {
        challengeId: lost.challengeId,
        linkGeneration: stale.linkGeneration,
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "personal-account-link-cancelled" });
    await expect(
      service.activateLink(`Bearer ${fresh.hostCredential}`, {
        challengeId: reissued.challengeId,
        linkGeneration: fresh.linkGeneration,
      }),
    ).resolves.toMatchObject({ activated: true, deploymentId: host.authority.deploymentId });
  });

  it("never supersedes another Account's live operation for the same Host", async () => {
    const host = hostAuthority();
    await issueChallenge(service, ownerA, host);
    await expect(issueChallenge(service, ownerB, host)).rejects.toMatchObject({
      code: "conflict",
      reason: "personal-host-already-linked",
    });
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("ownerAccountId")
        .where("state", "=", "pending")
        .execute(),
    ).resolves.toEqual([{ ownerAccountId: ownerA }]);
  });

  it("serializes a Personal reservation against Host adoption at the last slot", async () => {
    await fillOwnedQuota(database, ownerA, maximumAccountDeployments - 1);
    const results = await Promise.allSettled([
      issueChallenge(service, ownerA, hostAuthority()),
      adoptionStore(database).adoptExistingDeployment(ownerA, adoptionRequest()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "conflict", reason: "account-deployment-quota-exceeded" } },
    ]);
  });

  it("serializes a Personal reservation against a shared directory membership", async () => {
    await fillOwnedQuota(database, ownerA, maximumAccountDeployments - 1);
    const sharedHost = await linkedPersonalHost(service, ownerB);
    const directory = new ControlPlaneStore(database, issuer, {
      managedDeploymentDomain: "connect.personal.test.invalid",
    });
    const authority = await directory.authenticateHostCredential(
      `Bearer ${sharedHost.hostCredential}`,
    );
    const results = await Promise.allSettled([
      issueChallenge(service, ownerA, hostAuthority()),
      directory.projectDirectoryEntry(authority, ownerA, {
        generation: 1,
        hostInstanceId: sharedHost.host.authority.hostInstanceId,
        observedAt: new Date().toISOString(),
        present: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "conflict", reason: "account-deployment-quota-exceeded" } },
    ]);
  });

  it("activates a reservation at the quota because the reservation already holds the slot", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    await fillOwnedQuota(database, ownerA, maximumAccountDeployments - 1);
    await expect(
      service.activateLink(`Bearer ${completion.hostCredential}`, {
        challengeId: challenge.challengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).resolves.toMatchObject({ activated: true });
  });

  it("refuses Host adoption of an identity a live Personal reservation already holds", async () => {
    const host = hostAuthority();
    await issueChallenge(service, ownerA, host);
    const request = adoptionRequest({
      authority: {
        canonicalOrigin: "https://adopted-self-host.test.invalid",
        deploymentId: host.authority.deploymentId,
        hostInstanceId: host.authority.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(host.spki),
      },
    });
    await expect(
      adoptionStore(database).adoptExistingDeployment(ownerB, request),
    ).rejects.toMatchObject({ code: "conflict", reason: "personal-host-already-linked" });
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("refuses a Host unlink while its Connect resource is still live", async () => {
    const host = hostAuthority();
    const linked = await linkedPersonalHost(service, ownerA, host);
    await database
      .insertInto("deploymentConnectResources")
      .values(connectResource(host.authority.deploymentId, new Date()))
      .executeTakeFirstOrThrow();
    const unlink = {
      challengeId: linked.challengeId,
      linkGeneration: linked.linkGeneration,
    };
    await expect(
      service.unlinkPersonalHost(`Bearer ${linked.hostCredential}`, unlink),
    ).rejects.toMatchObject({ code: "conflict", reason: "connect-resource-active" });
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toMatchObject({ id: host.authority.deploymentId });

    await database
      .updateTable("deploymentConnectResources")
      .set({ dnsRecordId: null, state: "revoked", tunnelId: null, updatedAt: new Date() })
      .where("deploymentId", "=", host.authority.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.unlinkPersonalHost(`Bearer ${linked.hostCredential}`, unlink),
    ).resolves.toMatchObject({ unlinked: true });
  });

  it("holds an unlink decision until an in-flight Connect session settles", async () => {
    const host = hostAuthority();
    const linked = await linkedPersonalHost(service, ownerA, host);
    const lockIdentity = `opensteer-connect:${host.authority.deploymentId}`;
    await database.connection().execute(async (provisioner) => {
      // Exactly what ConnectLifecycleService holds across its provider call.
      await sql`select pg_advisory_lock(hashtextextended(${lockIdentity}, 0))`.execute(provisioner);
      let settled = false;
      const unlink = service
        .unlinkPersonalHost(`Bearer ${linked.hostCredential}`, {
          challengeId: linked.challengeId,
          linkGeneration: linked.linkGeneration,
        })
        .finally(() => {
          settled = true;
        });
      unlink.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Without the shared lock this would already have deleted the Deployment
      // while the tunnel was still being created.
      expect(settled).toBe(false);
      const now = new Date();
      await provisioner
        .insertInto("deploymentConnectResources")
        .values(connectResource(host.authority.deploymentId, now))
        .executeTakeFirstOrThrow();
      await sql`select pg_advisory_unlock(hashtextextended(${lockIdentity}, 0))`.execute(
        provisioner,
      );
      await expect(unlink).rejects.toMatchObject({
        code: "conflict",
        reason: "connect-resource-active",
      });
    });
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toMatchObject({ id: host.authority.deploymentId });
  });

  it("tombstones a Host unlink of an active link as unlinked, not cancelled", async () => {
    const host = hostAuthority();
    const linked = await linkedPersonalHost(service, ownerA, host);
    const unlink = {
      challengeId: linked.challengeId,
      linkGeneration: linked.linkGeneration,
    };
    await expect(
      service.unlinkPersonalHost(`Bearer ${linked.hostCredential}`, unlink),
    ).resolves.toMatchObject({ unlinked: true });
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("state")
        .where("challengeId", "=", linked.challengeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ state: "unlinked" });
    // A replayed unlink is the same terminal fact, not a downgrade to cancelled.
    await expect(
      service.unlinkPersonalHost(`Bearer ${linked.hostCredential}`, unlink),
    ).resolves.toMatchObject({ unlinked: true });
    await expect(
      database
        .selectFrom("personalHostAccountLinkChallenges")
        .select("state")
        .where("challengeId", "=", linked.challengeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ state: "unlinked" });
  });

  it("answers an unknown challenge or credential with one not-found shape", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    const strangerChallengeId = PersonalHostAccountLinkChallengeIdSchema.parse(
      `phc_${crypto.randomUUID()}`,
    );
    const strangerCredential = `Bearer osc_${"z".repeat(43)}`;
    const notFound = { code: "not_found", reason: "personal-account-link-not-found" };
    await expect(
      service.activateLink(`Bearer ${completion.hostCredential}`, {
        challengeId: strangerChallengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      service.activateLink(strangerCredential, {
        challengeId: challenge.challengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      service.unlinkPersonalHost(strangerCredential, {
        challengeId: challenge.challengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      service.unlinkPersonalHost(`Bearer ${completion.hostCredential}`, {
        challengeId: strangerChallengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).rejects.toMatchObject(notFound);
  });

  it("cancels an unactivated reservation without leaving a Deployment tombstone", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    await expect(
      service.unlinkPersonalHost(`Bearer ${completion.hostCredential}`, {
        challengeId: challenge.challengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).resolves.toMatchObject({ unlinked: true });
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(issueChallenge(service, ownerB, host)).resolves.not.toHaveProperty(
      "schemaVersion",
    );
  });

  it("deletes an Account after its active Personal Host is unlinked", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    await service.activateLink(`Bearer ${completion.hostCredential}`, {
      challengeId: challenge.challengeId,
      linkGeneration: completion.linkGeneration,
    });
    await service.unlinkPersonalHost(`Bearer ${completion.hostCredential}`, {
      challengeId: challenge.challengeId,
      linkGeneration: completion.linkGeneration,
    });
    const directory = new ControlPlaneStore(database, issuer, {
      managedDeploymentDomain: "connect.personal.test.invalid",
    });
    await expect(directory.deleteAccount(ownerA)).resolves.toBeUndefined();
    await expect(
      database.selectFrom("users").select("id").where("id", "=", ownerA).executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("allows the same Personal Host to link to another Account only after Host-authorized unlink", async () => {
    const host = hostAuthority();
    const firstChallenge = await issueChallenge(service, ownerA, host);
    const first = await service.completeLink(
      ownerA,
      signedLinkRequest(firstChallenge, host.privateKey),
    );
    const directory = new ControlPlaneStore(database, issuer, {
      managedDeploymentDomain: "connect.personal.test.invalid",
    });
    const firstActivation = {
      challengeId: firstChallenge.challengeId,
      linkGeneration: first.linkGeneration,
    };
    await service.activateLink(`Bearer ${first.hostCredential}`, firstActivation);
    await service.unlinkPersonalHost(`Bearer ${first.hostCredential}`, {
      challengeId: firstChallenge.challengeId,
      linkGeneration: first.linkGeneration,
    });

    const secondChallenge = await issueChallenge(service, ownerB, host);
    const second = await service.completeLink(
      ownerB,
      signedLinkRequest(secondChallenge, host.privateKey),
    );
    expect(second.linkGeneration).not.toBe(first.linkGeneration);
    await expect(directory.listDeployments(ownerA)).resolves.toEqual([]);
    await expect(directory.listDeployments(ownerB)).resolves.toEqual([]);
    const secondActivation = {
      challengeId: secondChallenge.challengeId,
      linkGeneration: second.linkGeneration,
    };
    await service.activateLink(`Bearer ${second.hostCredential}`, secondActivation);
    await expect(directory.listDeployments(ownerB)).resolves.toMatchObject([
      { access: "owner", id: host.authority.deploymentId, lifecycle: "active" },
    ]);
  });

  it("issues a short grant only for the exact current signed Connect route", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    const activation = {
      challengeId: challenge.challengeId,
      linkGeneration: completion.linkGeneration,
    };
    await service.activateLink(`Bearer ${completion.hostCredential}`, activation);
    const route = signedRoute(host, 9);
    const now = new Date();
    await database
      .updateTable("deploymentConnect")
      .set({
        accessRoute: route,
        generation: 9,
        observedAt: now,
        origin: route.document.route.origin,
        state: "offline",
        updatedAt: now,
      })
      .where("deploymentId", "=", host.authority.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.issueSessionGrant(ownerA, host.authority.deploymentId, {
        clientSurface: "desktop",
        expectedAuthority: host.authority,
        expectedRoute: route,
        targetKind: "personal-connect",
      }),
    ).resolves.not.toHaveProperty("schemaVersion");
    expect(signedClaims.at(-1)).toMatchObject({
      authority: host.authority,
      route: { route: { generation: 9, kind: "connect" } },
      sub: ownerA,
      targetKind: "personal-connect",
      tokenUse: "opensteer-account-host-session",
    });

    // A phone is a separate application, and the surface it is signed for is
    // what a Host derives its credential delivery from.
    await expect(
      service.issueSessionGrant(ownerA, host.authority.deploymentId, {
        clientSurface: "native",
        expectedAuthority: host.authority,
        expectedRoute: route,
        targetKind: "personal-connect",
      }),
    ).resolves.not.toHaveProperty("schemaVersion");
    expect(signedClaims.at(-1)).toMatchObject({ clientSurface: "native" });
    expect(signedClaims.at(-1)).not.toHaveProperty("portalOrigin");

    const stale = signedRoute(host, 8);
    await expect(
      service.issueSessionGrant(ownerA, host.authority.deploymentId, {
        clientSurface: "desktop",
        expectedAuthority: host.authority,
        expectedRoute: stale,
        targetKind: "personal-connect",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await database
      .updateTable("deploymentConnect")
      .set({ accessRoute: null, generation: 10, observedAt: now, origin: null, state: "revoked" })
      .where("deploymentId", "=", host.authority.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.issueSessionGrant(ownerA, host.authority.deploymentId, {
        clientSurface: "desktop",
        expectedAuthority: host.authority,
        expectedRoute: route,
        targetKind: "personal-connect",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await database
      .updateTable("deploymentConnect")
      .set({
        accessRoute: route,
        generation: 9,
        observedAt: now,
        origin: route.document.route.origin,
        state: "offline",
      })
      .where("deploymentId", "=", host.authority.deploymentId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("deployments")
      .set({ activeHostInstanceId: createId("hostInstance") })
      .where("id", "=", host.authority.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.issueSessionGrant(ownerA, host.authority.deploymentId, {
        clientSurface: "desktop",
        expectedAuthority: host.authority,
        expectedRoute: route,
        targetKind: "personal-connect",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("fences reserved credentials to exact activation and expires abandoned reservations", async () => {
    const host = hostAuthority();
    const challenge = await issueChallenge(service, ownerA, host);
    const completion = await service.completeLink(
      ownerA,
      signedLinkRequest(challenge, host.privateKey),
    );
    const otherHost = hostAuthority();
    const otherChallenge = await issueChallenge(service, ownerA, otherHost);
    const directory = new ControlPlaneStore(database, issuer, {
      managedDeploymentDomain: "connect.personal.test.invalid",
    });
    await expect(
      service.activateLink(`Bearer ${completion.hostCredential}`, {
        challengeId: otherChallenge.challengeId,
        linkGeneration: completion.linkGeneration,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.activateLink(`Bearer ${completion.hostCredential}`, {
        challengeId: challenge.challengeId,
        linkGeneration: AccountLinkGenerationSchema.parse("x".repeat(43)),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.unlinkPersonalHost(`Bearer ${completion.hostCredential}`, {
        challengeId: challenge.challengeId,
        linkGeneration: AccountLinkGenerationSchema.parse("x".repeat(43)),
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await database
      .updateTable("personalHostAccountLinkChallenges")
      .set({ resultExpiresAt: new Date(Date.now() - 1_000) })
      .where("challengeId", "=", challenge.challengeId)
      .executeTakeFirstOrThrow();
    await expect(service.purgeExpired(new Date())).resolves.toMatchObject({
      expired: 1,
      purged: 0,
    });
    await expect(
      database
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", host.authority.deploymentId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(directory.listDeployments(ownerA)).resolves.toEqual([]);
    await expect(issueChallenge(service, ownerA, host)).resolves.not.toHaveProperty(
      "schemaVersion",
    );
  });
});

function hostAuthority() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const authority = PersonalHostAccessAuthoritySchema.parse({
    canonicalOrigin: "http://127.0.0.1:4310",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: {
      algorithm: "Ed25519",
    },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
  });
  return { authority, privateKey: keys.privateKey, spki: spki.toString("base64url") };
}

function signedLinkRequest(
  challenge: IssuePersonalHostAccountLinkChallengeResponse,
  privateKey: KeyObject,
) {
  const issuedAt = new Date();
  const document = {
    account: challenge.account,
    authority: challenge.authorityEnvelope.document,
    challenge: {
      credentialSha256: hashCredential(challenge.challengeCredential),
      id: challenge.challengeId,
    },
    documentVersion: 2,
    expiresAt: new Date(
      Math.min(new Date(challenge.expiresAt).getTime(), issuedAt.getTime() + 120_000),
    ).toISOString(),
    issuedAt: issuedAt.toISOString(),
    purpose: "opensteer-personal-host-account-link",
  } as const;
  const publicKey = generatePublicSpki(privateKey);
  return {
    challengeCredential: challenge.challengeCredential,
    proof: PersonalHostAccountLinkProofEnvelopeSchema.parse({
      document,
      publicKey: { algorithm: "Ed25519", spki: publicKey },
      signature: sign(
        null,
        personalHostAccountLinkProofSigningBytes(document),
        privateKey,
      ).toString("base64url"),
    }),
  };
}

function signedRoute(host: ReturnType<typeof hostAuthority>, generation: number) {
  const document = {
    authority: host.authority,
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation,
      kind: "connect",
      origin: "https://connect-personal.test.invalid",
    },
  } as const;
  return PersonalHostAccessRouteEnvelopeSchema.parse({
    document,
    publicKey: { algorithm: "Ed25519", spki: host.spki },
    schemaVersion: 1,
    signature: sign(null, personalHostAccessRouteSigningBytes(document), host.privateKey).toString(
      "base64url",
    ),
  });
}

function generatePublicSpki(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
}

function issueChallenge(
  service: PersonalRemoteAccountService,
  ownerAccountId: ControlPlaneAccountId,
  host: ReturnType<typeof hostAuthority>,
  operationId: PersonalHostAccountLinkOperationId = PersonalHostAccountLinkOperationIdSchema.parse(
    `plo_${crypto.randomUUID()}`,
  ),
) {
  return service.issueLinkChallenge(ownerAccountId, {
    authorityEnvelope: signedAuthorityEnvelope(host),
    name: "This Mac",
    operationId,
  });
}

function signedAuthorityEnvelope(host: ReturnType<typeof hostAuthority>) {
  return HostDiscoveryEnvelopeSchema.parse({
    document: host.authority,
    publicKey: { algorithm: "Ed25519", spki: host.spki },
    signature: sign(null, hostDiscoverySigningBytes(host.authority), host.privateKey).toString(
      "base64url",
    ),
  });
}

/** Occupies exactly `count` owned Deployment slots so a race meets the ceiling. */
async function fillOwnedQuota(
  database: ReturnType<typeof createControlPlaneDatabase>,
  ownerAccountId: ControlPlaneAccountId,
  count: number,
): Promise<void> {
  const now = new Date();
  await database
    .insertInto("deployments")
    .values(
      Array.from({ length: count }, (_, index) => ({
        accountLink: null,
        activeHostInstanceId: createId("hostInstance"),
        authorityEnvelope: null,
        canonicalOrigin: `https://quota-${index}-${crypto.randomUUID()}.test.invalid`,
        createdAt: now,
        directoryGeneration: 1,
        hostKeyFingerprint: HostKeyFingerprintSchema.parse(
          `sha256:${createHash("sha256").update(`quota-${index}-${crypto.randomUUID()}`).digest("base64url")}`,
        ),
        reachability: "canonical" as const,
        id: createId("deployment"),
        lifecycle: "active" as const,
        name: `Quota ${index}`,
        oidcClientId: null,
        ownerAccountId,
        updatedAt: now,
      })),
    )
    .execute();
}

/** Drives the real issue -> complete -> activate path to one active Deployment. */
async function linkedPersonalHost(
  service: PersonalRemoteAccountService,
  ownerAccountId: ControlPlaneAccountId,
  host = hostAuthority(),
) {
  const authorityEnvelope = signedAuthorityEnvelope(host);
  const challenge = await issueChallenge(service, ownerAccountId, host);
  const completion = await service.completeLink(
    ownerAccountId,
    signedLinkRequest(challenge, host.privateKey),
  );
  await service.activateLink(`Bearer ${completion.hostCredential}`, {
    challengeId: challenge.challengeId,
    linkGeneration: completion.linkGeneration,
  });
  return {
    authorityEnvelope,
    challengeId: challenge.challengeId,
    host,
    hostCredential: completion.hostCredential,
    linkGeneration: completion.linkGeneration,
  };
}

function adoptionRequest(
  options: {
    readonly authority?: {
      readonly canonicalOrigin: string;
      readonly deploymentId: string;
      readonly hostInstanceId: string;
      readonly hostKeyFingerprint: string;
    };
  } = {},
) {
  return AdoptExistingDeploymentRequestSchema.parse({
    authority: options.authority ?? {
      canonicalOrigin: `https://adopted-${crypto.randomUUID()}.test.invalid`,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${createHash("sha256").update(crypto.randomUUID()).digest("base64url")}`,
    },
    reachability: "canonical",
    name: "Existing self-host",
    proof: {
      proofCredential: HostAccountAdoptionProofCredentialSchema.parse(
        `oap_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "A")}`,
      ),
      proofId: HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`),
    },
  });
}

/** One ready Cloudflare-backed Connect resource, as the provisioner commits it. */
function connectResource(deploymentId: DeploymentId, now: Date) {
  const suffix = deploymentId.slice("dep_".length);
  return {
    createdAt: now,
    credentialGeneration: 1,
    deploymentId,
    dnsRecordId: `dns-${suffix}`,
    hostname: `connect-${suffix}.test.invalid`,
    lastCompletedOperationId: null,
    lastCompletedOperationKind: null,
    localOrigin: "http://127.0.0.1:4310",
    operationExpiresAt: null,
    operationId: null,
    operationKind: null,
    provider: "cloudflare" as const,
    state: "ready" as const,
    tunnelId: `tunnel-${suffix}`,
    tunnelName: `opensteer-${suffix}`,
    updatedAt: now,
  };
}

function accountId(): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
}

function account(id: ControlPlaneAccountId, now: Date) {
  return {
    createdAt: now,
    displayName: `Account ${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    id,
    image: null,
    updatedAt: now,
  };
}
