import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "@opensteer/database/test-support/database";
import {
  CreatePluginOAuthAttemptRequestSchema,
  CreatePluginOAuthCallbackRelayRequestSchema,
  OAuthBrokerPluginRelayContextSchema,
  CreatePluginOAuthRefreshRequestSchema,
  OAuthBrokerPluginAuthorizationContextSchema,
  OAuthBrokerPluginRefreshContextSchema,
  OAuthBrokerPluginRevocationContextSchema,
  HostedOAuthRevocationTransactionIdSchema,
  OAuthBrokerTokenBundleSchema,
  oauthBrokerManagedTokenContextVersion,
  ControlPlaneAccountIdSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRefreshTransactionIdSchema,
  type OAuthBrokerSealedEnvelope,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
  hostedOAuthDeploymentAuthorityDigest,
} from "@opensteer/control-plane-protocol/broker-sealing";
import { gate } from "@opensteer/shared/test-support/observation";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it as baseIt, vi } from "vitest";
import { pluginOAuthOnlyBrokerMigration } from "../database/migrations.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedOAuthBrokerStore } from "./hosted-oauth-broker-store.js";
import { brokerProviderFixture } from "./hosted-oauth-broker.test-support.js";
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
        registryRevision: 1,
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
    // A database outage is not a refusal: the Host must be able to retry it.
    const outage = new Error("connection terminated unexpectedly");
    const read = vi.spyOn(store, "getAttemptForHost").mockRejectedValueOnce(outage);
    await expect(broker.returnAttempt(authority, attemptId, proof)).rejects.toBe(outage);
    read.mockRestore();
    expect(await store.getAttemptForHost(deploymentId, attemptId, now)).toEqual(before);
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
      const context = OAuthBrokerPluginRelayContextSchema.parse({
        provider: "mcp",
        registryRevision: 1,
        requestedScopes: [],
        binding: {
          accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
          accountLinkGeneration: "g".repeat(43),
          deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
          hostPublicKey: recipient.publicKey,
          requirementDigest: "r".repeat(43),
          redirectUrl: broker.callbackUrl("mcp"),
        },
        relay: {
          clientId: "mcp-client",
          issuer: "https://mcp-issuer.example.test/",
          authorizationEndpoint: "https://mcp-issuer.example.test/authorize",
          authorizationResponseIssuerParameterSupported: true,
          usesPkce: true,
          scopeSeparator: " ",
        },
        attemptId,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        schemaVersion: 2,
      });
      const state = "s".repeat(43);
      const authorizationUrl = new URL(context.relay.authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        state,
        client_id: context.relay.clientId,
        redirect_uri: context.binding.redirectUrl,
        response_type: "code",
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
      }).toString();
      const { schemaVersion: _version, ...requestContext } = context;
      const created = await broker.createCallbackRelay(
        { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId! },
        {
          ...requestContext,
          kind: "plugin-relay",
          authorizationUrl: authorizationUrl.toString(),
          clientSurface: "native",
          ...(appFinish ? { finish: "app" as const } : {}),
        },
      );
      const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
      await broker.launchAuthorization(appFinish ? null : accountId, attemptId, ticket);
      const parameters = new URLSearchParams({
        code: "mcp-code",
        state,
        iss: context.relay.issuer!,
      });
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
        returnUrl: expect.stringContaining(`attempt_id=ioa_${attemptId.slice(4)}`),
      });
      if (appFinish) await proveAppReturn(broker, storeFixture, attemptId, outcome.returnUrl!);
      const result = await broker.pull(
        { credentialHash: "unused", deploymentId, hostInstanceId: binding.activeHostInstanceId! },
        attemptId,
      );
      expect(openOAuthBrokerPayload(result.sealedResult!, recipient.privateKey, context)).toEqual({
        parameters: [...parameters],
      });
      expect(broker.mcpClientMetadata()).toMatchObject({
        redirect_uris: [context.binding.redirectUrl],
      });
    },
  );

  it("replays one sealed attempt, rejects state replay, and deletes ciphertext on ACK", async ({
    storeFixture,
  }) => {
    const { store, attempt, now, accountId, database, deploymentId } = storeFixture;
    const attemptId = attemptIdAt(0);
    await store.createAttempt(attempt(attemptId, new Date(now.getTime() + 60_000)), now);
    const launches = await Promise.all(
      [0, 1].map(() =>
        store.launchAttempt({
          accountId,
          attemptId,
          launchTicketHash: attemptDigest("launch", attemptId),
          now,
        }),
      ),
    );
    expect(launches.filter(Boolean)).toHaveLength(1);
    expect(
      await store.launchAttempt({
        accountId,
        attemptId,
        launchTicketHash: attemptDigest("launch", attemptId),
        now,
      }),
    ).toBeNull();
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
      const oauth = brokerProviderFixture("google").oauth;
      const exchange = Promise.withResolvers<Response>();
      const providerFetch = vi.fn(async () => {
        if (mode === "expired-app") return exchange.promise;
        return Response.json({
          access_token: "managed-member-access",
          refresh_token: "managed-member-refresh",
          scope: oauth.scopes.join(oauth.scopeSeparator),
          token_type: "Bearer",
        });
      });
      const broker = new HostedOAuthBrokerService({
        applications: [
          {
            ...brokerProviderFixture("google"),
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
          kind: "plugin",
          attemptId,
          expiresAt,
          provider: "google",
          registryRevision: 1,
          requestedScopes: oauth.scopes,
          clientSurface: appFinish ? "desktop" : "web",
          ...(appFinish ? { finish: "app" as const } : {}),
          binding: {
            accountSubject: { issuer: "https://accounts.opensteer.test", subject: memberId },
            accountLinkGeneration: "g".repeat(43),
            requirementDigest: "r".repeat(43),
            deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
            hostPublicKey: recipient.publicKey,
            redirectUrl: broker.callbackUrl("google"),
          },
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
      const completion = broker.completeAuthorization({
        cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${ticket}`,
        parameters: new URLSearchParams({
          code: "managed-member-code",
          iss: "https://accounts.google.com",
          state: authorizationUrl.searchParams.get("state")!,
        }),
        provider: "google",
      });
      if (mode === "expired-app") {
        await vi.waitFor(() =>
          expect(providerFetch, "Token exchange never started").toHaveBeenCalledOnce(),
        );
        brokerNow = new Date(expiresAt);
        exchange.resolve(Response.json({ access_token: "expired-access", token_type: "Bearer" }));
      }
      const outcome = await completion;
      if (mode === "expired-app") {
        expect(outcome.status).toBe("failed");
        expect(
          outcome.returnUrl && new URL(outcome.returnUrl).searchParams.get("return"),
        ).toBeNull();
        expect(
          await database
            .selectFrom("hostedOAuthBrokerAttempts")
            .selectAll()
            .where("attemptId", "=", attemptId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          status: "expired",
          sealedCiphertext: null,
          returnProofHash: null,
          encryptedContext: null,
          contextKeyVersion: null,
          launchTicketHash: null,
        });
        expect(
          await broker.pull(
            {
              credentialHash: "unused",
              deploymentId,
              hostInstanceId: binding.activeHostInstanceId,
            },
            attemptId,
          ),
        ).toMatchObject({ status: "expired", sealedResult: null });
        expect(await store.getAttemptForHost(deploymentId, attemptId, brokerNow)).toMatchObject({
          status: "expired",
          sealedCiphertext: null,
          returnProofHash: null,
          encryptedContext: null,
          contextKeyVersion: null,
          launchTicketHash: null,
        });
        return;
      }
      expect(outcome).toMatchObject({ attemptId, status: appFinish ? "held" : "sealed" });
      if (appFinish)
        await proveAppReturn(broker, storeFixture, attemptId, outcome.returnUrl!, true);
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

  it.for([
    { kind: "attempt", deployments: 1 },
    { kind: "attempt", deployments: 3 },
    { kind: "refresh", deployments: 1 },
    { kind: "refresh", deployments: 3 },
  ])(
    "enforces Account and Deployment quotas across concurrent requests (%j)",
    async ({ kind, deployments }, { storeFixture }) => {
      const { store, now, deploymentId, accountId, attempt, database } = storeFixture;
      const original = await database
        .selectFrom("deployments")
        .selectAll()
        .where("id", "=", deploymentId)
        .executeTakeFirstOrThrow();
      const deploymentIds = [deploymentId];
      for (let index = 1; index < deployments; index += 1) {
        const id = createId("deployment");
        deploymentIds.push(id);
        await database
          .insertInto("deployments")
          .values({
            ...original,
            id,
            activeHostInstanceId: createId("hostInstance"),
            hostKeyFingerprint: `sha256:${createHash("sha256").update(id).digest("base64url")}`,
            canonicalOrigin: `https://host-${index}.example.test`,
          })
          .execute();
      }
      const expiresAt = new Date(now.getTime() + 60_000);
      const count = deployments === 1 ? 12 : 24;
      const accepted = deployments === 1 ? 10 : 20;
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, index) =>
          kind === "attempt"
            ? store.createAttempt(
                {
                  ...attempt(attemptIdAt(index), expiresAt),
                  deploymentId: deploymentIds[index % deployments]!,
                },
                now,
              )
            : store.claimRefresh(
                {
                  accountSubject: accountId,
                  deploymentId: deploymentIds[index % deployments]!,
                  expiresAt,
                  hostPublicKey: "h".repeat(43),
                  provider: "google",
                  registryRevision: 1,
                  requestBindingDigest: "d".repeat(43),
                  transactionId: refreshIdAt(index),
                },
                now,
              ),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(accepted);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(
        count - accepted,
      );
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            code: "unavailable",
            message: "Hosted OAuth rate limit exceeded",
          });
    },
  );

  it.for([false, true])(
    "resumes one rotating refresh and refuses a result that expired during exchange (expired: %s)",
    async (expired, { storeFixture }) => {
      const { store, deploymentId, accountId, now } = storeFixture;
      let brokerNow = now;
      const deployment = (await store.deploymentBinding(deploymentId))!;
      const authority = {
        credentialHash: "unused",
        deploymentId,
        hostInstanceId: deployment.activeHostInstanceId,
      };
      const recipient = generateOAuthBrokerEphemeralKeyPair();
      const oauth = brokerProviderFixture("google").oauth;
      const provider = gate({ label: "Rotating refresh provider", deadlineMs: 2_000 });
      const providerFetch = vi.fn(async () => {
        await provider.enter();
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          scope: oauth.scopes.join(" "),
          token_type: "Bearer",
        });
      });
      const broker = new HostedOAuthBrokerService({
        applications: [
          {
            ...brokerProviderFixture("google"),
            provider: "google",
            revision: 1,
            clientId: "client",
            clientSecret: "secret",
          },
        ],
        issuer: new URL("https://accounts.example.test"),
        now: () => brokerNow,
        fetch: providerFetch,
        attemptContextEncryptionKey: Buffer.alloc(32, 4).toString("base64url"),
        store,
      });
      const context = OAuthBrokerPluginRefreshContextSchema.parse({
        provider: "google",
        registryRevision: 1,
        requestedScopes: oauth.scopes,
        binding: {
          accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
          accountLinkGeneration: "g".repeat(43),
          requirementDigest: "r".repeat(43),
          deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(deployment),
          hostPublicKey: recipient.publicKey,
          redirectUrl: broker.callbackUrl("google"),
        },
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        schemaVersion: oauthBrokerManagedTokenContextVersion,
        transactionId: refreshIdAt(0),
      });
      const { schemaVersion: _version, ...fields } = context;
      const request = {
        ...fields,
        kind: "plugin",
        grantedScopes: oauth.scopes,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { refreshToken: "one-use-refresh" },
          broker.metadata().encryptionPublicKey,
          context,
        ),
      };
      const first = broker.refresh(authority, request);
      try {
        await provider.entered;
        await expect(broker.refresh(authority, request)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect(providerFetch).toHaveBeenCalledOnce();
        if (expired) brokerNow = new Date(context.expiresAt);
      } finally {
        provider.release();
      }
      if (expired) {
        await expect(first).rejects.toMatchObject({ code: "conflict" });
        expect(await broker.pullRefresh(authority, context.transactionId)).toMatchObject({
          status: "expired",
          sealedResult: null,
        });
        expect(providerFetch).toHaveBeenCalledOnce();
        return;
      }
      await expect(first).resolves.toMatchObject({
        status: "sealed",
        transactionId: context.transactionId,
      });
      const firstPull = await broker.pullRefresh(authority, context.transactionId);
      expect(await broker.refresh(authority, request)).toMatchObject({ status: "sealed" });
      const resumed = await broker.pullRefresh(authority, context.transactionId);
      expect(resumed.sealedResult).toEqual(firstPull.sealedResult);
      expect(
        openOAuthBrokerPayload(resumed.sealedResult!, recipient.privateKey, context),
      ).toMatchObject({ refreshToken: "rotated-refresh" });
      expect(providerFetch).toHaveBeenCalledOnce();
      for (let index = 1; index < 10; index += 1)
        await store.claimRefresh(
          {
            accountSubject: accountId,
            deploymentId,
            expiresAt: new Date(context.expiresAt),
            hostPublicKey: recipient.publicKey,
            provider: "google",
            registryRevision: 1,
            requestBindingDigest: "d".repeat(43),
            transactionId: refreshIdAt(index),
          },
          now,
        );
      await expect(
        broker.refresh(authority, { ...request, transactionId: refreshIdAt(10) }),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(providerFetch).toHaveBeenCalledOnce();
      await broker.acknowledgeRefresh(authority, context.transactionId);
      expect(await broker.pullRefresh(authority, context.transactionId)).toMatchObject({
        status: "acknowledged",
        sealedResult: null,
      });
    },
  );

  it("retires encrypted attempts and refreshes during the plugin-only broker migration", async ({
    storeFixture,
  }) => {
    const { database, store, attempt, now, deploymentId, accountId } = storeFixture;
    const expiresAt = new Date(now.getTime() + 60_000);
    await store.createAttempt(attempt(attemptIdAt(0), expiresAt), now);
    await store.claimRefresh(
      {
        accountSubject: accountId,
        deploymentId,
        expiresAt,
        hostPublicKey: "h".repeat(43),
        provider: "google",
        registryRevision: 1,
        requestBindingDigest: "d".repeat(43),
        transactionId: refreshIdAt(0),
      },
      now,
    );
    await sql`
      alter table public.hosted_oauth_broker_attempts rename column registry_revision to provider_application_revision;
      alter table public.hosted_oauth_broker_refreshes rename column registry_revision to provider_application_revision;
      alter table public.hosted_oauth_broker_refreshes alter column request_binding_digest drop not null;
      update public.hosted_oauth_broker_refreshes set request_binding_digest = null;
    `.execute(database);
    await pluginOAuthOnlyBrokerMigration.up(database);
    expect(await database.selectFrom("hostedOAuthBrokerAttempts").selectAll().execute()).toEqual(
      [],
    );
    expect(await database.selectFrom("hostedOAuthBrokerRefreshes").selectAll().execute()).toEqual(
      [],
    );
    expect(await database.selectFrom("users").select("id").execute()).toEqual([{ id: accountId }]);
    expect(await database.selectFrom("deployments").select("id").execute()).toEqual([
      { id: deploymentId },
    ]);
    const created = await store.createAttempt(attempt(attemptIdAt(1), expiresAt), now);
    expect(created.registryRevision).toBe(1);
    await store.failAttempt(created.attemptId, "failed", "client-rejected", now);
    expect(await store.getAttemptForHost(deploymentId, created.attemptId, now)).toMatchObject({
      failureCode: "client-rejected",
    });
    await store.createAttempt(attempt(attemptIdAt(2), expiresAt), now);
    await expect(
      store.failAttempt(attemptIdAt(2), "failed", "catalog-version-skew", now),
    ).rejects.toThrow();
  });

  it.for(["web", "app"] as const)(
    "binds plugin %s consent, sealed tokens, refresh and revocation to the reviewed Host context",
    async (finish, { storeFixture }) => {
      const { store, accountId, deploymentId, now } = storeFixture;
      const deployment = (await store.deploymentBinding(deploymentId))!;
      const authority = {
        credentialHash: "unused",
        deploymentId,
        hostInstanceId: deployment.activeHostInstanceId,
      };
      const recipient = generateOAuthBrokerEphemeralKeyPair();
      const application = {
        provider: "fixture",
        revision: 7,
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        allowedScopes: ["read", "write"],
        oauth: {
          authorizationUrl: "https://provider.example.test/authorize",
          tokenUrl: "https://provider.example.test/token",
          scopes: [],
          scopeSeparator: " ",
          usesPkce: true,
          clientAuth: "body" as const,
          revocation: {
            clientAuth: "body" as const,
            method: "post-form" as const,
            tokenField: "token",
            tokenSource: "refresh-token-preferred" as const,
            url: "https://provider.example.test/revoke",
          },
        },
      };
      const providerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_secret")).toBe("fixture-secret");
        return Response.json({
          access_token: "plugin-access",
          refresh_token: "plugin-refresh",
          scope: "read",
          token_type: "Bearer",
          expires_in: 3600,
        });
      });
      const broker = new HostedOAuthBrokerService({
        applications: [application],
        store,
        issuer: new URL("https://accounts.example.test"),
        now: () => now,
        fetch: providerFetch,
        attemptContextEncryptionKey: Buffer.alloc(32, 12).toString("base64url"),
      });
      const input = CreatePluginOAuthAttemptRequestSchema.parse({
        kind: "plugin",
        attemptId: attemptIdAt(101),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        provider: "fixture",
        registryRevision: 7,
        requestedScopes: ["read"],
        binding: {
          accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
          accountLinkGeneration: "g".repeat(43),
          deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(deployment),
          hostPublicKey: recipient.publicKey,
          requirementDigest: "r".repeat(43),
          redirectUrl: broker.callbackUrl("fixture"),
        },
        clientSurface: finish === "app" ? "desktop" : "web",
        ...(finish === "app" ? { finish: "app", appReturnPort: 48_203 } : {}),
        returnPath: "/plugins",
      });
      await expect(
        broker.createAuthorizationAttempt(authority, { ...input, requestedScopes: ["admin"] }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        broker.createAuthorizationAttempt(authority, { ...input, registryRevision: 8 }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        broker.createAuthorizationAttempt(authority, {
          ...input,
          binding: { ...input.binding, redirectUrl: "https://attacker.example.test/callback" },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        broker.createAuthorizationAttempt(authority, {
          ...input,
          binding: {
            ...input.binding,
            accountSubject: {
              ...input.binding.accountSubject,
              issuer: "https://other.example.test",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const created = await broker.createAuthorizationAttempt(authority, input);
      for (const change of [
        { accountLinkGeneration: "h".repeat(43) },
        { requirementDigest: "x".repeat(43) },
        { hostPublicKey: generateOAuthBrokerEphemeralKeyPair().publicKey },
      ]) {
        await expect(
          broker.createAuthorizationAttempt(authority, {
            ...input,
            binding: { ...input.binding, ...change },
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
      if (finish === "web") {
        await expect(
          broker.launchAuthorization(null, input.attemptId, ticket),
        ).rejects.toMatchObject({ refusalReason: "sign-in-required" });
        await expect(
          broker.launchAuthorization(
            ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
            input.attemptId,
            ticket,
          ),
        ).rejects.toMatchObject({ refusalReason: "account-mismatch" });
      }
      const launched = new URL(
        await broker.launchAuthorization(
          finish === "app" ? null : accountId,
          input.attemptId,
          ticket,
        ),
      );
      expect(launched.searchParams.get("scope")).toBe("read");
      const callback = {
        provider: "fixture",
        parameters: new URLSearchParams({
          state: launched.searchParams.get("state")!,
          code: "plugin-code",
        }),
        cookieHeader: `__Secure-opensteer.oauth.${input.attemptId}=${ticket}`,
      };
      await expect(
        broker.completeAuthorization({ ...callback, cookieHeader: "" }),
      ).rejects.toMatchObject({ refusalReason: "callback-claim-refused" });
      const result = await broker.completeAuthorization(callback);
      expect(result.status).toBe(finish === "app" ? "held" : "sealed");
      if (finish === "app")
        await proveAppReturn(broker, storeFixture, input.attemptId, result.returnUrl!);
      await expect(
        broker.pull({ ...authority, deploymentId: createId("deployment") }, input.attemptId),
      ).rejects.toMatchObject({ code: "forbidden" });
      const pulled = await broker.pull(authority, input.attemptId);
      expect(pulled.sealedResult).not.toBeNull();
      const context = OAuthBrokerPluginAuthorizationContextSchema.parse({
        provider: input.provider,
        registryRevision: input.registryRevision,
        requestedScopes: input.requestedScopes,
        binding: input.binding,
        attemptId: input.attemptId,
        expiresAt: input.expiresAt,
        schemaVersion: oauthBrokerManagedTokenContextVersion,
      });
      const bundle = OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult!, recipient.privateKey, context),
      );
      expect(bundle).toMatchObject({
        accessToken: "plugin-access",
        refreshToken: "plugin-refresh",
        grantedScopes: ["read"],
      });
      expect(() =>
        openOAuthBrokerPayload(
          pulled.sealedResult!,
          generateOAuthBrokerEphemeralKeyPair().privateKey,
          context,
        ),
      ).toThrow();
      for (const change of [
        { attemptId: attemptIdAt(102) },
        { expiresAt: new Date(now.getTime() + 61_000).toISOString() },
        { registryRevision: 8 },
        { requestedScopes: ["write"] },
        { binding: { ...context.binding, accountLinkGeneration: "h".repeat(43) } },
        { binding: { ...context.binding, requirementDigest: "x".repeat(43) } },
        { binding: { ...context.binding, redirectUrl: "https://attacker.example.test/callback" } },
      ]) {
        expect(() =>
          openOAuthBrokerPayload(pulled.sealedResult!, recipient.privateKey, {
            ...context,
            ...change,
          }),
        ).toThrow();
      }
      expect(JSON.stringify(pulled)).not.toContain("plugin-access");
      await expect(broker.completeAuthorization(callback)).rejects.toThrow();
      await broker.acknowledge(authority, input.attemptId);
      expect((await broker.pull(authority, input.attemptId)).sealedResult).toBeNull();
      const refreshContext = OAuthBrokerPluginRefreshContextSchema.parse({
        provider: input.provider,
        registryRevision: input.registryRevision,
        requestedScopes: input.requestedScopes,
        binding: input.binding,
        transactionId: refreshIdAt(101),
        expiresAt: input.expiresAt,
        schemaVersion: oauthBrokerManagedTokenContextVersion,
      });
      const { schemaVersion: _refreshVersion, ...refreshFields } = refreshContext;
      const refresh = CreatePluginOAuthRefreshRequestSchema.parse({
        ...refreshFields,
        kind: "plugin",
        brokerSealedCredential: sealOAuthBrokerPayload(
          { refreshToken: bundle.refreshToken },
          broker.metadata().encryptionPublicKey,
          refreshContext,
        ),
        grantedScopes: bundle.grantedScopes,
      });
      expect(await broker.refresh(authority, refresh)).toMatchObject({ status: "sealed" });
      const refreshed = await broker.pullRefresh(authority, refresh.transactionId);
      expect(
        openOAuthBrokerPayload(refreshed.sealedResult!, recipient.privateKey, refreshContext),
      ).toMatchObject({ accessToken: "plugin-access" });
      await expect(
        broker.refresh(authority, {
          ...refresh,
          binding: { ...refresh.binding, accountLinkGeneration: "h".repeat(43) },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        broker.refresh(authority, { ...refresh, grantedScopes: ["admin"] }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const refusedContext = { ...refreshContext, transactionId: refreshIdAt(102) };
      providerFetch.mockResolvedValueOnce(
        Response.json({
          access_token: "out-of-list-access",
          refresh_token: "out-of-list-refresh",
          scope: "read admin",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      await expect(
        broker.refresh(authority, {
          ...refresh,
          transactionId: refusedContext.transactionId,
          brokerSealedCredential: sealOAuthBrokerPayload(
            { refreshToken: bundle.refreshToken },
            broker.metadata().encryptionPublicKey,
            refusedContext,
          ),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(await broker.pullRefresh(authority, refusedContext.transactionId)).toMatchObject({
        status: "failed",
        failureCode: "scope-escalation",
        sealedResult: null,
      });
      await broker.acknowledgeRefresh(authority, refresh.transactionId);
      const revokeContext = OAuthBrokerPluginRevocationContextSchema.parse({
        ...refreshFields,
        schemaVersion: 2,
        transactionId: HostedOAuthRevocationTransactionIdSchema.parse(`hov_${crypto.randomUUID()}`),
      });
      const { schemaVersion: _revokeVersion, ...revokeFields } = revokeContext;
      await expect(
        broker.revoke(authority, {
          ...revokeFields,
          kind: "plugin",
          brokerSealedCredential: sealOAuthBrokerPayload(
            { accessToken: bundle.accessToken, refreshToken: bundle.refreshToken },
            broker.metadata().encryptionPublicKey,
            revokeContext,
          ),
        }),
      ).resolves.toMatchObject({ revoked: true });
      expect(providerFetch).toHaveBeenCalledTimes(4);
    },
  );
  it("relays a plugin's custom client parameters without exchanging its code or accepting another redirect or issuer", async ({
    storeFixture,
  }) => {
    const { store, accountId, deploymentId, now } = storeFixture;
    const deployment = (await store.deploymentBinding(deploymentId))!;
    const authority = {
      credentialHash: "unused",
      deploymentId,
      hostInstanceId: deployment.activeHostInstanceId,
    };
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const providerFetch = vi.fn(async () => {
      throw new Error("The relay must not exchange a custom client's code");
    });
    const broker = new HostedOAuthBrokerService({
      applications: [],
      store,
      issuer: new URL("https://accounts.example.test"),
      now: () => now,
      fetch: providerFetch,
      attemptContextEncryptionKey: Buffer.alloc(32, 14).toString("base64url"),
    });
    const relay = {
      clientId: "custom-registered-client",
      issuer: "https://custom.example.test",
      authorizationEndpoint: "https://custom.example.test/authorize",
      authorizationResponseIssuerParameterSupported: true,
      usesPkce: true,
      scopeSeparator: " ",
    };
    const state = "plugin:" + "s".repeat(43);
    const authorizationUrl = new URL(relay.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      state: state,
      client_id: relay.clientId,
      redirect_uri: broker.callbackUrl("custom"),
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "c".repeat(43),
      scope: "read",
    }).toString();
    const input = CreatePluginOAuthCallbackRelayRequestSchema.parse({
      kind: "plugin-relay",
      attemptId: attemptIdAt(102),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      provider: "custom",
      registryRevision: 1,
      requestedScopes: ["read"],
      binding: {
        accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
        accountLinkGeneration: "g".repeat(43),
        deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(deployment),
        hostPublicKey: recipient.publicKey,
        requirementDigest: "r".repeat(43),
        redirectUrl: broker.callbackUrl("custom"),
      },
      relay,
      authorizationUrl: authorizationUrl.toString(),
      clientSurface: "desktop",
      finish: "app",
    });
    await expect(
      broker.createCallbackRelay(authority, {
        ...input,
        binding: { ...input.binding, redirectUrl: "https://other.example.test/callback" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const badRedirect = new URL(authorizationUrl);
    badRedirect.searchParams.set("redirect_uri", "https://other.example.test/callback");
    await expect(
      broker.createCallbackRelay(authority, { ...input, authorizationUrl: badRedirect.toString() }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const noPkce = new URL(authorizationUrl);
    noPkce.searchParams.delete("code_challenge");
    await expect(
      broker.createCallbackRelay(authority, { ...input, authorizationUrl: noPkce.toString() }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const nonPkceMcp = new URL(authorizationUrl);
    nonPkceMcp.searchParams.set("redirect_uri", broker.callbackUrl("mcp"));
    nonPkceMcp.searchParams.delete("code_challenge");
    nonPkceMcp.searchParams.delete("code_challenge_method");
    await expect(
      broker.createCallbackRelay(authority, {
        ...input,
        provider: "mcp",
        binding: { ...input.binding, redirectUrl: broker.callbackUrl("mcp") },
        relay: { ...relay, usesPkce: false },
        authorizationUrl: nonPkceMcp.toString(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const created = await broker.createCallbackRelay(authority, input);
    await expect(
      broker.createCallbackRelay(authority, {
        ...input,
        relay: { ...relay, issuer: "https://other.example.test" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
    expect(await broker.launchAuthorization(null, input.attemptId, ticket)).toBe(
      authorizationUrl.toString(),
    );
    const result = await broker.completeAuthorization({
      provider: "custom",
      cookieHeader: `__Secure-opensteer.oauth.${input.attemptId}=${ticket}`,
      parameters: new URLSearchParams({
        state: state,
        code: "custom-code",
        iss: relay.issuer,
      }),
    });
    expect(result.status).toBe("held");
    await proveAppReturn(broker, storeFixture, input.attemptId, result.returnUrl!);
    const pulled = await broker.pull(authority, input.attemptId);
    const context = OAuthBrokerPluginRelayContextSchema.parse({
      provider: input.provider,
      registryRevision: input.registryRevision,
      requestedScopes: input.requestedScopes,
      binding: input.binding,
      attemptId: input.attemptId,
      expiresAt: input.expiresAt,
      relay,
      schemaVersion: 2,
    });
    expect(openOAuthBrokerPayload(pulled.sealedResult!, recipient.privateKey, context)).toEqual({
      parameters: [
        ["state", state],
        ["code", "custom-code"],
        ["iss", relay.issuer],
      ],
    });
    expect(() =>
      openOAuthBrokerPayload(pulled.sealedResult!, recipient.privateKey, {
        ...context,
        relay: { ...relay, issuer: "https://other.example.test" },
      }),
    ).toThrow();
    expect(providerFetch).not.toHaveBeenCalled();
    await broker.acknowledge(authority, input.attemptId);
    const nextUrl = new URL(authorizationUrl);
    nextUrl.searchParams.set("state", "t".repeat(43));
    const next = { ...input, attemptId: attemptIdAt(103), authorizationUrl: nextUrl.toString() };
    const nextCreated = await broker.createCallbackRelay(authority, next);
    const nextTicket = new URL(nextCreated.launchUrl).searchParams.get("ticket")!;
    await broker.launchAuthorization(null, next.attemptId, nextTicket);
    expect(
      await broker.completeAuthorization({
        provider: "custom",
        cookieHeader: `__Secure-opensteer.oauth.${next.attemptId}=${nextTicket}`,
        parameters: new URLSearchParams({
          state: "t".repeat(43),
          code: "wrong-issuer-code",
          iss: "https://attacker.example.test",
        }),
      }),
    ).toMatchObject({ status: "failed", failureCode: "invalid-provider-response" });
    expect((await broker.pull(authority, next.attemptId)).sealedResult).toBeNull();
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
