import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "@opensteer/database/test-support/database";
import {
  ControlPlaneAccountIdSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRefreshTransactionIdSchema,
  OAuthBrokerAuthorizationCodeBundleSchema,
  OAuthBrokerCallbackRelayContextSchema,
  OAuthBrokerRefreshContextSchema,
  type OAuthBrokerSealedEnvelope,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
  hostedOAuthDeploymentAuthorityDigest,
} from "@opensteer/integration-auth";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it as baseIt, vi } from "vitest";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedOAuthBrokerStore } from "./hosted-oauth-broker-store.js";
import { HostedOAuthBrokerService } from "./hosted-oauth-broker-service.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("hosted OAuth broker durable boundary", () => {
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
    const store = new HostedOAuthBrokerStore(database);
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const now = new Date("2026-08-20T12:00:00.000Z");
    function attempt(attemptId: ReturnType<typeof attemptIdAt>, expiresAt: Date) {
      return {
        accountSubject: accountId,
        attemptId,
        contextKeyVersion: 1,
        deploymentId,
        encryptedContext: Buffer.from("encrypted-attempt-context"),
        expiresAt,
        hostPublicKey: "H".repeat(43),
        launchTicketHash: attemptDigest("launch", attemptId),
        provider: "google",
        providerApplicationRevision: 1,
        requestedScopeDigest: "D".repeat(43),
        stateHash: attemptDigest("state", attemptId),
      };
    }
    function expiringAttempt(attemptId: ReturnType<typeof attemptIdAt>) {
      return attempt(attemptId, new Date(now.getTime() + 1));
    }
    await database
      .insertInto("users")
      .values({
        createdAt: now,
        displayName: "Broker owner",
        email: "broker-owner@example.test",
        emailVerified: true,
        id: accountId,
        image: null,
        updatedAt: now,
      })
      .execute();
    await database
      .insertInto("deployments")
      .values({
        activeHostInstanceId: createId("hostInstance"),
        canonicalOrigin: "https://host.example.test",
        createdAt: now,
        hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
        reachability: "canonical",
        id: deploymentId,
        lifecycle: "active",
        name: "Broker test",
        oidcClientId: null,
        ownerAccountId: accountId,
        updatedAt: now,
      })
      .execute();
    return Object.freeze({
      database,
      store,
      accountId,
      deploymentId,
      now,
      attempt,
      expiringAttempt,
      databaseUrl,
    });
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

  it("replays one sealed attempt, rejects state replay, and deletes ciphertext on ACK", async ({
    storeFixture,
  }) => {
    const { store, attempt, now, accountId, database, deploymentId } = storeFixture;
    const attemptId = attemptIdAt(0);
    await store.createAttempt(attempt(attemptId, new Date(now.getTime() + 60_000)), now);
    await expect(
      store.launchAttempt({
        accountId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).resolves.not.toBeNull();
    await expect(
      store.claimCallback(attemptDigest("state", attemptId), now),
    ).resolves.not.toBeNull();
    await expect(store.claimCallback(attemptDigest("state", attemptId), now)).resolves.toBeNull();
    await store.sealAttempt(attemptId, sealedResult, now);
    const durableJson = await sql<{ readonly value: string }>`
      select row_to_json(attempt)::text as value
      from hosted_oauth_broker_attempts as attempt
      where attempt_id = ${attemptId}
    `.execute(database);
    expect(durableJson.rows[0]?.value).not.toContain("access-token-marker");
    expect(durableJson.rows[0]?.value).not.toContain("refresh-token-marker");

    const first = await store.pullAttemptResult(deploymentId, attemptId, now);
    const resumed = await store.pullAttemptResult(deploymentId, attemptId, now);
    expect(resumed).toMatchObject({ attemptId, sealedCiphertext: sealedResult });
    expect(Number(resumed?.retryGeneration)).toBe(Number(first?.retryGeneration) + 1);
    await expect(store.acknowledgeAttempt(deploymentId, attemptId, now)).resolves.toBe(true);
    await expect(store.acknowledgeAttempt(deploymentId, attemptId, now)).resolves.toBe(true);
    await expect(store.getAttemptForHost(deploymentId, attemptId, now)).resolves.toMatchObject({
      sealedCiphertext: null,
      status: "acknowledged",
    });
  });

  it("binds launch and reuse to the exact present Deployment member", async ({ storeFixture }) => {
    const { database, now, deploymentId, attempt, store, accountId } = storeFixture;
    const memberId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const otherMemberId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const unrelatedId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    await database
      .insertInto("users")
      .values(
        [
          { id: memberId, email: "member@example.test", displayName: "Member" },
          { id: otherMemberId, email: "other-member@example.test", displayName: "Other member" },
          { id: unrelatedId, email: "unrelated@example.test", displayName: "Unrelated" },
        ].map((user) => ({
          ...user,
          createdAt: now,
          emailVerified: true,
          image: null,
          updatedAt: now,
        })),
      )
      .execute();
    await database
      .insertInto("deploymentDirectoryEntries")
      .values(
        [memberId, otherMemberId].map((accountId) => ({
          accountId,
          deploymentId,
          generation: "1",
          observedAt: now,
          present: true,
          updatedAt: now,
        })),
      )
      .execute();

    const attemptId = attemptIdAt(20);
    const memberAttempt = {
      ...attempt(attemptId, new Date(now.getTime() + 60_000)),
      accountSubject: memberId,
    };
    await store.createAttempt(memberAttempt, now);
    await expect(
      store.createAttempt({ ...memberAttempt, accountSubject: unrelatedId }, now),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.launchAttempt({
        accountId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      store.launchAttempt({
        accountId: otherMemberId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      store.launchAttempt({
        accountId: unrelatedId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      store.launchAttempt({
        accountId: memberId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).resolves.not.toBeNull();

    const revokedAttemptId = attemptIdAt(21);
    await store.createAttempt(
      { ...attempt(revokedAttemptId, new Date(now.getTime() + 60_000)), accountSubject: memberId },
      now,
    );
    await database
      .updateTable("deploymentDirectoryEntries")
      .set({ present: false, updatedAt: now })
      .where("deploymentId", "=", deploymentId)
      .where("accountId", "=", memberId)
      .execute();
    await expect(
      store.launchAttempt({
        accountId: memberId,
        attemptId: revokedAttemptId,
        launchTicketHash: attemptDigest("launch", revokedAttemptId),
        now,
      }),
    ).resolves.toBeNull();
  });

  it("relays one Slack code to the exact member, Host, attempt, and custom app", async ({
    storeFixture,
  }) => {
    const { database, now, deploymentId, store } = storeFixture;
    const memberId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    await database
      .insertInto("users")
      .values({
        createdAt: now,
        displayName: "Relay member",
        email: "relay-member@example.test",
        emailVerified: true,
        id: memberId,
        image: null,
        updatedAt: now,
      })
      .execute();
    await database
      .insertInto("deploymentDirectoryEntries")
      .values({
        accountId: memberId,
        deploymentId,
        generation: "1",
        observedAt: now,
        present: true,
        updatedAt: now,
      })
      .execute();
    const binding = (await store.deploymentBinding(deploymentId))!;
    const definition = integrationDefinitions.find((candidate) => candidate.id === "slack")!;
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth")!;
    if (method.kind !== "oauth") throw new Error("Slack OAuth definition is unavailable");
    const broker = new HostedOAuthBrokerService({
      applications: [],
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      attemptContextEncryptionKey: Buffer.alloc(32, 7).toString("base64url"),
      store,
    });
    const attemptId = attemptIdAt(30);
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const state = "S".repeat(43);
    const callbackUrl = broker.callbackUrl("slack");
    const authorizationUrl = new URL(method.oauth.authorizationUrl);
    authorizationUrl.searchParams.set("client_id", "custom-slack-client");
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      method.oauth.scopes.join(method.oauth.scopeSeparator),
    );
    authorizationUrl.searchParams.set("state", state);
    const providerApplicationId = `ipa_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const created = await broker.createCallbackRelay(
      { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId },
      {
        accountSubject: { issuer: "https://accounts.opensteer.test", subject: memberId },
        attemptId,
        authorizationDigest: authorizationDigest(definition),
        authorizationUrl: authorizationUrl.toString(),
        clientSurface: "native",
        clientId: "custom-slack-client",
        definitionId: definition.id,
        deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
        expiresAt,
        hostPublicKey: recipient.publicKey,
        provider: "slack",
        providerApplicationId,
        providerApplicationRevision: 3,
      },
    );
    const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
    await expect(broker.launchAuthorization(memberId, attemptId, ticket)).resolves.toBe(
      authorizationUrl.toString(),
    );
    await expect(
      broker.completeAuthorization({
        parameters: new URLSearchParams({ code: "one-use-slack-code", state }),
        provider: "slack",
      }),
    ).resolves.toEqual({
      attemptId,
      returnUrl: `com.opensteer.mobile:/oauth/integration-callback?deployment_id=${deploymentId}&attempt_id=ioa_${attemptId.slice("hoa_".length)}`,
      status: "sealed",
    });
    const pulled = await broker.pull(
      { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId },
      attemptId,
    );
    const context = OAuthBrokerCallbackRelayContextSchema.parse({
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: memberId },
      attemptId,
      authorizationDigest: authorizationDigest(definition),
      definitionId: definition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      providerApplicationId,
      providerApplicationRevision: 3,
      redirectUrl: callbackUrl,
      schemaVersion: 1,
    });
    expect(
      OAuthBrokerAuthorizationCodeBundleSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult!, recipient.privateKey, context),
      ),
    ).toEqual({ code: "one-use-slack-code" });

    await database
      .updateTable("deploymentDirectoryEntries")
      .set({ present: false, updatedAt: now })
      .where("deploymentId", "=", deploymentId)
      .where("accountId", "=", memberId)
      .execute();
    await expect(
      broker.pull(
        { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId },
        attemptId,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("exchanges a managed provider code for the initiating cloud member", async ({
    storeFixture,
  }) => {
    const { database, now, deploymentId, store } = storeFixture;
    const memberId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    await database
      .insertInto("users")
      .values({
        createdAt: now,
        displayName: "Managed member",
        email: "managed-member@example.test",
        emailVerified: true,
        id: memberId,
        image: null,
        updatedAt: now,
      })
      .execute();
    await database
      .insertInto("deploymentDirectoryEntries")
      .values({
        accountId: memberId,
        deploymentId,
        generation: "1",
        observedAt: now,
        present: true,
        updatedAt: now,
      })
      .execute();
    const binding = (await store.deploymentBinding(deploymentId))!;
    const definition = integrationDefinitions.find((candidate) => candidate.id === "google-gmail")!;
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth")!;
    if (method.kind !== "oauth") throw new Error("Google OAuth definition is unavailable");
    const providerFetch = vi.fn(async () =>
      Response.json({
        access_token: "managed-member-access",
        refresh_token: "managed-member-refresh",
        scope: method.oauth.scopes.join(method.oauth.scopeSeparator),
        token_type: "Bearer",
      }),
    );
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "managed-google-client",
          clientSecret: "managed-google-secret",
          provider: "google",
          revision: 1,
        },
      ],
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      attemptContextEncryptionKey: Buffer.alloc(32, 7).toString("base64url"),
      store,
    });
    const attemptId = attemptIdAt(40);
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const created = await broker.createAuthorizationAttempt(
      { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId },
      {
        accountSubject: { issuer: "https://accounts.opensteer.test", subject: memberId },
        attemptId,
        authorizationDigest: authorizationDigest(definition),
        clientSurface: "web",
        definitionId: definition.id,
        deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
        expiresAt,
        hostPublicKey: recipient.publicKey,
        provider: "google",
        providerApplicationRevision: 1,
      },
    );
    const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
    const authorizationUrl = new URL(await broker.launchAuthorization(memberId, attemptId, ticket));
    await expect(
      broker.completeAuthorization({
        parameters: new URLSearchParams({
          code: "managed-member-code",
          iss: "https://accounts.google.com",
          state: authorizationUrl.searchParams.get("state")!,
        }),
        provider: "google",
      }),
    ).resolves.toMatchObject({ attemptId, status: "sealed" });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("deletes expired ciphertext and rate-limits a deployment", async ({ storeFixture }) => {
    const { store, expiringAttempt, now, database, deploymentId, attempt } = storeFixture;
    const expiring = attemptIdAt(0);
    await store.createAttempt(expiringAttempt(expiring), now);
    await database
      .updateTable("hostedOAuthBrokerAttempts")
      .set({
        contextKeyVersion: null,
        encryptedContext: null,
        launchTicketHash: null,
        sealedCiphertext: sealedResult,
        status: "sealed",
      })
      .where("attemptId", "=", expiring)
      .execute();
    await store.purgeExpired(new Date(now.getTime() + 1));
    await expect(
      store.getAttemptForHost(deploymentId, expiring, new Date(now.getTime() + 1)),
    ).resolves.toMatchObject({ sealedCiphertext: null, status: "expired" });

    for (let index = 1; index < 10; index += 1) {
      await store.createAttempt(attempt(attemptIdAt(index), new Date(now.getTime() + 60_000)), now);
    }
    await expect(
      store.createAttempt(attempt(attemptIdAt(10), new Date(now.getTime() + 60_000)), now),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("claims duplicate refresh IDs before provider access and consumes rate quota pre-flight", async ({
    storeFixture,
  }) => {
    const { deploymentId, database, now, store, accountId } = storeFixture;
    const binding = {
      activeHostInstanceId: createId("hostInstance"),
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
    };
    await database
      .updateTable("deployments")
      .set({ activeHostInstanceId: binding.activeHostInstanceId })
      .where("id", "=", deploymentId)
      .execute();
    let releaseProvider!: () => void;
    const providerPaused = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerCalled = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const definition = integrationDefinitions.find((candidate) => candidate.id === "google-gmail");
    if (!definition) throw new Error("Google Gmail test definition is unavailable");
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
    if (!method || method.kind !== "oauth")
      throw new Error("Google Gmail OAuth method is unavailable");
    const grantedScopes = method.oauth.scopes;
    const providerFetch = vi.fn(async () => {
      providerStarted();
      await providerPaused;
      return Response.json({
        access_token: "new-access-token",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        scope: grantedScopes.join(" "),
        token_type: "Bearer",
      });
    });
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "google-client",
          clientSecret: "google-secret",
          provider: "google",
          revision: 1,
        },
      ],
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      attemptContextEncryptionKey: Buffer.alloc(32, 7).toString("base64url"),
      store,
    });
    const transactionId = refreshIdAt(0);
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const context = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: authorizationDigest(definition),
      definitionId: definition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      providerApplicationRevision: 1,
      schemaVersion: 1,
      transactionId,
    });
    const request = {
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      authorizationDigest: context.authorizationDigest,
      brokerSealedCredential: sealOAuthBrokerPayload(
        { refreshToken: "one-use-rotating-refresh-token" },
        broker.metadata().encryptionPublicKey,
        context,
      ),
      deploymentAuthorityDigest: context.deploymentAuthorityDigest,
      definitionId: context.definitionId,
      expiresAt,
      grantedScopes,
      hostPublicKey: recipient.publicKey,
      provider: "google",
      providerApplicationRevision: 1,
      transactionId,
    };
    const authority = {
      credentialHash: "unused",
      deploymentId,
      hostInstanceId: binding.activeHostInstanceId,
    };

    const first = broker.refresh(authority, request);
    await providerCalled;
    await expect(broker.refresh(authority, request)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    releaseProvider();
    await expect(first).resolves.toMatchObject({ status: "sealed", transactionId });
    expect(providerFetch).toHaveBeenCalledOnce();

    for (let index = 1; index < 10; index += 1) {
      await store.claimRefresh(
        {
          accountSubject: accountId,
          deploymentId,
          expiresAt: new Date(now.getTime() + 60_000),
          hostPublicKey: recipient.publicKey,
          provider: "google",
          providerApplicationRevision: 1,
          transactionId: refreshIdAt(index),
        },
        now,
      );
    }
    const beforeRateLimited = providerFetch.mock.calls.length;
    await expect(
      broker.refresh(authority, {
        ...request,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { refreshToken: "another-refresh-token" },
          broker.metadata().encryptionPublicKey,
          {
            ...context,
            transactionId: refreshIdAt(10),
          },
        ),
        transactionId: refreshIdAt(10),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(providerFetch).toHaveBeenCalledTimes(beforeRateLimited);
  });
});

const markerRecipient = generateOAuthBrokerEphemeralKeyPair();
const sealedResult: OAuthBrokerSealedEnvelope = sealOAuthBrokerPayload(
  { accessToken: "access-token-marker", refreshToken: "refresh-token-marker" },
  markerRecipient.publicKey,
  { attemptId: "marker-test", purpose: "broker-at-rest-test" },
);

function attemptIdAt(index: number) {
  return HostedOAuthAttemptIdSchema.parse(
    `hoa_00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  );
}

function refreshIdAt(index: number) {
  return HostedOAuthRefreshTransactionIdSchema.parse(
    `hor_00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  );
}

function attemptDigest(purpose: string, attemptId: string): string {
  return createHash("sha256").update(`${purpose}\0${attemptId}`).digest("base64url");
}
