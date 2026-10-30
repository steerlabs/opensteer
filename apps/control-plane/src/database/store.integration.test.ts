import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "@opensteer/database/test-support/database";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  AdoptExistingDeploymentRequestSchema,
  ControlPlaneAccountIdSchema,
  HostAccountAdoptionCompletionGrantClaimsSchema,
  HostAccountAdoptionProofCredentialSchema,
  HostAccountAdoptionProofIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  createId,
  opensteerAccountNativeOAuthClients,
  opensteerBetaDesktopClient,
  opensteerAccountDeleteOAuthScopes,
  opensteerMobileAccountOAuthCallback,
  opensteerMobileOAuthClientId,
  type DeploymentId,
  type HostInstanceId,
} from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
} from "@opensteer/deployment-authority";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { sql } from "kysely";
import { describe, expect, it as baseIt, vi } from "vitest";
import {
  createControlPlaneAuth,
  freshAccountSessionMilliseconds,
  ControlPlaneAuthenticator,
  type ControlPlaneAuth,
} from "../auth/auth.js";
import type { HostAccountAdoptionProofVerification } from "../adoption/adoption-verifier.js";
import type { ControlPlaneConfig } from "../config.js";
import {
  createHostCredential,
  createOAuthClientSecret,
  hashCredential,
} from "../auth/credentials.js";
import { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { createControlPlaneDatabase } from "./database.js";

import { createControlPlaneServer } from "../server/server.js";
import { ControlPlaneStore } from "./store.js";
import { AdoptionOperationCipher } from "../adoption/adoption-operation-crypto.js";
import { BetterAuthAccountAdoptionCompletionGrantIssuer } from "../adoption/adoption-grant-issuer.js";
import {
  recordedLockOrderEdges,
  withLockOrderMode,
} from "@opensteer/database/test-support/lock-order";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.test.opensteer.invalid");
const managedDeploymentDomain = "connect.test.opensteer.invalid";
const config: ControlPlaneConfig = {
  adoptionOperationKey: "A".repeat(43),
  personalAccountLinkOperationKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  environment: "test",
  databaseUrl: databaseUrl ?? "postgresql://unconfigured",
  publicOrigin,
  authSecret: "test-control-plane-secret-with-at-least-32-bytes",
  googleClientId: "test-google-client",
  googleClientSecret: "test-google-secret",
  managedDeploymentDomain,
  connectDomain: "connect.store.test.invalid",
  connectCloudflare: {
    accountId: "a".repeat(32),
    apiToken: "test-cloudflare-api-token",
    credentialDerivationSecret: "d".repeat(32),
    workersRouteBypass: false,
    zoneId: "b".repeat(32),
  },
  nativeOAuthClients: opensteerAccountNativeOAuthClients,
  listenHost: "127.0.0.1",
  listenPort: 41_142,
};

integration("control-plane PostgreSQL boundary", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("controlPlane");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createControlPlaneDatabase({
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new ControlPlaneStore(database, publicOrigin, {
      managedDeploymentDomain,
    });
    const connectLifecycle = new ConnectLifecycleService(database, {
      delete: async () => undefined,
      ensure: async () => Promise.reject(new Error("Connect provider is not used by this fixture")),
      readConnectorToken: async () =>
        Promise.reject(new Error("Connect provider is not used by this fixture")),
      rotateConnectorToken: async () =>
        Promise.reject(new Error("Connect provider is not used by this fixture")),
    });
    const ownerId = accountId();
    const memberId = accountId();
    const now = new Date();
    await database
      .insertInto("users")
      .values([
        {
          id: ownerId,
          displayName: "Owner",
          email: `owner-${ownerId}@example.test`,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: memberId,
          displayName: "Member",
          email: `member-${memberId}@example.test`,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .execute();
    return Object.freeze({ database, store, connectLifecycle, ownerId, memberId, databaseUrl });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  it("provisions every first-party native client without replacing the deployed Beta row or credentials", async ({
    storeFixture,
  }) => {
    const { store, database, ownerId, connectLifecycle } = storeFixture;
    await store.ensureOfficialNativeClients({
      clients: [opensteerAccountNativeOAuthClients[1]!],
    });
    const betaBefore = await database
      .selectFrom("oauthClients")
      .select(["id", "clientId"])
      .where("clientId", "=", "opensteer-desktop-beta")
      .executeTakeFirstOrThrow();
    await database
      .updateTable("oauthClients")
      .set({ referenceId: "official-native" })
      .where("id", "=", betaBefore.id)
      .executeTakeFirstOrThrow();
    const auth = createControlPlaneAuth(database, config);
    const cookie = await signedSessionCookie(auth, ownerId);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    const credentials = await authorizeNativeClient(
      server,
      cookie,
      opensteerBetaDesktopClient.clientId,
      opensteerBetaDesktopClient.accountCallback,
    );
    const credentialsBefore = await database
      .selectFrom("oauthRefreshToken")
      .select(["id", "revoked"])
      .where("clientId", "=", opensteerBetaDesktopClient.clientId)
      .executeTakeFirstOrThrow();
    try {
      await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
      await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
      const clients = await database
        .selectFrom("oauthClients")
        .select([
          "clientId",
          "clientSecret",
          "id",
          "redirectUris",
          "referenceId",
          "requirePkce",
          "applicationType",
        ])
        .where((expression) =>
          expression.or([
            expression("referenceId", "=", "official-native"),
            expression("referenceId", "like", "official-native:%"),
          ]),
        )
        .orderBy("clientId")
        .execute();
      expect(clients).toEqual(
        [...config.nativeOAuthClients]
          .sort((left, right) => left.clientId.localeCompare(right.clientId))
          .map((client) =>
            expect.objectContaining({
              clientId: client.clientId,
              clientSecret: null,
              id: client.clientId === betaBefore.clientId ? betaBefore.id : expect.any(String),
              referenceId:
                client.clientId === betaBefore.clientId
                  ? "official-native"
                  : `official-native:${client.clientId}`,
              redirectUris: client.redirectUris,
              requirePkce: true,
              applicationType: "native",
            }),
          ),
      );
      await expect(
        database
          .selectFrom("oauthClients")
          .select(["clientId", "referenceId"])
          .where("referenceId", "=", "official-native")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        clientId: "opensteer-desktop-beta",
        referenceId: "official-native",
      });
      await expect(
        database
          .selectFrom("oauthRefreshToken")
          .select(["id", "revoked"])
          .where("clientId", "=", opensteerBetaDesktopClient.clientId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual(credentialsBefore);
      const deployments = await server.inject({
        headers: { authorization: `Bearer ${credentials.accessToken}` },
        method: "GET",
        url: "/v1/account/deployments",
      });
      expect(deployments.statusCode, deployments.body).toBe(200);
      const refreshed = await refreshNativeClient(
        server,
        opensteerBetaDesktopClient.clientId,
        credentials.refreshToken,
      );
      expect(refreshed.statusCode, refreshed.body).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("does not expose legacy Account-created Personal Host authority", async ({ storeFixture }) => {
    const { database, ownerId, connectLifecycle, store } = storeFixture;
    const auth = createControlPlaneAuth(database, config);
    const cookie = await signedSessionCookie(auth, ownerId);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const response = await server.inject({
        headers: { cookie, origin: publicOrigin.origin },
        method: "POST",
        payload: {},
        url: "/v1/account/deployments",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("reserves managed Deployment identities before fencing its Account", async ({
    storeFixture,
  }) => {
    const { database, store, ownerId } = storeFixture;
    await withLockOrderMode("enforce", async () => {
      const request = adoptionRequest();
      const start = recordedLockOrderEdges.length;
      await database.transaction().execute((transaction) =>
        store.provisionManagedDeployment(
          ownerId,
          {
            ...request.authority,
            canonicalOrigin: managedOrigin(request.authority.deploymentId),
            name: request.name,
            reachability: "canonical",
          },
          transaction,
        ),
      );
      expect(
        recordedLockOrderEdges
          .slice(start)
          .filter((edge) => /(?:^|:)users$/u.test(edge.from) && edge.to.startsWith("advisory:")),
      ).toEqual([]);
    });
  });

  it("identifies Account tables separately from the Host schema", async ({ storeFixture }) => {
    const { store, ownerId, database } = storeFixture;
    await withLockOrderMode("enforce", async () => {
      const start = recordedLockOrderEdges.length;
      await store.revokeAccountSessions(ownerId);
      await database.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:account-deployment-quota:' || ${ownerId}, 0))`.execute(
          transaction,
        );
        await transaction
          .selectFrom("users")
          .select("id")
          .where("id", "=", ownerId)
          .forShare()
          .execute();
      });
      expect(
        recordedLockOrderEdges.slice(start).some((edge) => edge.to === "control-plane:users"),
      ).toBe(true);
    });
  });

  it("enforces the 100-Deployment catalog quota before Host adoption", async ({ storeFixture }) => {
    const { database, ownerId } = storeFixture;
    await insertQuotaDeployments(database, ownerId, 100);
    const verify = vi.fn();
    const auth = createControlPlaneAuth(database, config);
    const adoptionStore = new ControlPlaneStore(database, publicOrigin, {
      adoptionCompletionGrantIssuer: new BetterAuthAccountAdoptionCompletionGrantIssuer(
        auth,
        publicOrigin,
      ),
      adoptionOperationCipher: new AdoptionOperationCipher(config.adoptionOperationKey),
      adoptionProofVerifier: { verify },
      managedDeploymentDomain,
    });
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, adoptionRequest()),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("applies the same catalog quota before adding a shared directory membership", async ({
    storeFixture,
  }) => {
    const { database, ownerId, memberId, store } = storeFixture;
    const first = await registerFixture(database, ownerId);
    const second = await registerFixture(database, ownerId);
    await insertQuotaDeployments(database, memberId, 99);
    const firstAuthority = await store.authenticateHostCredential(
      `Bearer ${first.registration.hostCredential}`,
    );
    const secondAuthority = await store.authenticateHostCredential(
      `Bearer ${second.registration.hostCredential}`,
    );
    const projection = (hostInstanceId: HostInstanceId) => ({
      generation: 1,
      hostInstanceId,
      observedAt: new Date().toISOString(),
      present: true,
    });
    await expect(
      store.projectDirectoryEntry(firstAuthority, memberId, projection(first.hostInstanceId)),
    ).resolves.toMatchObject({ present: true });
    await expect(
      store.projectDirectoryEntry(secondAuthority, memberId, projection(second.hostInstanceId)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.listDeployments(memberId)).resolves.toMatchObject([
      { id: first.deploymentId },
    ]);
    await expect(
      database
        .selectFrom("deployments")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("ownerAccountId", "=", memberId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ count: "99" });
  });

  it("exposes no public route that could rotate, delete, or transfer Host authority", async ({
    storeFixture,
  }) => {
    const { database, ownerId, connectLifecycle, store } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const before = await database
      .selectFrom("deploymentCredentials")
      .innerJoin("deployments", "deployments.id", "deploymentCredentials.deploymentId")
      .select([
        "deploymentCredentials.tokenHash as tokenHash",
        "deployments.activeHostInstanceId as activeHostInstanceId",
        "deployments.lifecycle as lifecycle",
      ])
      .where("deployments.id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    const auth = createControlPlaneAuth(database, config);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const responses = await Promise.all([
        server.inject({
          method: "POST",
          url: `/v1/account/deployments/${fixture.deploymentId}/credentials/rotate`,
        }),
        server.inject({
          method: "POST",
          url: `/v1/account/deployments/${fixture.deploymentId}/transfers`,
        }),
        server.inject({
          method: "DELETE",
          url: `/v1/account/deployments/${fixture.deploymentId}/transfers`,
        }),
        server.inject({
          method: "POST",
          url: `/v1/deployments/${fixture.deploymentId}/transfers/dtx_unused/complete`,
        }),
      ]);
      // Host credential rotation, Deployment destruction, and transfer are not
      // built. Nothing answers on their paths, so no partially-implemented
      // handler can mutate authority.
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).not.toMatchObject({ error: { code: expect.anything() } });
      }
    } finally {
      await server.close();
    }
    await expect(
      database
        .selectFrom("deploymentCredentials")
        .innerJoin("deployments", "deployments.id", "deploymentCredentials.deploymentId")
        .select([
          "deploymentCredentials.tokenHash as tokenHash",
          "deployments.activeHostInstanceId as activeHostInstanceId",
          "deployments.lifecycle as lifecycle",
        ])
        .where("deployments.id", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual(before);
  });

  it("adopts an existing Host only with a fresh, one-use proof for the exact Account", async ({
    storeFixture,
  }) => {
    const { store, ownerId, database, connectLifecycle } = storeFixture;
    const request = adoptionRequest();
    await expect(store.adoptExistingDeployment(ownerId, request)).rejects.toMatchObject({
      code: "forbidden",
    });

    const consumedAt = new Date().toISOString();
    const verify = vi.fn(async (input: HostAccountAdoptionProofVerification) => {
      expect(input.account).toEqual({ issuer: publicOrigin.origin, subject: ownerId });
      return {
        account: input.account,
        authority: input.authority,
        authorizedBy: { sessionId: createId("authSession"), userId: createId("user") },
        consumedAt,
        proofId: input.proofId,
      };
    });
    const auth = createControlPlaneAuth(database, config);
    const completionGrantIssuer = new BetterAuthAccountAdoptionCompletionGrantIssuer(
      auth,
      publicOrigin,
    );
    const issue = vi.spyOn(completionGrantIssuer, "issue");
    const adoptionStore = new ControlPlaneStore(database, publicOrigin, {
      adoptionCompletionGrantIssuer: completionGrantIssuer,
      adoptionOperationCipher: new AdoptionOperationCipher(config.adoptionOperationKey),
      adoptionProofVerifier: { verify },
      managedDeploymentDomain,
    });

    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store: adoptionStore,
    });
    try {
      const missingProof = await server.inject({
        headers: {
          cookie: await signedSessionCookie(auth, ownerId),
          origin: publicOrigin.origin,
        },
        method: "POST",
        payload: {
          name: request.name,
          reachability: "canonical",
          authority: request.authority,
        },
        url: "/v1/account/deployment-adoptions",
      });
      expect(missingProof.statusCode).toBe(400);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }

    verify.mockRejectedValueOnce(new Error("simulated invalid Host proof"));
    await expect(adoptionStore.adoptExistingDeployment(ownerId, request)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      database
        .selectFrom("deploymentAdoptionOperations")
        .select("proofId")
        .where("proofId", "=", request.proof.proofId)
        .execute(),
    ).resolves.toEqual([]);

    const adopted = await adoptionStore.adoptExistingDeployment(ownerId, request);
    expect(verify).toHaveBeenCalledWith({
      proofId: request.proof.proofId,
      proofCredential: request.proof.proofCredential,
      account: { issuer: publicOrigin.origin, subject: ownerId },
      authority: request.authority,
    });
    expect(adopted).toMatchObject({
      proofId: request.proof.proofId,
      provisioningBundle: {
        provisioningMode: "adoption",
        deployment: {
          canonicalOrigin: request.authority.canonicalOrigin,
          deploymentId: request.authority.deploymentId,
          hostInstanceId: request.authority.hostInstanceId,
        },
      },
    });
    expect(new Date(adopted.resultExpiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(
      database
        .selectFrom("deploymentAdoptionOperations")
        .select(["sealedProvisioningBundle", "state"])
        .where("proofId", "=", request.proof.proofId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      sealedProvisioningBundle: expect.stringMatching(/^aop1\./u),
      state: "completed",
    });
    const verifiedGrant = await jwtVerify(
      adopted.completionGrant,
      createLocalJWKSet(await auth.api.getJwks()),
      {
        algorithms: ["EdDSA"],
        audience: request.authority.canonicalOrigin,
        issuer: publicOrigin.origin,
      },
    );
    expect(
      HostAccountAdoptionCompletionGrantClaimsSchema.parse(verifiedGrant.payload),
    ).toMatchObject({
      account: { issuer: publicOrigin.origin, subject: ownerId },
      authority: request.authority,
      proof: { id: request.proof.proofId },
      tokenUse: "opensteer-host-account-adoption",
    });
    const persisted = await database
      .selectFrom("deployments")
      .select(["activeHostInstanceId", "canonicalOrigin"])
      .where("id", "=", request.authority.deploymentId)
      .executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      activeHostInstanceId: request.authority.hostInstanceId,
      canonicalOrigin: request.authority.canonicalOrigin,
    });

    await expect(adoptionStore.adoptExistingDeployment(ownerId, request)).resolves.toMatchObject({
      proofId: request.proof.proofId,
      provisioningBundle: adopted.provisioningBundle,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(2);
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, { ...request, name: "Changed name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(verify).toHaveBeenCalledTimes(2);

    const deploymentCollision = adoptionRequest({
      authority: request.authority,
      proof: newAdoptionProof(),
    });
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, deploymentCollision),
    ).rejects.toMatchObject({ code: "conflict" });

    const originCollision = adoptionRequest({
      authority: {
        ...request.authority,
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
      },
      proof: newAdoptionProof(),
    });
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, originCollision),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      database
        .selectFrom("oauthClients")
        .select("id")
        .where("referenceId", "=", `deployment:${originCollision.authority.deploymentId}`)
        .execute(),
    ).resolves.toHaveLength(0);

    const authority = await adoptionStore.authenticateHostCredential(
      `Bearer ${adopted.provisioningBundle.hostCredential}`,
    );
    const acknowledgementServer = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store: adoptionStore,
    });
    try {
      const acknowledge = () =>
        acknowledgementServer.inject({
          headers: { authorization: `Bearer ${adopted.provisioningBundle.hostCredential}` },
          method: "POST",
          payload: {},
          url: `/v1/host/account-adoptions/${request.proof.proofId}/acknowledge`,
        });
      const acknowledged = await acknowledge();
      expect(acknowledged.statusCode, acknowledged.body).toBe(200);
      expect(acknowledged.json()).toMatchObject({
        acknowledged: true,
        proofId: request.proof.proofId,
      });
      const retry = await acknowledge();
      expect(retry.statusCode, retry.body).toBe(200);
    } finally {
      await acknowledgementServer.close();
    }
    await expect(
      database
        .selectFrom("deploymentAdoptionOperations")
        .select(["acknowledgedAt", "sealedProvisioningBundle", "state"])
        .where("proofId", "=", request.proof.proofId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      acknowledgedAt: expect.any(Date),
      sealedProvisioningBundle: null,
      state: "acknowledged",
    });
    await expect(
      adoptionStore.acknowledgeAccountAdoption(authority, request.proof.proofId),
    ).resolves.toBeUndefined();
    await expect(adoptionStore.adoptExistingDeployment(ownerId, request)).rejects.toMatchObject({
      code: "conflict",
    });

    const expiringRequest = adoptionRequest({
      authority: {
        canonicalOrigin: "https://expiring-self-host.example",
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
      },
    });
    await adoptionStore.adoptExistingDeployment(ownerId, expiringRequest);
    await adoptionStore.rotateHostCredential(ownerId, expiringRequest.authority.deploymentId);
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, expiringRequest),
    ).rejects.toMatchObject({ code: "conflict" });
    const expiredAt = new Date(Date.now() - 1_000);
    await database
      .updateTable("deploymentAdoptionOperations")
      .set({ resultExpiresAt: expiredAt })
      .where("proofId", "=", expiringRequest.proof.proofId)
      .executeTakeFirstOrThrow();
    await expect(adoptionStore.purgeExpiredAdoptionResults()).resolves.toBe(1);
    await expect(
      database
        .selectFrom("deploymentAdoptionOperations")
        .select(["sealedProvisioningBundle", "state"])
        .where("proofId", "=", expiringRequest.proof.proofId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ sealedProvisioningBundle: null, state: "expired" });
    await expect(
      adoptionStore.adoptExistingDeployment(ownerId, expiringRequest),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("accepts monotonic Host projections and exposes only present membership", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const authority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    const observedAt = new Date().toISOString();
    await store.projectDirectoryEntry(authority, memberId, {
      hostInstanceId: fixture.hostInstanceId,
      generation: 2,
      present: true,
      observedAt,
    });
    expect(await store.listDeployments(memberId)).toMatchObject([
      { access: "member", id: fixture.deploymentId },
    ]);

    await expect(
      store.projectDirectoryEntry(authority, memberId, {
        hostInstanceId: fixture.hostInstanceId,
        generation: 2,
        present: false,
        observedAt,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.projectDirectoryEntry(authority, memberId, {
        hostInstanceId: fixture.hostInstanceId,
        generation: 1,
        present: false,
        observedAt,
      }),
    ).rejects.toMatchObject({ code: "stale_projection" });
  });

  it("keeps per-Account listing removal across projections without changing authority", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const authority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    const projection = {
      hostInstanceId: fixture.hostInstanceId,
      generation: 2,
      present: true,
      observedAt: new Date().toISOString(),
    } as const;
    await store.projectDirectoryEntry(authority, memberId, projection);

    await expect(
      store.removeDeploymentFromDirectory(memberId, fixture.deploymentId),
    ).resolves.toBeUndefined();
    await expect(
      store.removeDeploymentFromDirectory(memberId, fixture.deploymentId),
    ).resolves.toBeUndefined();
    await expect(store.listDeployments(memberId)).resolves.toEqual([]);
    await expect(store.deploymentForAccount(memberId, fixture.deploymentId)).resolves.toMatchObject(
      {
        access: "member",
        id: fixture.deploymentId,
      },
    );

    await store.projectDirectoryEntry(authority, memberId, { ...projection, generation: 3 });
    await expect(store.listDeployments(memberId)).resolves.toEqual([]);
    await expect(store.listDeployments(ownerId)).resolves.toMatchObject([
      { access: "owner", id: fixture.deploymentId },
    ]);
    await expect(
      store.authenticateHostCredential(`Bearer ${fixture.registration.hostCredential}`),
    ).resolves.toMatchObject({ deploymentId: fixture.deploymentId });

    await expect(
      store.removeDeploymentFromDirectory(accountId(), fixture.deploymentId),
    ).rejects.toMatchObject({ code: "not_found" });
    // The owner's row is not a preference: it leaves through unlink, never a hide.
    await expect(
      store.removeDeploymentFromDirectory(ownerId, fixture.deploymentId),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.listDeployments(ownerId)).resolves.toMatchObject([
      { access: "owner", id: fixture.deploymentId },
    ]);
  });

  it("refuses membership projection until the Host has published its authority", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    await database
      .updateTable("deployments")
      .set({ authorityEnvelope: null })
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    const authority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    const projection = {
      generation: 2,
      hostInstanceId: fixture.hostInstanceId,
      observedAt: new Date().toISOString(),
      present: true,
    };
    await expect(
      store.projectDirectoryEntry(authority, memberId, projection),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.publishHostAuthority(authority, { authorityEnvelope: fixture.authorityEnvelope });
    await expect(
      store.projectDirectoryEntry(authority, memberId, projection),
    ).resolves.toMatchObject({ present: true });
  });

  it("lets only the exact Host replace the Account's copy of its signed authority", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const other = await registerFixture(database, ownerId);
    const authority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    // The stored copy predates a signed-document format change: the Account
    // still lists it, but nothing that parses it strictly can use it.
    const obsolete = {
      ...fixture.authorityEnvelope,
      document: { ...fixture.authorityEnvelope.document, protocolVersion: 3 },
    };
    await database
      .updateTable("deployments")
      .set({ authorityEnvelope: obsolete, updatedAt: new Date("2026-08-25T00:00:00.000Z") })
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(store.deploymentForAccount(ownerId, fixture.deploymentId)).rejects.toThrow();

    await expect(
      store.publishHostAuthority(authority, { authorityEnvelope: fixture.authorityEnvelope }),
    ).resolves.toEqual({ deploymentId: fixture.deploymentId, published: true });
    const republished = await database
      .selectFrom("deployments")
      .select(["authorityEnvelope", "updatedAt"])
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    expect(republished.authorityEnvelope).toEqual(fixture.authorityEnvelope);
    expect(republished.updatedAt.getTime()).toBeGreaterThan(Date.parse("2026-08-25T00:00:00.000Z"));
    await expect(store.deploymentForAccount(ownerId, fixture.deploymentId)).resolves.toMatchObject({
      access: "owner",
      authorityEnvelope: fixture.authorityEnvelope,
    });

    // Every Host start republishes; an unchanged document must not churn the row.
    await store.publishHostAuthority(authority, { authorityEnvelope: fixture.authorityEnvelope });
    await expect(
      database
        .selectFrom("deployments")
        .select("updatedAt")
        .where("id", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ updatedAt: republished.updatedAt });

    // Another Host's signed document, even from the same owner, is a different identity.
    await expect(
      store.publishHostAuthority(authority, { authorityEnvelope: other.authorityEnvelope }),
    ).rejects.toMatchObject({ code: "conflict" });
    const rotated = await store.rotateHostCredential(ownerId, fixture.deploymentId);
    await expect(
      store.publishHostAuthority(authority, { authorityEnvelope: fixture.authorityEnvelope }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.publishHostAuthority(
        await store.authenticateHostCredential(`Bearer ${rotated.hostCredential}`),
        { authorityEnvelope: fixture.authorityEnvelope },
      ),
    ).resolves.toMatchObject({ published: true });
  });

  it("enumerates current and historical Host artifacts without parsing the collection atomically", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store } = storeFixture;
    const historical = await registerFixture(database, ownerId);
    const current = await registerFixture(database, ownerId);
    await database
      .updateTable("deployments")
      .set({
        authorityEnvelope: {
          ...historical.authorityEnvelope,
          document: {
            ...historical.authorityEnvelope.document,
          },
        },
      })
      .where("id", "=", historical.deploymentId)
      .executeTakeFirstOrThrow();

    const directory = await store.listDeployments(ownerId);
    expect(directory.map(({ id }) => id).sort()).toEqual(
      [historical.deploymentId, current.deploymentId].sort(),
    );
    const historicalEntry = directory.find(({ id }) => id === historical.deploymentId);
    expect(historicalEntry).toMatchObject({ lifecycle: "active" });
    if (!historicalEntry || historicalEntry.lifecycle !== "active") {
      throw new Error("Historical directory entry was not returned");
    }
    expect(historicalEntry.authorityEnvelope).toMatchObject({
      document: {},
    });
  });

  it("rejects legacy Personal Connect projections without a Host-signed route", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const now = new Date();
    await database
      .insertInto("deploymentConnectResources")
      .values({
        createdAt: now,
        credentialGeneration: 1,
        deploymentId: fixture.deploymentId,
        dnsRecordId: "c".repeat(32),
        hostname: new URL(fixture.registration.deployment.canonicalOrigin).hostname,
        lastCompletedOperationId: null,
        lastCompletedOperationKind: null,
        localOrigin: "http://127.0.0.1:4310",
        operationExpiresAt: null,
        operationId: null,
        operationKind: null,
        provider: "cloudflare",
        state: "ready",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        tunnelName: `opensteer-${fixture.deploymentId.slice("dep_".length)}`,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    const authority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    await expect(
      store.projectConnect(authority, {
        hostInstanceId: fixture.hostInstanceId,
        generation: 1,
        state: "ready",
        origin: "https://wrong-connect.example",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.projectConnect(authority, {
        hostInstanceId: fixture.hostInstanceId,
        generation: 1,
        state: "ready",
        origin: fixture.registration.deployment.canonicalOrigin,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("fences an in-flight Host authority after credential rotation", async ({ storeFixture }) => {
    const { database, ownerId, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const oldAuthority = await store.authenticateHostCredential(
      `Bearer ${fixture.registration.hostCredential}`,
    );
    const rotated = await store.rotateHostCredential(ownerId, fixture.deploymentId);
    await expect(
      store.projectDirectoryEntry(oldAuthority, memberId, {
        hostInstanceId: fixture.hostInstanceId,
        generation: 1,
        present: true,
        observedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.authenticateHostCredential(`Bearer ${rotated.hostCredential}`),
    ).resolves.toMatchObject({ deploymentId: fixture.deploymentId });
  });

  it("deletes only central account records and refuses ambiguous owned deployment deletion", async ({
    storeFixture,
  }) => {
    const { database, ownerId, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    await expect(store.deleteAccount(ownerId)).rejects.toMatchObject({
      code: "owned_deployments_exist",
    });
    // Deployment removal has no product surface, so the precondition is
    // reproduced directly rather than through a coordinator that does not exist.
    await database.deleteFrom("deployments").where("id", "=", fixture.deploymentId).execute();
    await store.deleteAccount(ownerId);
    expect(
      await database.selectFrom("users").select("id").where("id", "=", ownerId).executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await database.selectFrom("users").select("id").where("id", "=", memberId).executeTakeFirst(),
    ).toBeDefined();
  });

  it("requires a recent Account sign-in for the unrecoverable Account deletion", async ({
    storeFixture,
  }) => {
    const { database, connectLifecycle, store, ownerId } = storeFixture;
    const auth = createControlPlaneAuth(database, config);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const staleCookie = await signedSessionCookie(auth, ownerId);
      await database
        .updateTable("authSessions")
        .set({ createdAt: new Date(Date.now() - freshAccountSessionMilliseconds - 60_000) })
        .where("userId", "=", ownerId)
        .execute();
      const stale = await server.inject({
        headers: { cookie: staleCookie, origin: publicOrigin.origin },
        method: "DELETE",
        url: "/v1/account",
      });
      expect(stale.statusCode, stale.body).toBe(401);
      expect(stale.json()).toMatchObject({ error: { code: "recent_sign_in_required" } });
      expect(
        await database
          .selectFrom("users")
          .select("id")
          .where("id", "=", ownerId)
          .executeTakeFirst(),
      ).toBeDefined();

      const deleted = await server.inject({
        headers: { cookie: await signedSessionCookie(auth, ownerId), origin: publicOrigin.origin },
        method: "DELETE",
        url: "/v1/account",
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toMatchObject({ deleted: true });
      expect(
        await database
          .selectFrom("users")
          .select("id")
          .where("id", "=", ownerId)
          .executeTakeFirst(),
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("serves well-known metadata and the strict Host directory route", async ({ storeFixture }) => {
    const { database, ownerId, connectLifecycle, store, memberId } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const auth = createControlPlaneAuth(database, config);
    const accountSession = await (await auth.$context).internalAdapter.createSession(ownerId);
    const signed = await auth.api.signJWT({
      body: {
        payload: {
          aud: publicOrigin.origin,
          iss: publicOrigin.origin,
          scope: "deployments:read",
          sid: accountSession.id,
          sub: ownerId,
        },
      },
    });
    expect(signed.token.split(".")).toHaveLength(3);
    expect(await database.selectFrom("authJwks").select("id").executeTakeFirst()).toBeDefined();
    await expect(
      new ControlPlaneAuthenticator(auth, database, publicOrigin).authenticate(
        new Headers({ authorization: `Bearer ${signed.token}` }),
        { scope: "deployments:read" },
      ),
    ).resolves.toEqual({ accountId: ownerId, application: null, kind: "bearer" });
    await database.deleteFrom("authSessions").where("id", "=", accountSession.id).execute();
    await expect(
      new ControlPlaneAuthenticator(auth, database, publicOrigin).authenticate(
        new Headers({ authorization: `Bearer ${signed.token}` }),
        { scope: "deployments:read" },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const metadata = await server.inject({
        method: "GET",
        url: "/.well-known/openid-configuration",
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({ issuer: publicOrigin.origin });

      const authorize = new URL("/api/auth/oauth2/authorize", publicOrigin);
      authorize.searchParams.set("client_id", fixture.registration.oidc.clientId);
      authorize.searchParams.set("redirect_uri", fixture.registration.oidc.redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "openid profile email");
      authorize.searchParams.set("state", "state-must-be-verified-by-the-host");
      authorize.searchParams.set("code_challenge", "A".repeat(43));
      authorize.searchParams.set("code_challenge_method", "S256");
      const authorization = await server.inject({
        method: "GET",
        url: authorize.pathname + authorize.search,
      });
      expect(authorization.statusCode).toBe(302);
      expect(authorization.headers.location).toContain("/sign-in?");

      authorize.searchParams.delete("state");
      const missingState = await server.inject({
        method: "GET",
        url: authorize.pathname + authorize.search,
      });
      expect(missingState.statusCode).toBe(400);
      expect(missingState.json()).toMatchObject({ error: { code: "bad_request" } });

      const published = await server.inject({
        method: "PUT",
        url: "/v1/host/authority",
        headers: { authorization: `Bearer ${fixture.registration.hostCredential}` },
        payload: { authorityEnvelope: fixture.authorityEnvelope },
      });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json()).toEqual({ deploymentId: fixture.deploymentId, published: true });
      const unauthenticatedPublish = await server.inject({
        method: "PUT",
        url: "/v1/host/authority",
        payload: { authorityEnvelope: fixture.authorityEnvelope },
      });
      expect(unauthenticatedPublish.statusCode).toBe(401);

      const projection = await server.inject({
        method: "PUT",
        url: `/v1/host/directory/${memberId}`,
        headers: { authorization: `Bearer ${fixture.registration.hostCredential}` },
        payload: {
          hostInstanceId: fixture.hostInstanceId,
          generation: 1,
          present: true,
          observedAt: new Date().toISOString(),
        },
      });
      expect(projection.statusCode).toBe(200);
      expect(projection.json()).toMatchObject({
        accountId: memberId,
        generation: 1,
        present: true,
      });

      const unknownField = await server.inject({
        method: "PUT",
        url: `/v1/host/directory/${memberId}`,
        headers: { authorization: `Bearer ${fixture.registration.hostCredential}` },
        payload: {
          hostInstanceId: fixture.hostInstanceId,
          generation: 2,
          present: true,
          observedAt: new Date().toISOString(),
          workspaceIds: ["must-not-enter-the-control-plane"],
        },
      });
      expect(unknownField.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("completes mobile authorization-code login with S256 PKCE and JSON-backed scopes", async ({
    storeFixture,
  }) => {
    const { store, database, ownerId, connectLifecycle } = storeFixture;
    await store.ensureOfficialNativeClients({ clients: config.nativeOAuthClients });
    const auth = createControlPlaneAuth(database, config);
    const cookie = await signedSessionCookie(auth, ownerId);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const verifier = "native-pkce-verifier-with-at-least-forty-three-characters-0123456789";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const redirectUri = opensteerMobileAccountOAuthCallback;
      const authorization = new URL("/api/auth/oauth2/authorize", publicOrigin);
      authorization.searchParams.set("client_id", opensteerMobileOAuthClientId);
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "S256");
      authorization.searchParams.set("redirect_uri", redirectUri);
      authorization.searchParams.set("resource", publicOrigin.origin);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", opensteerAccountDeleteOAuthScopes.join(" "));
      authorization.searchParams.set("state", "native-state-with-entropy");
      const authorizationResponse = await server.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: authorization.pathname + authorization.search,
      });
      expect(authorizationResponse.statusCode).toBe(200);
      const authorizationPayload = authorizationResponse.json<{
        redirect?: unknown;
        url?: unknown;
      }>();
      expect(authorizationPayload.redirect).toBe(true);
      expect(authorizationPayload.url, authorizationResponse.body).toEqual(expect.any(String));
      const consentPage = new URL(String(authorizationPayload.url), publicOrigin);
      expect(consentPage.origin).toBe(publicOrigin.origin);
      expect(consentPage.pathname).toBe("/consent");
      const renderedConsent = await server.inject({
        headers: { cookie },
        method: "GET",
        url: consentPage.pathname + consentPage.search,
      });
      expect(renderedConsent.statusCode, renderedConsent.body).toBe(200);
      expect(renderedConsent.headers["content-type"]).toContain("text/html");
      expect(renderedConsent.body).toContain("Authorize Opensteer");
      expect(renderedConsent.body).toContain("View your Opensteer deployments");
      const consent = await server.inject({
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          origin: publicOrigin.origin,
        },
        method: "POST",
        payload: new URLSearchParams({
          decision: "accept",
          oauth_query: consentPage.search.slice(1),
        }).toString(),
        url: "/consent",
      });
      expect(consent.statusCode, consent.body).toBe(302);
      const callback = new URL(String(consent.headers.location));
      expect(callback.protocol).toBe("com.opensteer.mobile:");
      expect(callback.searchParams.get("state")).toBe("native-state-with-entropy");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenResponse = await server.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: opensteerMobileOAuthClientId,
          code: code ?? "",
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          resource: publicOrigin.origin,
        }).toString(),
        url: "/api/auth/oauth2/token",
      });
      expect(tokenResponse.statusCode).toBe(200);
      const tokens = tokenResponse.json<{
        access_token?: unknown;
        id_token?: unknown;
        refresh_token?: unknown;
        token_type?: unknown;
      }>();
      expect(tokens).toMatchObject({
        access_token: expect.any(String),
        id_token: expect.any(String),
        refresh_token: expect.any(String),
        token_type: "Bearer",
      });
      expect(decodeJwt(String(tokens.id_token))).toMatchObject({
        aud: opensteerMobileOAuthClientId,
        email: `owner-${ownerId}@example.test`,
        sub: ownerId,
      });

      const repeatedAuthorization = await server.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: authorization.pathname + authorization.search,
      });
      expect(repeatedAuthorization.statusCode, repeatedAuthorization.body).toBe(200);
      const repeatedCallback = new URL(
        String(repeatedAuthorization.json<{ url?: unknown }>().url),
        publicOrigin,
      );
      expect(repeatedCallback.protocol).toBe("com.opensteer.mobile:");
      expect(repeatedCallback.pathname).toBe("/oauth/account-callback");
      expect(repeatedCallback.searchParams.get("code")).toBeTruthy();

      const deployments = await server.inject({
        headers: { authorization: `Bearer ${String(tokens.access_token)}` },
        method: "GET",
        url: "/v1/account/deployments",
      });
      expect(deployments.statusCode).toBe(200);
      expect(deployments.json()).toEqual({ deployments: [] });

      const refresh = await database
        .selectFrom("oauthRefreshToken")
        .select(["sessionId", "scopes"])
        .where("userId", "=", ownerId)
        .executeTakeFirstOrThrow();
      expect(refresh.scopes).toContain("offline_access");
      await database.deleteFrom("authSessions").where("id", "=", refresh.sessionId).execute();
      await expect(
        database
          .selectFrom("oauthRefreshToken")
          .select("id")
          .where("userId", "=", ownerId)
          .execute(),
      ).resolves.toHaveLength(0);
      const revoked = await server.inject({
        headers: { authorization: `Bearer ${String(tokens.access_token)}` },
        method: "GET",
        url: "/v1/account/deployments",
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("completes confidential Host OIDC login with exact callback, secret, and PKCE", async ({
    storeFixture,
  }) => {
    const { database, ownerId, connectLifecycle, store } = storeFixture;
    const fixture = await registerFixture(database, ownerId);
    const auth = createControlPlaneAuth(database, config);
    const cookie = await signedSessionCookie(auth, ownerId);
    const server = await createControlPlaneServer({
      auth,
      authenticator: new ControlPlaneAuthenticator(auth, database, publicOrigin),
      connectLifecycle,
      managedDeploymentDomain,
      publicOrigin,
      store,
    });
    try {
      const verifier = "host-pkce-verifier-with-at-least-forty-three-characters-012345678901";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorization = new URL("/api/auth/oauth2/authorize", publicOrigin);
      authorization.searchParams.set("client_id", fixture.registration.oidc.clientId);
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "S256");
      authorization.searchParams.set("redirect_uri", fixture.registration.oidc.redirectUri);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "openid profile email");
      authorization.searchParams.set("state", "host-state-with-entropy");
      const authorizationResponse = await server.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: authorization.pathname + authorization.search,
      });
      expect(authorizationResponse.statusCode).toBe(200);
      const callback = new URL(String(authorizationResponse.json<{ url?: unknown }>().url));
      expect(callback.origin + callback.pathname).toBe(fixture.registration.oidc.redirectUri);
      expect(callback.searchParams.get("state")).toBe("host-state-with-entropy");

      const code = callback.searchParams.get("code") ?? "";
      const tokenResponse = await server.inject({
        headers: {
          authorization: `Basic ${Buffer.from(
            `${fixture.registration.oidc.clientId}:${fixture.registration.oidcClientSecret}`,
          ).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        payload: new URLSearchParams({
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: fixture.registration.oidc.redirectUri,
        }).toString(),
        url: "/api/auth/oauth2/token",
      });
      expect(tokenResponse.statusCode).toBe(200);
      const tokens = tokenResponse.json<{
        access_token?: unknown;
        id_token?: unknown;
        refresh_token?: unknown;
      }>();
      expect(tokens).toMatchObject({
        access_token: expect.any(String),
        id_token: expect.any(String),
      });
      expect(tokens.refresh_token).toBeUndefined();
      expect(decodeJwt(String(tokens.id_token))).toMatchObject({
        aud: fixture.registration.oidc.clientId,
        email: `owner-${ownerId}@example.test`,
        sub: ownerId,
      });
      const storedAccess = await database
        .selectFrom("oauthAccessTokens")
        .select(["sessionId", "scopes"])
        .where("clientId", "=", fixture.registration.oidc.clientId)
        .executeTakeFirstOrThrow();
      expect(storedAccess.scopes).toEqual(["openid", "profile", "email"]);
      await database.deleteFrom("authSessions").where("id", "=", storedAccess.sessionId).execute();
      await expect(
        database
          .selectFrom("oauthAccessTokens")
          .select("id")
          .where("clientId", "=", fixture.registration.oidc.clientId)
          .execute(),
      ).resolves.toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

async function registerFixture(
  database: ReturnType<typeof createControlPlaneDatabase>,
  ownerId: ControlPlaneAccountId,
) {
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const hostKeys = generateKeyPairSync("ed25519");
  const hostSpki = hostKeys.publicKey.export({ format: "der", type: "spki" });
  const hostKeyFingerprint = `sha256:${createHash("sha256")
    .update(hostSpki)
    .digest("base64url")}` as const;
  const canonicalOrigin = managedOrigin(deploymentId);
  const authority = {
    canonicalOrigin,
    deploymentId,
    hostInstanceId,
    hostKey: { algorithm: "Ed25519" as const },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory" as const,
      kind: "personal" as const,
    },
  };
  const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse({
    document: authority,
    publicKey: { algorithm: "Ed25519", spki: hostSpki.toString("base64url") },
    signature: sign(null, hostDiscoverySigningBytes(authority), hostKeys.privateKey).toString(
      "base64url",
    ),
  });
  const hostCredential = createHostCredential();
  const oidcClientSecret = createOAuthClientSecret();
  const oidc = {
    clientId: `osh_${deploymentId.slice("dep_".length)}`,
    issuer: publicOrigin.origin,
    redirectUri: `${canonicalOrigin}/v1/auth/oidc/callback`,
    requirePkce: true,
    scopes: ["openid", "profile", "email"],
    tokenEndpointAuthMethod: "client_secret_basic" as const,
  };
  const now = new Date();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("oauthClients")
      .values({
        id: `oac_${crypto.randomUUID()}`,
        clientId: oidc.clientId,
        clientSecret: hashCredential(oidcClientSecret),
        disabled: false,
        skipConsent: true,
        enableEndSession: false,
        subjectType: "public",
        scopes: JSON.stringify(oidc.scopes),
        userId: ownerId,
        createdAt: now,
        updatedAt: now,
        name: "Opensteer Host: Stable deployment",
        uri: canonicalOrigin,
        icon: null,
        contacts: null,
        tos: null,
        policy: null,
        softwareId: "opensteer-host",
        softwareVersion: null,
        softwareStatement: null,
        redirectUris: JSON.stringify([oidc.redirectUri]),
        postLogoutRedirectUris: null,
        tokenEndpointAuthMethod: oidc.tokenEndpointAuthMethod,
        grantTypes: JSON.stringify(["authorization_code"]),
        responseTypes: JSON.stringify(["code"]),
        applicationType: "web",
        requirePkce: true,
        referenceId: `deployment:${deploymentId}`,
        metadata: { managedBy: "test-fixture", deploymentId },
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deployments")
      .values({
        accountLink: {
          generation: "g".repeat(43),
          issuer: publicOrigin.origin,
          subject: ownerId,
        },
        authorityEnvelope,
        directoryGeneration: 1,
        id: deploymentId,
        ownerAccountId: ownerId,
        name: "Stable deployment",
        reachability: "routed",
        activeHostInstanceId: hostInstanceId,
        hostKeyFingerprint,
        canonicalOrigin,
        lifecycle: "active",
        oidcClientId: oidc.clientId,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentCredentials")
      .values({
        deploymentId,
        tokenHash: hashCredential(hostCredential),
        createdAt: now,
        rotatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentConnect")
      .values({
        deploymentId,
        state: "disabled",
        origin: null,
        generation: 0,
        accessRoute: null,
        observedAt: null,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  });
  return {
    authorityEnvelope,
    deploymentId,
    hostInstanceId,
    registration: {
      deployment: { canonicalOrigin, id: deploymentId },
      hostCredential,
      oidc,
      oidcClientSecret,
    },
  };
}

async function insertQuotaDeployments(
  database: ReturnType<typeof createControlPlaneDatabase>,
  ownerId: ControlPlaneAccountId,
  count: number,
): Promise<void> {
  const now = new Date();
  const authorities = Array.from({ length: count }, (_, index) => ({
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${createHash("sha256")
      .update(`${ownerId}:${index}:${crypto.randomUUID()}`)
      .digest("base64url")}` as const,
    canonicalOrigin: `http://127.0.0.1:${20_000 + index}`,
  }));
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("deployments")
      .values(
        authorities.map((authority, index) => ({
          accountLink: {
            generation: "g".repeat(43),
            issuer: publicOrigin.origin,
            subject: ownerId,
          },
          id: authority.deploymentId,
          ownerAccountId: ownerId,
          name: `Quota fixture ${index + 1}`,
          reachability: "routed" as const,
          activeHostInstanceId: authority.hostInstanceId,
          hostKeyFingerprint: authority.hostKeyFingerprint,
          canonicalOrigin: authority.canonicalOrigin,
          lifecycle: "active" as const,
          oidcClientId: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .execute();
    await transaction
      .insertInto("deploymentConnect")
      .values(
        authorities.map((authority) => ({
          deploymentId: authority.deploymentId,
          state: "disabled" as const,
          origin: null,
          generation: 0,
          accessRoute: null,
          observedAt: null,
          updatedAt: now,
        })),
      )
      .execute();
  });
}

function adoptionRequest(
  options: {
    readonly authority?: {
      readonly deploymentId: DeploymentId;
      readonly hostInstanceId: HostInstanceId;
      readonly canonicalOrigin: string;
      readonly hostKeyFingerprint: string;
    };
    readonly proof?: ReturnType<typeof newAdoptionProof>;
  } = {},
) {
  return AdoptExistingDeploymentRequestSchema.parse({
    name: "Existing self-host",
    reachability: "canonical",
    authority: options.authority ?? {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      canonicalOrigin: "https://owned-self-host.example",
      hostKeyFingerprint: `sha256:${createHash("sha256")
        .update(crypto.randomUUID())
        .digest("base64url")}`,
    },
    proof: options.proof ?? newAdoptionProof(),
  });
}

function newAdoptionProof() {
  return {
    proofId: HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`),
    proofCredential: HostAccountAdoptionProofCredentialSchema.parse(
      `oap_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "A")}`,
    ),
  };
}

function managedOrigin(deploymentId: string): string {
  return `https://d-${deploymentId.slice("dep_".length)}.${managedDeploymentDomain}`;
}

async function authorizeNativeClient(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  cookie: string,
  clientId: string,
  redirectUri: string,
) {
  const verifier = "native-pkce-verifier-with-at-least-forty-three-characters-0123456789";
  const authorization = new URL("/api/auth/oauth2/authorize", publicOrigin);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("resource", publicOrigin.origin);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", opensteerAccountDeleteOAuthScopes.join(" "));
  authorization.searchParams.set("state", crypto.randomUUID());
  const begin = await server.inject({
    headers: { accept: "application/json", cookie },
    method: "GET",
    url: authorization.pathname + authorization.search,
  });
  expect(begin.statusCode, begin.body).toBe(200);
  const consentPage = new URL(String(begin.json<{ url?: unknown }>().url), publicOrigin);
  const consent = await server.inject({
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: publicOrigin.origin,
    },
    method: "POST",
    payload: new URLSearchParams({
      decision: "accept",
      oauth_query: consentPage.search.slice(1),
    }).toString(),
    url: "/consent",
  });
  expect(consent.statusCode, consent.body).toBe(302);
  const callback = new URL(String(consent.headers.location));
  expect(`${callback.protocol}${callback.pathname}`).toBe(redirectUri);
  const token = await server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: clientId,
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
  expect(token.statusCode, token.body).toBe(200);
  const credentials = token.json<{ access_token?: unknown; refresh_token?: unknown }>();
  expect(credentials).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  return {
    accessToken: String(credentials.access_token),
    refreshToken: String(credentials.refresh_token),
  };
}

function refreshNativeClient(
  server: Awaited<ReturnType<typeof createControlPlaneServer>>,
  clientId: string,
  refreshToken: string,
) {
  return server.inject({
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    payload: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: publicOrigin.origin,
    }).toString(),
    url: "/api/auth/oauth2/token",
  });
}

function accountId(): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
}

async function signedSessionCookie(
  auth: ControlPlaneAuth,
  accountId: ControlPlaneAccountId,
): Promise<string> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(accountId);
  const signature = createHmac("sha256", config.authSecret).update(session.token).digest("base64");
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
}
