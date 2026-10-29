import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createIntegrationId } from "@opensteer/integration-core";

import { describe, expect, it as baseIt } from "vitest";
import {
  createDatabase,
  erasedIntegrationAuthAttemptPayload,
  IntegrationAuthAttemptStore,
  IntegrationStore,
  isErasedIntegrationAuthAttemptPayload,
  OpensteerStore,
} from "./index.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration.sequential("PostgreSQL integration store", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-integration-oauth-test",
        connectionString: databaseUrl,
        maxConnections: 2,
      });
      return { database, close: () => database.destroy() };
    });
    const integrations = new IntegrationStore(database);
    const attempts = new IntegrationAuthAttemptStore(database);
    const store = new OpensteerStore(database);

    return Object.freeze({ database, integrations, attempts, store, databaseUrl });
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

  it("persists provider apps, one-time OAuth claims, encrypted credentials, and reconnects", async ({
    storeFixture,
  }) => {
    const { store, integrations, attempts } = storeFixture;
    const ownerUserId = await store.createUser("Integration owner");
    const applicationId = createIntegrationId("providerApplication");
    const application = await integrations.saveProviderApplication({
      actorUserId: ownerUserId,
      application: {
        clientId: "google-client",
        displayName: "Company Google",
        id: applicationId,
        ownerUserId: null,
        provider: "google",
        status: "active",
      },
      expectedRevision: null,
      requestId: "provider-create",
      secrets: { envelope: Buffer.from("encrypted-app-secret"), keyVersion: 1 },
    });
    expect(application).toMatchObject({ provider: "google", revision: 1 });
    await expect(
      integrations.saveProviderApplication({
        actorUserId: ownerUserId,
        application: {
          clientId: "stale-client",
          displayName: "Company Google",
          id: applicationId,
          ownerUserId: null,
          provider: "google",
          status: "active",
        },
        expectedRevision: null,
        requestId: "provider-stale",
        secrets: { envelope: Buffer.from("encrypted-app-secret"), keyVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const attemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("encrypted-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: attemptId,
      launchTicketHash: "c".repeat(43),
      ownerUserId,
      stateHash: "a".repeat(43),
      surface: "desktop",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "d".repeat(43),
      id: attemptId,
      launchTicketHash: "c".repeat(43),
      now: new Date(),
    });
    const claimed = await attempts.claimAuthAttempt({
      browserBindingHash: "d".repeat(43),
      flow: "provider-oauth",
      id: attemptId,
      now: new Date(),
      stateHash: "a".repeat(43),
    });
    expect(claimed?.encryptedPayload.toString()).toBe("encrypted-attempt");
    await expect(
      attempts.claimAuthAttempt({
        browserBindingHash: "d".repeat(43),
        flow: "provider-oauth",
        id: attemptId,
        now: new Date(),
        stateHash: "a".repeat(43),
      }),
    ).resolves.toBeNull();

    const resumableAttemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("resumable-hosted-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: resumableAttemptId,
      launchTicketHash: "g".repeat(43),
      ownerUserId,
      stateHash: "h".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "i".repeat(43),
      id: resumableAttemptId,
      launchTicketHash: "g".repeat(43),
      now: new Date(),
    });
    await expect(
      attempts.claimHostedAuthAttempt({
        id: resumableAttemptId,
        now: new Date(),
        ownerUserId,
      }),
    ).resolves.toMatchObject({ id: resumableAttemptId });
    await expect(
      attempts.claimHostedAuthAttempt({
        id: resumableAttemptId,
        now: new Date(),
        ownerUserId,
      }),
    ).resolves.toMatchObject({ id: resumableAttemptId });

    const connectionId = createIntegrationId("connection");
    const connection = await integrations.completeOAuthAttempt({
      attemptId,
      connection: {
        accountIdentifier: "person@example.com",
        applicationSource: {
          callbackUrl: "https://host.example/v1/integrations/oauth/callback/google",
          kind: "deployment-oauth",
          providerApplicationId: applicationId,
          providerApplicationRevision: 1,
        },
        authMethodId: "oauth",
        authorizationDigest: "a".repeat(43),
        computer: null,
        connectionMethod: "managed-oauth",
        definitionId: "google-gmail",
        displayName: "person@example.com",
        externalIdentityId: "google-user-1",
        externalTenantId: "example.com",
        grantedScopes: ["email.read"],
        id: connectionId,
        provider: "google",
        providerApplicationId: applicationId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      },
      credential: { envelope: Buffer.from("encrypted-user-token"), keyVersion: 1 },
      credentialProvider: "integration:google",
      ownerUserId,
    });
    expect(connection).toMatchObject({
      authorizationDigest: "a".repeat(43),
      id: connectionId,
    });
    // The completed attempt names the connection it produced, so a poller
    // can select that account without a second lookup.
    await expect(attempts.getAuthAttempt({ id: attemptId, ownerUserId })).resolves.toMatchObject({
      resultConnectionId: connectionId,
      status: "completed",
    });
    await integrations.setApplicationSourceDefault({
      actorUserId: ownerUserId,
      applicationSource: "hosted-oauth",
      provider: "google",
      requestId: "source-default-hosted",
    });
    await expect(integrations.listApplicationSourceDefaults()).resolves.toEqual({
      google: "hosted-oauth",
    });
    await expect(integrations.listConnections(ownerUserId)).resolves.toEqual([
      expect.objectContaining({
        applicationSource: expect.objectContaining({ kind: "deployment-oauth" }),
        id: connectionId,
      }),
    ]);
    await expect(integrations.listConnections(ownerUserId)).resolves.toHaveLength(1);
    await expect(
      integrations.findReusableConnectionId({
        definitionId: "google-gmail",
        externalIdentityId: "google-user-1",
        externalTenantId: "example.com",
        ownerUserId,
        provider: "google",
      }),
    ).resolves.toBe(connectionId);
    await expect(
      integrations.findReusableConnectionId({
        definitionId: "google-calendar",
        externalIdentityId: "google-user-1",
        externalTenantId: "example.com",
        ownerUserId,
        provider: "google",
      }),
    ).resolves.toBeNull();
    const conflictingOwnerUserId = await store.createUser("Conflicting integration owner");
    await expect(
      integrations.findReusableConnectionId({
        definitionId: "google-gmail",
        externalIdentityId: "google-user-1",
        externalTenantId: "example.com",
        ownerUserId: conflictingOwnerUserId,
        provider: "google",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("another user"),
    });
    await expect(integrations.listConnections(ownerUserId)).resolves.toHaveLength(1);
    await expect(integrations.listConnections(conflictingOwnerUserId)).resolves.toHaveLength(0);

    const secondAttemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("second-encrypted-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: secondAttemptId,
      launchTicketHash: "e".repeat(43),
      ownerUserId,
      stateHash: "b".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "f".repeat(43),
      id: secondAttemptId,
      launchTicketHash: "e".repeat(43),
      now: new Date(),
    });
    await attempts.claimAuthAttempt({
      browserBindingHash: "f".repeat(43),
      flow: "provider-oauth",
      id: secondAttemptId,
      now: new Date(),
      stateHash: "b".repeat(43),
    });
    await expect(
      integrations.completeOAuthAttempt({
        attemptId: secondAttemptId,
        connection: {
          accountIdentifier: "person@example.com",
          applicationSource: {
            callbackUrl: "https://host.example/v1/integrations/oauth/callback/google",
            kind: "deployment-oauth",
            providerApplicationId: applicationId,
            providerApplicationRevision: 1,
          },
          authMethodId: "oauth",
          authorizationDigest: "b".repeat(43),
          computer: null,
          connectionMethod: "managed-oauth",
          definitionId: "google-calendar",
          displayName: "person@example.com",
          externalIdentityId: "google-user-1",
          externalTenantId: "example.com",
          grantedScopes: ["analytics.read"],
          id: createIntegrationId("connection"),
          provider: "google",
          providerApplicationId: applicationId,
          status: "connected",
          statusDetail: null,
          statusReason: null,
        },
        credential: { envelope: Buffer.from("second-encrypted-token"), keyVersion: 1 },
        credentialProvider: "integration:google",
        ownerUserId,
      }),
    ).resolves.toMatchObject({ definitionId: "google-calendar" });
    const revocation = await integrations.getConnectionForRevocation({
      connectionId,
      ownerUserId,
    });
    expect(revocation?.encryptedCredential.toString()).toBe("encrypted-user-token");
    expect(revocation?.providerApplication?.id).toBe(applicationId);

    await expect(
      integrations.replaceConnectionCredential({
        connectionId,
        credential: { envelope: Buffer.from("rotated-user-token"), keyVersion: 2 },
        expectedGeneration: 1,
        ownerUserId,
      }),
    ).resolves.toBe(true);
    await expect(
      integrations.replaceConnectionCredential({
        connectionId,
        credential: { envelope: Buffer.from("stale-user-token"), keyVersion: 3 },
        expectedGeneration: 1,
        ownerUserId,
      }),
    ).resolves.toBe(false);
    const otherOwnerUserId = await store.createUser("Wrong integration owner");
    await expect(
      integrations.replaceConnectionCredential({
        connectionId,
        credential: { envelope: Buffer.from("wrong-owner-token"), keyVersion: 4 },
        expectedGeneration: 2,
        ownerUserId: otherOwnerUserId,
      }),
    ).resolves.toBe(false);
    await expect(
      integrations.getConnectionForRevocation({ connectionId, ownerUserId }),
    ).resolves.toMatchObject({
      credentialGeneration: 2,
      encryptedCredential: Buffer.from("rotated-user-token"),
      encryptionKeyVersion: 2,
    });

    await integrations.revokeConnection({
      connectionId,
      credential: { envelope: Buffer.from("encrypted-revoked-marker"), keyVersion: 1 },
      ownerUserId,
      requestId: "disconnect",
    });
    await expect(integrations.listConnections(ownerUserId)).resolves.toEqual([
      expect.objectContaining({ definitionId: "google-calendar" }),
    ]);

    await expect(
      attempts.readAuthAttemptPayload({ id: attemptId, ownerUserId }),
    ).resolves.toMatchObject({ encryptedPayload: erasedIntegrationAuthAttemptPayload });
  });

  it("isolates personal OAuth applications while retaining shared applications", async ({
    storeFixture,
  }) => {
    const { store, integrations } = storeFixture;
    const firstUserId = await store.createUser("First integration owner");
    const secondUserId = await store.createUser("Second integration owner");
    const sharedId = createIntegrationId("providerApplication");
    const firstPrivateId = createIntegrationId("providerApplication");
    const secondPrivateId = createIntegrationId("providerApplication");
    const save = (
      id: typeof sharedId,
      ownerUserId: typeof firstUserId | null,
      actorUserId: typeof firstUserId,
      displayName: string,
    ) =>
      integrations.saveProviderApplication({
        actorUserId,
        application: {
          clientId: `${displayName}-client`,
          displayName,
          id,
          ownerUserId,
          provider: "slack",
          status: "active",
        },
        expectedRevision: null,
        requestId: `save-${displayName}`,
        secrets: { envelope: Buffer.from(`encrypted-${displayName}`), keyVersion: 1 },
      });

    await save(sharedId, null, firstUserId, "Shared Slack");
    await save(firstPrivateId, firstUserId, firstUserId, "First Slack");
    await save(secondPrivateId, secondUserId, secondUserId, "Second Slack");

    expect(
      new Set((await integrations.listProviderApplications(firstUserId)).map(({ id }) => id)),
    ).toEqual(new Set([sharedId, firstPrivateId]));
    expect(
      new Set((await integrations.listProviderApplications(secondUserId)).map(({ id }) => id)),
    ).toEqual(new Set([sharedId, secondPrivateId]));
    expect((await integrations.getProviderApplication(firstPrivateId))?.ownerUserId).toBe(
      firstUserId,
    );
    expect((await integrations.getSharedProviderApplication("slack"))?.id).toBe(sharedId);

    await expect(
      integrations.saveProviderApplication({
        actorUserId: firstUserId,
        application: {
          clientId: "changed-owner-client",
          displayName: "Changed owner",
          id: firstPrivateId,
          ownerUserId: secondUserId,
          provider: "slack",
          status: "active",
        },
        expectedRevision: 1,
        requestId: "change-owner",
        secrets: { envelope: Buffer.from("encrypted-change"), keyVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      save(createIntegrationId("providerApplication"), null, secondUserId, "Duplicate shared"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("persists the exact install page for a custom GitHub App", async ({ storeFixture }) => {
    const { store, integrations } = storeFixture;
    const ownerUserId = await store.createUser("GitHub App owner");
    const applicationId = createIntegrationId("providerApplication");
    const saved = await integrations.saveProviderApplication({
      actorUserId: ownerUserId,
      application: {
        clientId: "Iv1.custom-github-client",
        displayName: "Custom GitHub App",
        id: applicationId,
        installationUrl: "https://github.com/apps/custom-opensteer/installations/new",
        ownerUserId,
        provider: "github",
        status: "active",
      },
      expectedRevision: null,
      requestId: "save-custom-github-app",
      secrets: { envelope: Buffer.from("encrypted-github-secret"), keyVersion: 1 },
    });

    expect(saved.installationUrl).toBe(
      "https://github.com/apps/custom-opensteer/installations/new",
    );
    await expect(integrations.getProviderApplication(applicationId)).resolves.toMatchObject({
      installationUrl: "https://github.com/apps/custom-opensteer/installations/new",
    });
    await expect(integrations.listProviderApplications(ownerUserId)).resolves.toEqual([
      expect.objectContaining({
        id: applicationId,
        installationUrl: "https://github.com/apps/custom-opensteer/installations/new",
      }),
    ]);
  });

  it("fences GitHub repository readiness and pending credential rotation", async ({
    storeFixture,
  }) => {
    const { store, attempts, integrations } = storeFixture;
    const ownerUserId = await store.createUser("GitHub repository owner");
    const attemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("github-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: attemptId,
      launchTicketHash: "t".repeat(43),
      ownerUserId,
      stateHash: "s".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "b".repeat(43),
      id: attemptId,
      launchTicketHash: "t".repeat(43),
      now: new Date(),
    });
    await attempts.claimAuthAttempt({
      browserBindingHash: "b".repeat(43),
      flow: "provider-oauth",
      id: attemptId,
      now: new Date(),
      stateHash: "s".repeat(43),
    });
    const connectionId = createIntegrationId("connection");
    await integrations.completeOAuthAttempt({
      attemptId,
      connection: {
        accountIdentifier: "octocat",
        applicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        authMethodId: "github-app",
        authorizationDigest: "g".repeat(43),
        computer: null,
        connectionMethod: "managed-oauth",
        definitionId: "github",
        displayName: "octocat",
        externalIdentityId: "1",
        externalTenantId: null,
        grantedScopes: [],
        id: connectionId,
        provider: "github",
        providerApplicationId: null,
        status: "needs-attention",
        statusDetail: "Choose repositories",
        statusReason: "permissions",
      },
      credential: { envelope: Buffer.from("github-token"), keyVersion: 1 },
      credentialProvider: "integration:github",
      ownerUserId,
    });

    await expect(
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        expectedGeneration: 1,
        expectedStatus: "needs-attention",
        expectedStatusDetail: "different observation",
        ownerUserId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      }),
    ).resolves.toBe(false);
    await expect(
      integrations.replaceConnectionCredential({
        connectionId,
        credential: { envelope: Buffer.from("must-not-rotate"), keyVersion: 2 },
        expectedGeneration: 1,
        ownerUserId,
      }),
    ).resolves.toBe(false);
    await expect(
      integrations.replaceConnectionCredential({
        allowNeedsAttention: true,
        connectionId,
        credential: { envelope: Buffer.from("rotated-github-token"), keyVersion: 2 },
        expectedGeneration: 1,
        ownerUserId,
      }),
    ).resolves.toBe(true);
    await expect(
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        expectedGeneration: 1,
        expectedStatus: "needs-attention",
        expectedStatusDetail: "Choose repositories",
        ownerUserId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      }),
    ).resolves.toBe(false);

    const reconnectAttemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("github-reconnect-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: reconnectAttemptId,
      launchTicketHash: "u".repeat(43),
      ownerUserId,
      stateHash: "v".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "w".repeat(43),
      id: reconnectAttemptId,
      launchTicketHash: "u".repeat(43),
      now: new Date(),
    });
    await attempts.claimAuthAttempt({
      browserBindingHash: "w".repeat(43),
      flow: "provider-oauth",
      id: reconnectAttemptId,
      now: new Date(),
      stateHash: "v".repeat(43),
    });
    await integrations.completeOAuthAttempt({
      attemptId: reconnectAttemptId,
      connection: {
        accountIdentifier: "octocat",
        applicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        authMethodId: "github-app",
        authorizationDigest: "g".repeat(43),
        computer: null,
        connectionMethod: "managed-oauth",
        definitionId: "github",
        displayName: "octocat",
        externalIdentityId: "1",
        externalTenantId: null,
        grantedScopes: [],
        id: connectionId,
        provider: "github",
        providerApplicationId: null,
        status: "needs-attention",
        statusDetail: "Choose repositories",
        statusReason: "permissions",
      },
      credential: { envelope: Buffer.from("reauthorized-github-token"), keyVersion: 3 },
      credentialProvider: "integration:github",
      ownerUserId,
    });
    await expect(
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        expectedGeneration: 2,
        expectedStatus: "needs-attention",
        expectedStatusDetail: "Choose repositories",
        ownerUserId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      }),
    ).resolves.toBe(false);
    await expect(
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 1,
        },
        expectedGeneration: 3,
        expectedStatus: "needs-attention",
        expectedStatusDetail: "Choose repositories",
        ownerUserId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      }),
    ).resolves.toBe(true);
    await expect(integrations.listConnections(ownerUserId)).resolves.toEqual([
      expect.objectContaining({ id: connectionId, status: "connected", statusDetail: null }),
    ]);
    await integrations.markConnectionNeedsAttention({
      connectionId,
      expectedGeneration: 2,
      ownerUserId,
      statusDetail: "Stale refresh must not overwrite reauthorization",
    });
    await expect(integrations.listConnections(ownerUserId)).resolves.toEqual([
      expect.objectContaining({ id: connectionId, status: "connected", statusDetail: null }),
    ]);
  });

  // The ways it could fail: the reason is not stored or not read back, so a
  // client cannot tell GitHub's repository step from a sign-in; a check that
  // still finds no repository drops it; reaching connected keeps it; a
  // credential failure or a revocation keeps it, so the account is offered a
  // repository step that refuses it instead of a sign-in; a failure judged on
  // a credential a newer sign-in replaced clears that sign-in's step; signing
  // in again does not restore it while GitHub still reaches no repository.
  it("says a GitHub account waits for repositories only while it does", async ({
    storeFixture,
  }) => {
    const { store, attempts, integrations, database } = storeFixture;
    const ownerUserId = await store.createUser("GitHub reason owner");
    const connectionId = createIntegrationId("connection");
    const applicationSource = {
      brokerIssuer: "https://accounts.opensteer.test",
      kind: "hosted-oauth" as const,
      providerApplicationRevision: 1,
    };
    const waiting = "Check repository access to finish connecting GitHub.";
    const signIn = async (seed: string) => {
      const attemptId = createIntegrationId("oauthAttempt");
      await attempts.createAuthAttempt({
        encryptedPayload: Buffer.from(`github-attempt-${seed}`),
        encryptionKeyVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
        flow: "provider-oauth",
        id: attemptId,
        launchTicketHash: seed.repeat(43),
        ownerUserId,
        stateHash: seed.toUpperCase().repeat(43),
        surface: "web",
      });
      await attempts.launchAuthAttempt({
        browserBindingHash: "b".repeat(43),
        id: attemptId,
        launchTicketHash: seed.repeat(43),
        now: new Date(),
      });
      await attempts.claimAuthAttempt({
        browserBindingHash: "b".repeat(43),
        flow: "provider-oauth",
        id: attemptId,
        now: new Date(),
        stateHash: seed.toUpperCase().repeat(43),
      });
      await integrations.completeOAuthAttempt({
        attemptId,
        connection: {
          accountIdentifier: "octocat",
          applicationSource,
          authMethodId: "github-app",
          authorizationDigest: "g".repeat(43),
          computer: null,
          connectionMethod: "managed-oauth",
          definitionId: "github",
          displayName: "octocat",
          externalIdentityId: "1",
          externalTenantId: null,
          grantedScopes: [],
          id: connectionId,
          provider: "github",
          providerApplicationId: null,
          status: "needs-attention",
          statusDetail: waiting,
          statusReason: "permissions",
        },
        credential: { envelope: Buffer.from(`github-token-${seed}`), keyVersion: 1 },
        credentialProvider: "integration:github",
        ownerUserId,
      });
    };
    const account = async () => {
      const [connection] = await integrations.listConnections(ownerUserId);
      return {
        status: connection?.status,
        statusDetail: connection?.statusDetail,
        statusReason: connection?.statusReason,
      };
    };
    const check = (
      expected: { readonly generation: number; readonly statusDetail: string },
      ready: boolean,
    ) =>
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: applicationSource,
        expectedGeneration: expected.generation,
        expectedStatus: "needs-attention",
        expectedStatusDetail: expected.statusDetail,
        ownerUserId,
        status: ready ? "connected" : "needs-attention",
        statusDetail: ready ? null : "Install or configure this GitHub App, then check again.",
        statusReason: ready ? null : "permissions",
      });

    await signIn("p");
    expect(await account()).toEqual({
      status: "needs-attention",
      statusDetail: waiting,
      statusReason: "permissions",
    });
    await expect(check({ generation: 1, statusDetail: waiting }, false)).resolves.toBe(true);
    expect(await account()).toEqual({
      status: "needs-attention",
      statusDetail: "Install or configure this GitHub App, then check again.",
      statusReason: "permissions",
    });
    await expect(
      check(
        { generation: 1, statusDetail: "Install or configure this GitHub App, then check again." },
        true,
      ),
    ).resolves.toBe(true);
    expect(await account()).toEqual({
      status: "connected",
      statusDetail: null,
      statusReason: null,
    });

    await signIn("q");
    expect((await account()).statusReason).toBe("permissions");
    const { credentialGeneration } = await database
      .selectFrom("integrationConnections")
      .select("credentialGeneration")
      .where("id", "=", connectionId)
      .executeTakeFirstOrThrow();
    const rejected = "GitHub REST rejected the saved sign-in";
    const rejectGeneration = (expectedGeneration: number) =>
      integrations.markConnectionNeedsAttention({
        connectionId,
        expectedGeneration,
        ownerUserId,
        statusDetail: rejected,
      });
    await rejectGeneration(credentialGeneration - 1);
    expect(await account()).toEqual({
      status: "needs-attention",
      statusDetail: waiting,
      statusReason: "permissions",
    });
    await rejectGeneration(credentialGeneration);
    expect(await account()).toEqual({
      status: "needs-attention",
      statusDetail: rejected,
      statusReason: null,
    });

    await signIn("r");
    expect((await account()).statusReason).toBe("permissions");
    await integrations.revokeConnection({
      connectionId,
      credential: { envelope: Buffer.from("revoked"), keyVersion: 1 },
      ownerUserId,
      requestId: "revoke-github-reason",
    });
    const revoked = await database
      .selectFrom("integrationConnections")
      .select(["status", "statusReason"])
      .where("id", "=", connectionId)
      .executeTakeFirstOrThrow();
    expect(revoked).toEqual({ status: "revoked", statusReason: null });
  });

  it("does not mark GitHub repository access ready after the custom app revision changes", async ({
    storeFixture,
  }) => {
    const { store, integrations, attempts } = storeFixture;
    const ownerUserId = await store.createUser("Custom GitHub repository owner");
    const applicationId = createIntegrationId("providerApplication");
    await integrations.saveProviderApplication({
      actorUserId: ownerUserId,
      application: {
        clientId: "Iv1.custom-github-client",
        displayName: "Custom GitHub App",
        id: applicationId,
        installationUrl: "https://github.com/apps/custom-opensteer/installations/new",
        ownerUserId,
        provider: "github",
        status: "active",
      },
      expectedRevision: null,
      requestId: "save-custom-github-app",
      secrets: { envelope: Buffer.from("encrypted-github-secret"), keyVersion: 1 },
    });
    const attemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("github-attempt"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: attemptId,
      launchTicketHash: "t".repeat(43),
      ownerUserId,
      stateHash: "s".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "b".repeat(43),
      id: attemptId,
      launchTicketHash: "t".repeat(43),
      now: new Date(),
    });
    await attempts.claimAuthAttempt({
      browserBindingHash: "b".repeat(43),
      flow: "provider-oauth",
      id: attemptId,
      now: new Date(),
      stateHash: "s".repeat(43),
    });
    const connectionId = createIntegrationId("connection");
    const applicationSource = {
      callbackUrl: "https://host.opensteer.test/v1/integrations/oauth/github/callback",
      kind: "deployment-oauth" as const,
      providerApplicationId: applicationId,
      providerApplicationRevision: 1,
    };
    await integrations.completeOAuthAttempt({
      attemptId,
      connection: {
        accountIdentifier: "octocat",
        applicationSource,
        authMethodId: "github-app",
        authorizationDigest: "g".repeat(43),
        computer: null,
        connectionMethod: "managed-oauth",
        definitionId: "github",
        displayName: "octocat",
        externalIdentityId: "custom-app-user",
        externalTenantId: null,
        grantedScopes: [],
        id: connectionId,
        provider: "github",
        providerApplicationId: applicationId,
        status: "needs-attention",
        statusDetail: "Choose repositories",
        statusReason: "permissions",
      },
      credential: { envelope: Buffer.from("github-token"), keyVersion: 1 },
      credentialProvider: "integration:github",
      ownerUserId,
    });

    await integrations.saveProviderApplication({
      actorUserId: ownerUserId,
      application: {
        clientId: "Iv1.rotated-github-client",
        displayName: "Custom GitHub App",
        id: applicationId,
        installationUrl: "https://github.com/apps/custom-opensteer/installations/new",
        ownerUserId,
        provider: "github",
        status: "active",
      },
      expectedRevision: 1,
      requestId: "rotate-custom-github-app",
      secrets: { envelope: Buffer.from("rotated-github-secret"), keyVersion: 2 },
    });

    await expect(
      integrations.setConnectionRepositoryAccess({
        connectionId,
        expectedApplicationSource: applicationSource,
        expectedGeneration: 1,
        expectedStatus: "needs-attention",
        expectedStatusDetail: "Choose repositories",
        ownerUserId,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      }),
    ).resolves.toBe(false);
    await expect(integrations.listConnections(ownerUserId)).resolves.toEqual([
      expect.objectContaining({
        id: connectionId,
        status: "needs-attention",
        statusDetail: "Choose repositories",
      }),
    ]);
  });

  it("erases the temporary authorization context when an attempt fails", async ({
    storeFixture,
  }) => {
    const { store, attempts } = storeFixture;
    const ownerUserId = await store.createUser("Attempt owner");
    const attemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("pkce-verifier-and-host-private-key"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: attemptId,
      launchTicketHash: "c".repeat(43),
      ownerUserId,
      stateHash: "a".repeat(43),
      surface: "web",
    });
    await attempts.launchAuthAttempt({
      browserBindingHash: "d".repeat(43),
      id: attemptId,
      launchTicketHash: "c".repeat(43),
      now: new Date(),
    });

    await attempts.failAuthAttempt({ id: attemptId, reason: "grant-rejected" });
    await attempts.failAuthAttempt({ id: attemptId, reason: "provider-exchange-failed" });

    const stored = await attempts.readAuthAttemptPayload({ id: attemptId, ownerUserId });
    expect(stored?.encryptedPayload).toEqual(erasedIntegrationAuthAttemptPayload);
    expect(isErasedIntegrationAuthAttemptPayload(stored!.encryptedPayload)).toBe(true);
    await expect(attempts.getAuthAttempt({ id: attemptId, ownerUserId })).resolves.toMatchObject({
      failureReason: "grant-rejected",
      status: "failed",
    });
  });

  it("erases the temporary authorization context when an attempt is cancelled", async ({
    storeFixture,
  }) => {
    const { store, attempts } = storeFixture;
    const ownerUserId = await store.createUser("Cancelling attempt owner");
    const attemptId = createIntegrationId("oauthAttempt");
    await attempts.createAuthAttempt({
      encryptedPayload: Buffer.from("temporary-authorization-context"),
      encryptionKeyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
      flow: "provider-oauth",
      id: attemptId,
      launchTicketHash: "c".repeat(43),
      ownerUserId,
      stateHash: "a".repeat(43),
      surface: "web",
    });

    await expect(attempts.cancelAuthAttempt({ id: attemptId, ownerUserId })).resolves.toBe(true);

    const stored = await attempts.readAuthAttemptPayload({ id: attemptId, ownerUserId });
    expect(stored?.encryptedPayload).toEqual(erasedIntegrationAuthAttemptPayload);
    expect(isErasedIntegrationAuthAttemptPayload(stored!.encryptedPayload)).toBe(true);
    await expect(attempts.getAuthAttempt({ id: attemptId, ownerUserId })).resolves.toMatchObject({
      failureReason: "cancelled",
      status: "failed",
    });
  });
});
