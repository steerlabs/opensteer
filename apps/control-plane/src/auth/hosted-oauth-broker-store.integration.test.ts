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
  OAuthBrokerMcpCallbackRelayContextSchema,
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

  async function proveAppReturn(
    broker: HostedOAuthBrokerService,
    fixture: StoreFixture,
    attemptId: ReturnType<typeof attemptIdAt>,
    returnUrl: string,
    acknowledge = false,
  ) {
    const { store, database, deploymentId, now } = fixture;
    const binding = (await store.deploymentBinding(deploymentId))!;
    const authority = {
      credentialHash: "unused",
      deploymentId,
      hostInstanceId: binding.activeHostInstanceId,
    };
    const proof = new URL(returnUrl).searchParams.get("return")!;
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await broker.pull(authority, attemptId)).toMatchObject({
      status: "launched",
      sealedResult: null,
    });
    const before = await store.getAttemptForHost(deploymentId, attemptId, now);
    expect(
      await store.claimCallback({
        stateHash: before!.stateHash!,
        provider: before!.provider,
        browserBindings: [{ attemptId, hash: before!.browserBindingHash! }],
        now,
      }),
    ).toBeNull();
    expect(before).toMatchObject({
      status: "held",
      returnProofHash: createHash("sha256").update(proof).digest("base64url"),
    });
    await expect(broker.returnAttempt(authority, attemptId, "X".repeat(43))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      broker.returnAttempt(
        { ...authority, deploymentId: createId("deployment") },
        attemptId,
        proof,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.getAttemptForHost(deploymentId, attemptId, now)).toEqual(before);
    await database
      .updateTable("deployments")
      .set({ canonicalOrigin: "https://changed.example.test" })
      .where("id", "=", deploymentId)
      .execute();
    await expect(broker.returnAttempt(authority, attemptId, proof)).rejects.toMatchObject({
      code: "forbidden",
      refusalReason: "return-authority-mismatch",
    });
    expect(await store.getAttemptForHost(deploymentId, attemptId, now)).toEqual(before);
    await database
      .updateTable("deployments")
      .set({ canonicalOrigin: binding.canonicalOrigin })
      .where("id", "=", deploymentId)
      .execute();
    if (before!.accountSubject !== binding.ownerAccountId) {
      await database
        .updateTable("deploymentDirectoryEntries")
        .set({ present: false })
        .where("deploymentId", "=", deploymentId)
        .where("accountId", "=", before!.accountSubject)
        .execute();
      await expect(broker.returnAttempt(authority, attemptId, proof)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await store.getAttemptForHost(deploymentId, attemptId, now)).toEqual(before);
      await database
        .updateTable("deploymentDirectoryEntries")
        .set({ present: true })
        .where("deploymentId", "=", deploymentId)
        .where("accountId", "=", before!.accountSubject)
        .execute();
    }
    const results = await Promise.all([
      broker.returnAttempt(authority, attemptId, proof),
      broker.returnAttempt(authority, attemptId, proof),
    ]);
    expect(results.map((result) => result.status)).toEqual(["sealed", "sealed"]);
    expect((await broker.pull(authority, attemptId)).sealedResult).not.toBeNull();
    if (acknowledge) {
      await broker.acknowledge(authority, attemptId);
      expect(await broker.returnAttempt(authority, attemptId, proof)).toMatchObject({
        status: "acknowledged",
      });
      expect(await store.getAttemptForHost(deploymentId, attemptId, now)).toMatchObject({
        returnProofHash: null,
        sealedCiphertext: null,
      });
      await expect(
        broker.returnAttempt(authority, attemptId, "X".repeat(43)),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  }

  it.for([false, true])(
    "relays MCP consent with issuer, PKCE, Account browser binding and no token exchange (app finish: %s)",
    async (appFinish, { storeFixture }) => {
      const { store, accountId, deploymentId, now } = storeFixture;
      const binding = (await store.deploymentBinding(deploymentId))!;
      const broker = new HostedOAuthBrokerService({
        applications: [],
        issuer: new URL("https://accounts.example.test"),
        now: () => now,
        attemptContextEncryptionKey: Buffer.alloc(32, 4).toString("base64url"),
        store,
        fetch: vi.fn(async () => {
          throw new Error("Account must not exchange MCP tokens");
        }),
      });
      const attemptId = attemptIdAt(90);
      const recipient = generateOAuthBrokerEphemeralKeyPair();
      const mcp = {
        serverId: `isv_${crypto.randomUUID()}`,
        issuer: "https://mcp-issuer.example.test/",
        authorizationEndpoint: "https://mcp-issuer.example.test/authorize",
        authorizationResponseIssuerParameterSupported: true,
      };
      const context = OAuthBrokerMcpCallbackRelayContextSchema.parse({
        accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
        attemptId,
        authorizationDigest: "d".repeat(43),
        deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        clientId: "mcp-client",
        mcp,
        redirectUrl: broker.callbackUrl("mcp"),
        schemaVersion: 1,
      });
      const state = "s".repeat(43);
      const authorizationUrl = new URL(mcp.authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        state,
        client_id: context.clientId,
        redirect_uri: context.redirectUrl,
        response_type: "code",
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
      }).toString();
      const { schemaVersion: _version, redirectUrl: _redirect, ...requestContext } = context;
      const created = await broker.createCallbackRelay(
        { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId! },
        {
          ...requestContext,
          authorizationUrl: authorizationUrl.toString(),
          hostPublicKey: recipient.publicKey,
          clientSurface: "native",
          ...(appFinish ? { finish: "app" as const } : {}),
          definitionId: mcp.serverId,
          provider: "mcp",
          providerApplicationRevision: 1,
        },
      );
      const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
      await broker.launchAuthorization(appFinish ? null : accountId, attemptId, ticket);
      const parameters = new URLSearchParams({ code: "mcp-code", state, iss: mcp.issuer });
      await expect(
        broker.completeAuthorization({ parameters, provider: "mcp" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        broker.completeAuthorization({
          parameters,
          provider: "google",
          cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${ticket}`,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const outcome = await broker.completeAuthorization({
        parameters,
        provider: "mcp",
        cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${ticket}`,
      });
      expect(outcome).toMatchObject({
        status: appFinish ? "held" : "sealed",
        returnUrl: expect.stringContaining(`attempt_id=imo_${attemptId.slice(4)}`),
      });
      if (appFinish) await proveAppReturn(broker, storeFixture, attemptId, outcome.returnUrl!);
      const result = await broker.pull(
        { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId! },
        attemptId,
      );
      expect(openOAuthBrokerPayload(result.sealedResult!, recipient.privateKey, context)).toEqual({
        parameters: [...parameters],
      });
      expect(broker.mcpClientMetadata()).toMatchObject({ redirect_uris: [context.redirectUrl] });
    },
  );

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
    const claim = {
      stateHash: attemptDigest("state", attemptId),
      provider: "google",
      browserBindings: [{ attemptId, hash: attemptDigest("launch", attemptId) }],
      now,
    };
    await expect(store.claimCallback({ ...claim, provider: "slack" })).resolves.toBeNull();
    await expect(store.claimCallback({ ...claim, browserBindings: [] })).resolves.toBeNull();
    await expect(
      store.claimCallback({ ...claim, browserBindings: [{ attemptId, hash: "x".repeat(43) }] }),
    ).resolves.toBeNull();
    const anotherId = attemptIdAt(1);
    await store.createAttempt(attempt(anotherId, new Date(now.getTime() + 60_000)), now);
    await store.launchAttempt({
      accountId,
      attemptId: anotherId,
      launchTicketHash: attemptDigest("launch", anotherId),
      now,
    });
    await expect(
      store.claimCallback({
        ...claim,
        browserBindings: [{ attemptId: anotherId, hash: attemptDigest("launch", anotherId) }],
      }),
    ).resolves.toBeNull();
    const claims = await Promise.all([store.claimCallback(claim), store.claimCallback(claim)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(
      store.claimCallback({
        ...claim,
        stateHash: attemptDigest("state", anotherId),
        browserBindings: [
          ...claim.browserBindings,
          { attemptId: anotherId, hash: attemptDigest("launch", anotherId) },
        ],
      }),
    ).resolves.toMatchObject({ attemptId: anotherId });
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

  it.for([false, true])(
    "relays one Slack code to the exact member, Host, attempt, and custom app (app finish: %s)",
    async (appFinish, { storeFixture }) => {
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
          ...(appFinish ? { finish: "app" as const } : {}),
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
      await expect(
        broker.launchAuthorization(appFinish ? null : memberId, attemptId, ticket),
      ).resolves.toBe(authorizationUrl.toString());
      const outcome = await broker.completeAuthorization({
        cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${ticket}`,
        parameters: new URLSearchParams({ code: "one-use-slack-code", state }),
        provider: "slack",
      });
      expect(outcome).toMatchObject({
        attemptId,
        returnUrl: expect.stringContaining(`attempt_id=ioa_${attemptId.slice("hoa_".length)}`),
        status: appFinish ? "held" : "sealed",
      });
      if (appFinish) await proveAppReturn(broker, storeFixture, attemptId, outcome.returnUrl!);
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
    },
  );

  it.for(["session", "app", "expired-app"] as const)(
    "exchanges a managed provider code for the initiating cloud member (app finish: %s)",
    async (mode, { storeFixture }) => {
      const appFinish = mode !== "session";
      const { database, now, deploymentId, store } = storeFixture;
      let brokerNow = now;
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
      const definition = integrationDefinitions.find(
        (candidate) => candidate.id === "google-gmail",
      )!;
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
        now: () => brokerNow,
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
          clientSurface: appFinish ? "desktop" : "web",
          ...(appFinish ? { finish: "app" as const } : {}),
          definitionId: definition.id,
          deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
          expiresAt,
          hostPublicKey: recipient.publicKey,
          provider: "google",
          providerApplicationRevision: 1,
        },
      );
      const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
      if (!appFinish) {
        await expect(
          broker.launchAuthorization(storeFixture.accountId, attemptId, ticket),
        ).rejects.toMatchObject({ refusalReason: "account-mismatch" });
        expect(await broker.inspectLaunch(attemptId, ticket)).toMatchObject({ status: "ready" });
        expect((await store.getAttemptForHost(deploymentId, attemptId, now))!.status).toBe(
          "pending",
        );
      }
      const authorizationUrl = new URL(
        await broker.launchAuthorization(appFinish ? null : memberId, attemptId, ticket),
      );
      expect(await broker.inspectLaunch(attemptId, ticket)).toEqual({ status: "used" });
      expect(await broker.inspectLaunch(attemptId, "X".repeat(43))).toEqual({ status: "invalid" });
      const outcome = await broker.completeAuthorization({
        cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${ticket}`,
        parameters: new URLSearchParams({
          code: "managed-member-code",
          iss: "https://accounts.google.com",
          state: authorizationUrl.searchParams.get("state")!,
        }),
        provider: "google",
      });
      expect(outcome).toMatchObject({ attemptId, status: appFinish ? "held" : "sealed" });
      if (appFinish)
        await proveAppReturn(broker, storeFixture, attemptId, outcome.returnUrl!, true);
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

  it.for(["held", "sealed"] as const)(
    "deletes expired %s ciphertext and rate-limits a deployment",
    async (status, { storeFixture }) => {
      const { store, expiringAttempt, now, database, deploymentId, attempt } = storeFixture;
      const expiring = attemptIdAt(0);
      await store.createAttempt(expiringAttempt(expiring), now);
      await database
        .updateTable("hostedOAuthBrokerAttempts")
        .set({
          contextKeyVersion: status === "held" ? 1 : null,
          encryptedContext: status === "held" ? Buffer.from("receipt") : null,
          launchTicketHash: null,
          sealedCiphertext: sealedResult,
          returnProofHash: "p".repeat(43),
          browserBindingHash: attemptDigest("launch", expiring),
          status,
        })
        .where("attemptId", "=", expiring)
        .execute();
      await store.purgeExpired(new Date(now.getTime() + 1));
      expect(
        await store.inspectLaunchAttempt(expiring, attemptDigest("launch", expiring)),
      ).not.toBeNull();
      expect(await store.inspectLaunchAttempt(expiring, "x".repeat(43))).toBeNull();
      await expect(
        store.getAttemptForHost(deploymentId, expiring, new Date(now.getTime() + 1)),
      ).resolves.toMatchObject({
        sealedCiphertext: null,
        returnProofHash: null,
        encryptedContext: null,
        status: "expired",
      });

      for (let index = 1; index < 10; index += 1) {
        await store.createAttempt(
          attempt(attemptIdAt(index), new Date(now.getTime() + 60_000)),
          now,
        );
      }
      await expect(
        store.createAttempt(attempt(attemptIdAt(10), new Date(now.getTime() + 60_000)), now),
      ).rejects.toMatchObject({ code: "unavailable" });
    },
  );

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
