import {
  IntegrationConnectionSummarySchema,
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationApplicationSourceUnavailableDetail,
  integrationDefinitionSummary,
  type IntegrationAdapter,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinition,
  type IntegrationDeploymentPosture,
} from "@opensteer/integration-core";
import {
  type IntegrationProviderApplicationRecord,
  type IntegrationRepository,
} from "@opensteer/integration-core/ports";
import { installedIntegrationDefinition } from "@opensteer/database";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
} from "@opensteer/integration-auth";
import {
  CreateHostedOAuthRevocationRequestSchema,
  OAuthBrokerRevocationContextSchema,
  CreateHostedOAuthAttemptRequestSchema,
  CreateHostedOAuthAttemptResponseSchema,
  CreateHostedOAuthRefreshRequestSchema,
  CreateHostedOAuthRefreshResponseSchema,
  OAuthBrokerPublicMetadataSchema,
  PullHostedOAuthRefreshResponseSchema,
  PullHostedOAuthResultResponseSchema,
} from "@opensteer/control-plane-protocol";
import { OpensteerError, createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { canonicalAuthorizationRepair } from "../identity/auth.js";
import {
  IntegrationService,
  type InstalledIntegrationDefinitionLookup,
  type IntegrationConnectionConnected,
} from "./integration-service.js";

describe("IntegrationService API-key connections", () => {
  it("validates health, seals values with provider-connection AAD, and reuses identity", async () => {
    const checkHealth = vi.fn(async () => ({
      healthy: true as const,
      identity: {
        accountIdentifier: "alex@work.example",
        displayName: "Linear work account",
        externalIdentityId: "linear-user-1",
        externalTenantId: "linear-org-1",
      },
    }));
    let reusable: IntegrationConnectionId | null = null;
    const connectApiKey = vi.fn(
      async (input: Parameters<IntegrationRepository["connectApiKey"]>[0]) => {
        reusable = input.connection.id;
        return IntegrationConnectionSummarySchema.parse({
          ...input.connection,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        });
      },
    );
    const repository = {
      connectApiKey,
      findReusableConnectionId: vi.fn(async () => reusable),
    } as unknown as IntegrationRepository;
    const seal = vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 }));
    const onConnectionConnected = vi.fn(async () => undefined);
    const service = apiKeyService({ checkHealth, onConnectionConnected, repository, seal });
    const ownerUserId = createId("user");

    const first = await service.connectApiKey(
      { authMethodId: "api-key", definitionId: "linear", values: { apiKey: "lin_secret" } },
      { ownerUserId, requestId: "first" },
    );
    const second = await service.connectApiKey(
      { authMethodId: "api-key", definitionId: "linear", values: { apiKey: "lin_rotated" } },
      { ownerUserId, requestId: "second" },
    );

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      accountIdentifier: "alex@work.example",
      authMethodId: "api-key",
      connectionMethod: "api-key",
      definitionId: "linear",
      externalIdentityId: "linear-user-1",
      externalTenantId: "linear-org-1",
      grantedScopes: [],
      providerApplicationId: null,
    });
    expect(checkHealth).toHaveBeenCalledWith({
      config: { endpoint: "https://api.linear.test/graphql" },
      credentialValues: { apiKey: "lin_secret" },
      placements: [
        {
          carrier: "header",
          name: "Authorization",
          prefix: "Bearer ",
          variable: "apiKey",
        },
      ],
    });
    expect(seal).toHaveBeenCalledWith(
      { apiKey: "lin_secret" },
      {
        binding: "linear",
        provider: "linear",
        purpose: "provider-connection",
        recordId: first.id,
        scope: `user:${ownerUserId}`,
      },
    );
    expect(connectApiKey).toHaveBeenCalledTimes(2);
    // Every successful key connection, including a rotation, is a connected signal.
    expect(onConnectionConnected).toHaveBeenCalledTimes(2);
    expect(onConnectionConnected).toHaveBeenNthCalledWith(1, {
      connectionId: first.id,
      ownerUserId,
    });
    expect(onConnectionConnected).toHaveBeenNthCalledWith(2, {
      connectionId: first.id,
      ownerUserId,
    });
  });

  it("returns a safe check failure and creates nothing for an invalid key", async () => {
    const connectApiKey = vi.fn();
    const service = apiKeyService({
      checkHealth: vi.fn(async () => ({
        detail: "Linear rejected this key",
        healthy: false,
        status: 401,
      })),
      repository: {
        connectApiKey,
        findReusableConnectionId: vi.fn(),
      } as unknown as IntegrationRepository,
      seal: vi.fn(),
    });

    await expect(
      service.connectApiKey(
        { authMethodId: "api-key", definitionId: "linear", values: { apiKey: "invalid" } },
        { ownerUserId: createId("user"), requestId: "invalid" },
      ),
    ).rejects.toThrow("Linear rejected this key");
    expect(connectApiKey).not.toHaveBeenCalled();
  });

  it("rejects missing or unexpected named credential inputs before health checking", async () => {
    const checkHealth = vi.fn();
    const service = apiKeyService({
      checkHealth,
      repository: {} as IntegrationRepository,
      seal: vi.fn(),
    });

    await expect(
      service.connectApiKey(
        {
          authMethodId: "api-key",
          definitionId: "linear",
          values: { extra: "unexpected" },
        },
        { ownerUserId: createId("user"), requestId: "invalid-input" },
      ),
    ).rejects.toThrow("does not accept credential value extra");
    expect(checkHealth).not.toHaveBeenCalled();
  });
});

describe("IntegrationService definition resolution", () => {
  /** The exact row an approved proposal leaves behind: public manifest plus private snapshot. */
  const proposedDefinition = IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "api-key",
        inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
        kind: "api-key",
        label: "Proposed API key",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
        ],
      },
    ],
    config: { endpoint: "https://api.proposed.test/graphql" },
    description: "Researched by an agent and approved by an administrator",
    id: "proposed-inventory",
    name: "Proposed inventory",
    provider: "proposed-inventory",
  });

  function installedProposal() {
    return installedIntegrationDefinition({
      adapterSnapshot: {
        adapter: proposedDefinition.adapter,
        config: proposedDefinition.config as Readonly<Record<string, unknown>>,
        definitionId: proposedDefinition.id,
      },
      manifest: { definition: integrationDefinitionSummary(proposedDefinition) },
    });
  }

  it("connects an api-key integration that exists only as an installation", async () => {
    const checkHealth = vi.fn(async () => ({ healthy: true as const }));
    const connectApiKey = vi.fn(
      async (input: Parameters<IntegrationRepository["connectApiKey"]>[0]) =>
        IntegrationConnectionSummarySchema.parse({
          ...input.connection,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        }),
    );
    const installedDefinition = vi.fn(async (definitionId: string) =>
      definitionId === proposedDefinition.id ? installedProposal() : null,
    );
    const service = installedDefinitionService({ checkHealth, connectApiKey, installedDefinition });

    const connection = await service.connectApiKey(
      {
        authMethodId: "api-key",
        definitionId: proposedDefinition.id,
        values: { apiKey: "proposed-secret" },
      },
      { ownerUserId: createId("user"), requestId: "connect-proposed" },
    );

    expect(connection).toMatchObject({
      connectionMethod: "api-key",
      definitionId: proposedDefinition.id,
      provider: proposedDefinition.provider,
    });
    // The adapter config survives the manifest round trip only through the private snapshot.
    expect(checkHealth).toHaveBeenCalledWith({
      config: { endpoint: "https://api.proposed.test/graphql" },
      credentialValues: { apiKey: "proposed-secret" },
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    });
    expect(installedDefinition).toHaveBeenCalledWith(proposedDefinition.id);
  });

  it("requires installation before connecting a catalog API key", async () => {
    const checkHealth = vi.fn(async () => ({ healthy: true as const }));
    const connectApiKey = vi.fn(
      async (input: Parameters<IntegrationRepository["connectApiKey"]>[0]) =>
        IntegrationConnectionSummarySchema.parse({
          ...input.connection,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        }),
    );
    const installedDefinition = vi.fn(async () => null);
    const service = installedDefinitionService({
      checkHealth,
      connectApiKey,
      definitions: [proposedDefinition],
      installedDefinition,
    });

    await expect(
      service.connectApiKey(
        {
          authMethodId: "api-key",
          definitionId: proposedDefinition.id,
          values: { apiKey: "catalog-secret" },
        },
        { ownerUserId: createId("user"), requestId: "connect-catalog" },
      ),
    ).rejects.toThrow("Install this integration before connecting an API key.");
    expect(checkHealth).not.toHaveBeenCalled();
    expect(connectApiKey).not.toHaveBeenCalled();

    expect(installedDefinition).toHaveBeenCalledWith(proposedDefinition.id);
  });
});

describe("IntegrationService fixed OAuth presets", () => {
  it("requests the definition's complete scope set and accepts unrelated provider fields", async () => {
    const ownerUserId = createId("user");
    const applicationId = createIntegrationId("providerApplication");
    let attemptId = createIntegrationId("oauthAttempt");
    const attemptState = "s".repeat(43);
    const application = {
      clientId: "google-client-id",
      createdAt: "2026-08-13T12:00:00.000Z",
      displayName: "Google test application",
      encryptedSecrets: Buffer.from("sealed-application-secret"),
      encryptionKeyVersion: 1,
      id: applicationId,
      ownerUserId: null,
      provider: "google",
      revision: 1,
      status: "active" as const,
      updatedAt: "2026-08-13T12:00:00.000Z",
    };
    let attemptPayload: Readonly<Record<string, string>> | undefined;
    let attemptAuthorizationUrl = "";
    const attempts = {
      begin: vi.fn(async (input) => {
        attemptId = input.id;
        const built = await input.payload(attemptState);
        attemptAuthorizationUrl = built.authorizationUrl;
        attemptPayload = built.payload;
        return {
          attemptId,
          expiresAt: new Date("2026-08-13T12:10:00.000Z"),
          launchTicket: "t".repeat(43),
          state: attemptState,
        };
      }),
      claim: vi.fn(async () => ({
        id: attemptId,
        ownerUserId,
        payload: attemptPayload ?? {},
        surface: "desktop" as const,
      })),
      cancel: vi.fn(async () => false),
      fail: vi.fn(async () => undefined),
      identifyCallback: vi.fn(async () => attemptId),
      launch: vi.fn(async () => null),
      status: vi.fn(async () => null),
    };
    const completeOAuthAttempt = vi.fn(
      async (input: Parameters<IntegrationRepository["completeOAuthAttempt"]>[0]) =>
        IntegrationConnectionSummarySchema.parse({
          ...input.connection,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        }),
    );
    const repository = {
      completeOAuthAttempt,
      findReusableConnectionId: vi.fn(async () => null),
      getProviderApplication: vi.fn(async () => application),
      listApplicationSourceDefaults: vi.fn(async () => ({})),
      listProviderApplications: vi.fn(async () => [application]),
    } as unknown as IntegrationRepository;
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "graphql",
      authMethods: [
        {
          id: "oauth",
          kind: "oauth",
          label: "Google OAuth",
          oauth: {
            authorizationUrl: "https://accounts.example.test/authorize",
            clientAuth: "body",
            identity: {
              accountIdentifierPath: "email",
              identityPath: "id",
              source: "token-response",
            },
            scopeSeparator: " ",
            scopes: ["profile", "drive.read", "mail.read", "mail.send"],
            tokenUrl: "https://accounts.example.test/token",
            usesPkce: false,
          },
          placements: [
            {
              carrier: "header",
              name: "Authorization",
              prefix: "Bearer ",
              variable: "accessToken",
            },
          ],
        },
      ],
      config: {},
      description: "Google test integration",
      id: "google-test",
      name: "Google test",
      provider: "google",
      setupUrl: "https://example.test/setup",
    });
    const onConnectionConnected = vi.fn(async () => undefined);
    const service = new IntegrationService({
      onConnectionConnected,
      attempts,
      definitions: [definition],
      deploymentPosture: async () => "independent-self-hosted" as const,
      fetch: vi.fn(async () =>
        Response.json({
          access_token: "access-token",
          email: "alex@example.com",
          id: "google-user-1",
          scope: "profile mail.read mail.send drive.read",
          token_type: "Bearer",
        }),
      ),
      publicUrl: new URL("https://opensteer.example.test"),
      repository,
      vault: {
        open: vi.fn(async () => ({ clientSecret: "client-secret" })),
        seal: vi.fn(async () => ({ envelope: Buffer.from("sealed-token"), keyVersion: 1 })),
      },
    });

    await expect(
      service.beginAuthorization({
        definitionId: definition.id,
        ownerUserId,
        requestSurface: "personal-remote",
        returnPath: "/integrations",
        surface: "web",
      }),
    ).rejects.toMatchObject({
      code: "canonical_surface_required",
      message: canonicalAuthorizationRepair,
    });
    expect(attempts.begin).not.toHaveBeenCalled();

    const started = await service.beginAuthorization({
      definitionId: definition.id,
      ownerUserId,
      requestSurface: "canonical",
      returnPath: "/integrations",
      surface: "desktop",
    });
    expect(started).toMatchObject({ attemptId, launchTicket: "t".repeat(43) });
    expect(new URL(attemptAuthorizationUrl).searchParams.get("scope")).toBe(
      "profile drive.read mail.read mail.send",
    );
    expect(JSON.parse(attemptPayload?.payload ?? "")).toMatchObject({
      authMethodId: "oauth",
      definitionId: definition.id,
      provider: definition.provider,
    });

    const completed = await service.handleAuthorizationCallback({
      attemptId,
      browserBinding: "b".repeat(43),
      parameters: new URLSearchParams({
        authuser: "0",
        code: "authorization-code",
        future_provider_field: "accepted",
        scope: "profile drive.read mail.read mail.send",
        state: attemptState,
      }),
      provider: "google",
      state: attemptState,
    });

    expect(completed.status).toBe("completed");
    if (completed.status !== "completed") throw new Error("Expected completed authorization");
    expect(completed.connection.grantedScopes).toEqual([
      "profile",
      "mail.read",
      "mail.send",
      "drive.read",
    ]);
    expect(completed.connection.accountIdentifier).toBe("alex@example.com");
    expect(completeOAuthAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          accountIdentifier: "alex@example.com",
          definitionId: definition.id,
        }),
      }),
    );
    // The connected signal fires exactly once, after the connection is durable.
    expect(onConnectionConnected).toHaveBeenCalledExactlyOnceWith({
      connectionId: completed.connection.id,
      ownerUserId,
    });
    expect(onConnectionConnected.mock.invocationCallOrder[0]).toBeGreaterThan(
      completeOAuthAttempt.mock.invocationCallOrder[0]!,
    );
  });
});

describe("IntegrationService OAuth refresh", () => {
  it("collapses concurrent refreshes to one provider exchange", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const applicationId = createIntegrationId("providerApplication");
    const definition = refreshDefinition();
    const connection = IntegrationConnectionSummarySchema.parse({
      accountIdentifier: "account@example.com",
      applicationSource: {
        callbackUrl: "https://host.example/v1/integrations/oauth/callback/example",
        kind: "deployment-oauth",
        providerApplicationId: applicationId,
        providerApplicationRevision: 1,
      },
      authMethodId: "oauth",
      authorizationDigest: authorizationDigest(definition),
      computer: null,
      connectionMethod: "managed-oauth",
      createdAt: "2026-08-13T12:00:00.000Z",
      definitionId: definition.id,
      displayName: "Example account",
      externalIdentityId: "account-1",
      externalTenantId: null,
      grantedScopes: ["openid", "email"],
      id: connectionId,
      provider: "example",
      providerApplicationId: applicationId,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-08-13T12:00:00.000Z",
    });
    const providerFetch = vi.fn(async () =>
      Response.json(
        {
          access_token: "new-access-token",
          expires_in: 3600,
          refresh_token: "rotated-refresh-token",
          scope: "openid email",
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      ),
    );
    const replaceConnectionCredential = vi.fn(async () => true);
    const markConnectionNeedsAttention = vi.fn(async () => undefined);
    const repository = {
      getConnectionForAccess: vi.fn(async () => ({
        connection,
        credentialGeneration: 1,
        encryptedCredential: Buffer.from("connection"),
        encryptionKeyVersion: 1,
        providerApplication: {
          clientId: "client-id",
          createdAt: connection.createdAt,
          displayName: "Example app",
          encryptedSecrets: Buffer.from("application"),
          encryptionKeyVersion: 1,
          id: applicationId,
          ownerUserId: null,
          provider: "example",
          revision: 1,
          status: "active" as const,
          updatedAt: connection.updatedAt,
        },
      })),
      markConnectionNeedsAttention,
      listApplicationSourceDefaults: vi.fn(async () => ({})),
      listProviderApplications: vi.fn(async () => [
        {
          clientId: "client-id",
          createdAt: connection.createdAt,
          displayName: "Example app",
          encryptedSecrets: Buffer.from("application"),
          encryptionKeyVersion: 1,
          id: applicationId,
          ownerUserId: null,
          provider: "example",
          revision: 1,
          status: "active" as const,
          updatedAt: connection.updatedAt,
        },
      ]),
      recordConnectionAccess: vi.fn(async () => undefined),
      replaceConnectionCredential,
    } as unknown as IntegrationRepository;
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      definitions: [definition],
      deploymentPosture: async () => "independent-self-hosted" as const,
      fetch: providerFetch,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      publicUrl: new URL("https://host.example"),
      repository,
      vault: {
        open: vi.fn(async (envelope: Buffer) =>
          envelope.toString() === "application"
            ? { clientSecret: "client-secret" }
            : {
                accessToken: "expired-access-token",
                expiresAt: "1",
                refreshToken: "refresh-token",
                tokenType: "Bearer",
              },
        ),
        seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
      },
    });
    const request = {
      connectionId,
      operation: "identity.get",
      ownerUserId,
    } as const;
    const [first, second] = await Promise.all([
      service.materializeForAdapter(request),
      service.materializeForAdapter(request),
    ]);
    expect(first.credentialValues).toEqual({ accessToken: "new-access-token" });
    expect(second.credentialValues).toEqual(first.credentialValues);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(replaceConnectionCredential).toHaveBeenCalledTimes(1);

    providerFetch.mockResolvedValueOnce(
      Response.json({
        access_token: "reduced-access-token",
        expires_in: 3600,
        scope: "openid",
        token_type: "Bearer",
      }),
    );
    await expect(service.materializeForAdapter({ ...request, forceRefresh: true })).rejects.toThrow(
      "Missing OAuth scopes: email. Reconnect this account and approve every requested permission.",
    );
    expect(markConnectionNeedsAttention).toHaveBeenLastCalledWith({
      connectionId,
      expectedGeneration: 1,
      ownerUserId,
      statusDetail:
        "Missing OAuth scopes: email. Reconnect this account and approve every requested permission.",
    });
  });

  it.each([
    {
      error: "invalid_grant",
      name: "a rejected grant marks the connection and demands reauthorization",
      marked:
        "The provider rejected this account's sign-in grant (invalid_grant); reconnect this account.",
      message: "Reauthorization required",
    },
    {
      error: "invalid_client",
      name: "a rejected OAuth application never sends the owner to a pointless reconnect",
      marked: null,
      message:
        "The example OAuth application was rejected by the provider (invalid_client); reconnecting accounts will not fix this.",
    },
  ])("$name", async ({ error, marked, message }) => {
    const harness = deploymentRefreshHarness();
    harness.providerFetch.mockResolvedValue(Response.json({ error }, { status: 400 }));

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toThrow(message);

    if (marked === null) {
      expect(harness.markConnectionNeedsAttention).not.toHaveBeenCalled();
    } else {
      expect(harness.markConnectionNeedsAttention).toHaveBeenCalledExactlyOnceWith({
        connectionId: harness.connectionId,
        expectedGeneration: 1,
        ownerUserId: harness.ownerUserId,
        statusDetail: marked,
      });
    }
  });

  it("leaves the connection alone when the provider token endpoint is merely down", async () => {
    const harness = deploymentRefreshHarness();
    harness.providerFetch.mockResolvedValue(Response.json({}, { status: 503 }));

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toMatchObject({
      code: "workspace_unavailable",
      retryable: true,
    });
    expect(harness.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });
});

describe("IntegrationService hosted OAuth refresh", () => {
  it("round-trips a hosted refresh through the broker contract and keeps the connection connected", async () => {
    const broker = hostedRefreshBroker({ status: "sealed" });
    const harness = hostedRefreshHarness(broker);

    const materialized = await harness.service.materializeForAdapter(harness.request);

    expect(materialized.credentialValues).toEqual({ accessToken: "hosted-access-token" });
    expect(broker.sealedRefreshToken()).toEqual({ refreshToken: "refresh-token" });
    expect(harness.replaceConnectionCredential).toHaveBeenCalledOnce();
    expect(broker.acknowledgeRefresh).toHaveBeenCalledOnce();
    expect(harness.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });

  it("names the scopes a hosted refresh came back without", async () => {
    const harness = hostedRefreshHarness(
      hostedRefreshBroker({ grantedScopes: ["openid"], status: "sealed" }),
    );

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toThrow(
      "Missing OAuth scopes: email. Reconnect this account and approve every requested permission.",
    );
    expect(harness.markConnectionNeedsAttention).toHaveBeenCalledExactlyOnceWith({
      connectionId: harness.connectionId,
      expectedGeneration: 1,
      ownerUserId: harness.ownerUserId,
      statusDetail:
        "Missing OAuth scopes: email. Reconnect this account and approve every requested permission.",
    });
  });

  it("marks the connection only when the broker reports a rejected grant", async () => {
    const harness = hostedRefreshHarness(
      hostedRefreshBroker({
        failureCode: "grant-rejected",
        providerError: "invalid_grant",
        status: "failed",
      }),
    );

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toMatchObject({
      code: "conflict",
      message: "Reauthorization required",
    });
    expect(harness.markConnectionNeedsAttention).toHaveBeenCalledExactlyOnceWith({
      connectionId: harness.connectionId,
      expectedGeneration: 1,
      ownerUserId: harness.ownerUserId,
      statusDetail: expect.stringContaining("invalid_grant"),
    });
  });

  it.each([
    {
      failureCode: "client-rejected" as const,
      message: "reconnecting accounts will not fix this",
      name: "a rejected hosted OAuth application is the operator's to fix",
      providerError: "invalid_client",
      retryable: false,
    },
    {
      failureCode: "provider-exchange-failed" as const,
      message: "this may be temporary",
      name: "an unclassified broker refusal stays retryable",
      providerError: null,
      retryable: true,
    },
  ])("$name", async ({ failureCode, message, providerError, retryable }) => {
    const harness = hostedRefreshHarness(
      hostedRefreshBroker({ failureCode, providerError, status: "failed" }),
    );

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toMatchObject({
      message: expect.stringContaining(message),
      retryable,
    });
    expect(harness.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });

  it("leaves the connection alone when the broker itself is unreachable", async () => {
    const broker = hostedRefreshBroker({ status: "sealed" });
    broker.refresh.mockRejectedValueOnce(
      new Error("Opensteer hosted OAuth service returned HTTP 503"),
    );
    const harness = hostedRefreshHarness(broker);

    await expect(harness.service.materializeForAdapter(harness.request)).rejects.toThrow(
      "Opensteer hosted OAuth service returned HTTP 503",
    );
    expect(harness.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });
});

describe("IntegrationService OAuth source authority", () => {
  const applicationId = createIntegrationId("providerApplication");
  const application = {
    clientId: "deployment-client-id",
    createdAt: "2026-08-20T12:00:00.000Z",
    displayName: "Deployment OAuth",
    encryptedSecrets: Buffer.from("sealed-application-secret"),
    encryptionKeyVersion: 1,
    id: applicationId,
    ownerUserId: null,
    provider: "example",
    revision: 3,
    status: "active" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  };

  it.each([
    {
      expectedCode: "READY",
      expectedKind: "hosted-oauth",
      hosted: true,
      name: "linked Personal deployments use hosted OAuth",
      posture: "account-linked-personal" as const,
      providerApplications: [],
      saved: {},
    },
    {
      expectedCode: "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED",
      expectedKind: null,
      hosted: false,
      name: "account-free Personal deployments require an explicit authority choice",
      posture: "account-free-personal" as const,
      providerApplications: [],
      saved: {},
    },
    {
      expectedCode: "READY",
      expectedKind: "deployment-oauth",
      hosted: false,
      name: "independent self-hosted deployments use their own OAuth app",
      posture: "independent-self-hosted" as const,
      providerApplications: [application],
      saved: {},
    },
    {
      expectedCode: "PROVIDER_APPLICATION_REQUIRED",
      expectedKind: null,
      hosted: true,
      name: "an unavailable saved deployment source never falls back to hosted OAuth",
      posture: "account-linked-personal" as const,
      providerApplications: [],
      saved: { example: "deployment-oauth" as const },
    },
    {
      expectedCode: "READY",
      expectedKind: "hosted-oauth",
      hosted: true,
      name: "an injected managed service is the default for an account-attached server",
      posture: "account-adopted-self-hosted" as const,
      providerApplications: [application],
      saved: {},
    },
  ])(
    "$name",
    async ({ expectedCode, expectedKind, hosted, posture, providerApplications, saved }) => {
      const service = oauthAuthorityService({ hosted, posture, providerApplications, saved });

      const authorization = (await service.providerAuthorizations(createId("user"))).example;

      expect(authorization).toMatchObject({ code: expectedCode });
      expect(authorization?.selectedSource?.kind ?? null).toBe(expectedKind);
    },
  );

  it("does not advertise a mismatched managed revision and visibly selects the sole custom app", async () => {
    const service = oauthAuthorityService({
      hosted: true,
      metadataRevision: 2,
      posture: "account-linked-personal",
      providerApplications: [application],
      saved: {},
    });

    const authorization = (await service.providerAuthorizations(createId("user"))).example;

    expect(authorization).toMatchObject({
      code: "READY",
      hostedOAuthStatus: "available",
      selectedSource: { kind: "deployment-oauth" },
    });
    expect(authorization?.availableSources.map(({ kind }) => kind)).toEqual(["deployment-oauth"]);
  });

  it("keeps exact custom sources without silently selecting one during a metadata outage", async () => {
    const service = oauthAuthorityService({
      hosted: true,
      metadataUnavailable: true,
      posture: "account-linked-personal",
      providerApplications: [application],
      saved: {},
    });

    const authorization = (await service.providerAuthorizations(createId("user"))).example;

    expect(authorization).toMatchObject({
      code: "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE",
      hostedOAuthStatus: "temporarily-unavailable",
      selectedSource: null,
    });
    expect(authorization?.availableSources.map(({ kind }) => kind)).toEqual(["deployment-oauth"]);
  });

  it.each([
    {
      expectedAvailableKinds: ["hosted-oauth"],
      expectedCode: "CANONICAL_SURFACE_REQUIRED",
      expectedKind: "hosted-oauth",
      hosted: true,
      name: "hands hosted OAuth authorization back to the owner computer",
      posture: "account-linked-personal" as const,
      providerApplications: [],
      saved: {},
    },
    {
      expectedAvailableKinds: ["deployment-oauth"],
      expectedCode: "CANONICAL_SURFACE_REQUIRED",
      expectedKind: "deployment-oauth",
      hosted: false,
      name: "projects deployment OAuth as local-computer-only from a Personal remote surface",
      posture: "independent-self-hosted" as const,
      providerApplications: [application],
      saved: {},
    },
    {
      expectedAvailableKinds: ["hosted-oauth", "deployment-oauth"],
      expectedCode: "CANONICAL_SURFACE_REQUIRED",
      expectedKind: "deployment-oauth",
      hosted: true,
      name: "never falls back to hosted OAuth when the saved source is deployment OAuth",
      posture: "account-linked-personal" as const,
      providerApplications: [application],
      saved: { example: "deployment-oauth" as const },
    },
  ])(
    "$name",
    async ({
      expectedAvailableKinds,
      expectedCode,
      expectedKind,
      hosted,
      posture,
      providerApplications,
      saved,
    }) => {
      const service = oauthAuthorityService({ hosted, posture, providerApplications, saved });

      const dashboard = await service.dashboard(createId("user"), true, "personal-remote");
      const authorization = dashboard.providerAuthorizations.example;

      expect(dashboard.authorizationSurface).toBe("personal-remote");
      expect(authorization).toMatchObject({
        code: expectedCode,
        detail: canonicalAuthorizationRepair,
      });
      // The administrator picker renders from these, so the surface must not blank them.
      expect(authorization?.availableSources.map(({ kind }) => kind)).toEqual(
        expectedAvailableKinds,
      );
      expect(authorization?.selectedSource?.kind ?? null).toBe(expectedKind);
      expect(authorization?.availableSources).toEqual(
        (await service.providerAuthorizations(createId("user"))).example?.availableSources,
      );
    },
  );

  it("rejects hosted provider authorization from a Personal remote surface", async () => {
    const service = oauthAuthorityService({
      hosted: true,
      posture: "account-linked-personal",
      providerApplications: [],
      saved: {},
    });

    await expect(
      service.beginAuthorization({
        definitionId: "example",
        ownerUserId: createId("user"),
        requestSurface: "personal-remote",
        returnPath: "/integrations",
        surface: "web",
      }),
    ).rejects.toMatchObject({ code: "canonical_surface_required" });
  });

  it("projects stale pinned OAuth sources as needing attention before execution", async () => {
    const connection = IntegrationConnectionSummarySchema.parse({
      accountIdentifier: "account@example.com",
      applicationSource: {
        brokerIssuer: "https://account.example.test",
        kind: "hosted-oauth",
        providerApplicationRevision: 2,
      },
      authMethodId: "oauth",
      authorizationDigest: authorizationDigest(refreshDefinition()),
      computer: null,
      connectionMethod: "managed-oauth",
      createdAt: "2026-08-20T12:00:00.000Z",
      definitionId: "example",
      displayName: "Example account",
      externalIdentityId: "subject-1",
      externalTenantId: null,
      grantedScopes: ["openid", "email"],
      id: createIntegrationId("connection"),
      provider: "example",
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const service = oauthAuthorityService({
      connections: [connection],
      hosted: true,
      posture: "account-linked-personal",
      providerApplications: [],
      saved: {},
    });

    const dashboard = await service.dashboard(createId("user"), true, "personal-remote");

    expect(dashboard.connections[0]).toMatchObject({
      status: "needs-attention",
      statusDetail: integrationApplicationSourceUnavailableDetail,
    });
  });

  // The ways it could fail: an account waiting only for permissions keeps
  // that reason once its OAuth app is gone, so a client offers the repository
  // step the Host then refuses instead of a sign-in; an account that needs
  // attention for another reason loses the Host's more precise words.
  it.each([
    [
      "waiting for permissions",
      {
        statusDetail: "Check repository access to finish connecting GitHub.",
        statusReason: "permissions",
      },
      { statusDetail: integrationApplicationSourceUnavailableDetail, statusReason: null },
    ],
    [
      "needing a sign-in for its own reason",
      { statusDetail: "Link Opensteer Account or Use your own OAuth app", statusReason: null },
      { statusDetail: "Link Opensteer Account or Use your own OAuth app", statusReason: null },
    ],
  ] as const)(
    "projects an account %s whose OAuth app is gone",
    async (_label, stored, projected) => {
      const connection = IntegrationConnectionSummarySchema.parse({
        accountIdentifier: "account@example.com",
        applicationSource: {
          brokerIssuer: "https://account.example.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 2,
        },
        authMethodId: "oauth",
        authorizationDigest: authorizationDigest(refreshDefinition()),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-08-20T12:00:00.000Z",
        definitionId: "example",
        displayName: "Example account",
        externalIdentityId: "subject-1",
        externalTenantId: null,
        grantedScopes: ["openid", "email"],
        id: createIntegrationId("connection"),
        provider: "example",
        providerApplicationId: null,
        status: "needs-attention",
        ...stored,
        updatedAt: "2026-08-20T12:00:00.000Z",
      });
      const service = oauthAuthorityService({
        connections: [connection],
        hosted: true,
        posture: "account-linked-personal",
        providerApplications: [],
        saved: {},
      });

      const dashboard = await service.dashboard(createId("user"), true, "canonical");

      expect(dashboard.connections[0]).toMatchObject({ status: "needs-attention", ...projected });
    },
  );

  it("leaves a paused connection paused instead of relabelling it needs-attention", async () => {
    const connection = IntegrationConnectionSummarySchema.parse({
      accountIdentifier: "account@example.com",
      applicationSource: {
        brokerIssuer: "https://account.example.test",
        kind: "hosted-oauth",
        providerApplicationRevision: 2,
      },
      authMethodId: "oauth",
      authorizationDigest: authorizationDigest(refreshDefinition()),
      computer: null,
      connectionMethod: "managed-oauth",
      createdAt: "2026-08-20T12:00:00.000Z",
      definitionId: "example",
      displayName: "Example account",
      externalIdentityId: "subject-1",
      externalTenantId: null,
      grantedScopes: ["openid", "email"],
      id: createIntegrationId("connection"),
      provider: "example",
      providerApplicationId: null,
      status: "paused",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const service = oauthAuthorityService({
      connections: [connection],
      hosted: true,
      posture: "account-linked-personal",
      providerApplications: [],
      saved: {},
    });

    const dashboard = await service.dashboard(createId("user"), true, "canonical");

    expect(dashboard.connections[0]).toMatchObject({ status: "paused", statusDetail: null });
  });

  it("rejects execution when the exact hosted source pinned to a connection is unavailable", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const markConnectionNeedsAttention = vi.fn(async () => undefined);
    const open = vi.fn();
    const connection = IntegrationConnectionSummarySchema.parse({
      accountIdentifier: "account@example.com",
      applicationSource: {
        brokerIssuer: "https://account.example.test",
        kind: "hosted-oauth",
        providerApplicationRevision: 1,
      },
      authMethodId: "oauth",
      authorizationDigest: authorizationDigest(refreshDefinition()),
      computer: null,
      connectionMethod: "managed-oauth",
      createdAt: "2026-08-20T12:00:00.000Z",
      definitionId: "example",
      displayName: "Hosted account",
      externalIdentityId: "subject-1",
      externalTenantId: null,
      grantedScopes: ["openid", "email"],
      id: connectionId,
      provider: "example",
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      definitions: [refreshDefinition()],
      deploymentPosture: async () => "account-free-personal",
      publicUrl: new URL("https://host.example.test"),
      repository: {
        getConnectionForAccess: vi.fn(async () => ({
          connection,
          credentialGeneration: 1,
          encryptedCredential: Buffer.from("credential"),
          encryptionKeyVersion: 1,
          providerApplication: null,
        })),
        listApplicationSourceDefaults: vi.fn(async () => ({ example: "hosted-oauth" as const })),
        listProviderApplications: vi.fn(async () => []),
        markConnectionNeedsAttention,
      } as unknown as IntegrationRepository,
      vault: { open } as never,
    });

    await expect(
      service.materializeForAdapter({
        connectionId,
        operation: "identity.get",
        ownerUserId,
      }),
    ).rejects.toThrow(integrationApplicationSourceUnavailableDetail);
    expect(markConnectionNeedsAttention).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("IntegrationService hosted OAuth failures", () => {
  it.each(["hosted-oauth", "callback-relay"] as const)(
    "rejects a timestamp account link generation before starting a %s attempt",
    async (flow) => {
      const ownerUserId = createId("user");
      const applicationId = createIntegrationId("providerApplication");
      const attempts = { begin: vi.fn() };
      const createAttempt = vi.fn();
      const createCallbackRelay = vi.fn();
      const baseDefinition = refreshDefinition();
      const definition =
        flow === "hosted-oauth"
          ? baseDefinition
          : IntegrationDefinitionSchema.parse({
              ...baseDefinition,
              id: "slack-test",
              name: "Slack test",
              provider: "slack",
            });
      const provider = definition.provider;
      const application = {
        clientId: "deployment-client-id",
        createdAt: "2026-08-20T12:00:00.000Z",
        displayName: "Deployment OAuth",
        encryptedSecrets: Buffer.from("sealed-application-secret"),
        encryptionKeyVersion: 1,
        id: applicationId,
        ownerUserId: null,
        provider,
        revision: 1,
        status: "active" as const,
        updatedAt: "2026-08-20T12:00:00.000Z",
      };
      const service = new IntegrationService({
        onConnectionConnected: vi.fn(async () => undefined),
        attempts: attempts as never,
        definitions: [definition],
        deploymentPosture: async () => "account-linked-personal" as const,
        hostedOAuth: {
          accountSubject: vi.fn(async () => ({
            issuer: "https://account.example.test",
            // Older cloud releases accidentally returned the link timestamp here.
            linkGeneration: "2026-08-20T12:00:00.000Z",
            subject: `acct_${crypto.randomUUID()}`,
          })) as never,
          broker: {
            callbackUrl: vi.fn(() => `https://account.example.test/oauth/callback/${provider}`),
            createAttempt,
            createCallbackRelay,
            issuer: "https://account.example.test",
            metadata: vi.fn(async () => ({
              callbackRelayProviders: flow === "callback-relay" ? [provider] : [],
              providerRevisions: { [provider]: 1 },
            })),
          } as never,
          deploymentAuthorityDigest: "D".repeat(43),
        },
        publicUrl: new URL(
          flow === "callback-relay" ? "http://host.example.test" : "https://host.example.test",
        ),
        repository: {
          getProviderApplication: vi.fn(async () => application),
          listApplicationSourceDefaults: vi.fn(async () => ({
            [provider]: flow === "hosted-oauth" ? "hosted-oauth" : "deployment-oauth",
          })),
          listProviderApplications: vi.fn(async () =>
            flow === "callback-relay" ? [application] : [],
          ),
        } as unknown as IntegrationRepository,
        vault: {} as never,
      });

      const error = await service
        .beginAuthorization({
          definitionId: definition.id,
          ownerUserId,
          requestSurface: "canonical",
          returnPath: "/integrations",
          surface: "desktop",
        })
        .then(
          () => null,
          (cause: unknown) => cause,
        );

      expect(error).toBeInstanceOf(OpensteerError);
      expect(error).toMatchObject({
        code: "internal",
        message: "This deployment's Opensteer Account binding is invalid",
      });
      expect(createAttempt).not.toHaveBeenCalled();
      expect(createCallbackRelay).not.toHaveBeenCalled();
      expect(attempts.begin).not.toHaveBeenCalled();
    },
  );

  it("honors the persisted deployment OAuth default when the request omits a source", async () => {
    const ownerUserId = createId("user");
    const applicationId = createIntegrationId("providerApplication");
    const attemptId = createIntegrationId("oauthAttempt");
    let attemptPayload: Readonly<Record<string, string>> = {};
    const attempts = {
      begin: vi.fn(async (input) => {
        attemptPayload = (await input.payload("oauth-state")).payload;
        return {
          attemptId,
          expiresAt: new Date("2026-08-20T12:10:00.000Z"),
          launchTicket: "L".repeat(43),
        };
      }),
    };
    const createAttempt = vi.fn();
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: attempts as never,
      definitions: [refreshDefinition()],
      deploymentPosture: async () => "account-linked-personal" as const,
      hostedOAuth: {
        accountSubject: vi.fn(async () => ({
          issuer: "https://account.example.test",
          linkGeneration: "G".repeat(43),
          subject: `acct_${crypto.randomUUID()}`,
        })) as never,
        broker: {
          createAttempt,
          issuer: "https://account.example.test",
          metadata: vi.fn(async () => ({
            callbackRelayProviders: [],
            providerRevisions: { example: 1 },
          })),
        } as never,
        deploymentAuthorityDigest: "D".repeat(43),
      },
      publicUrl: new URL("https://host.example.test"),
      repository: {
        getProviderApplication: vi.fn(async () => ({
          clientId: "deployment-client-id",
          createdAt: "2026-08-20T12:00:00.000Z",
          displayName: "Deployment OAuth",
          encryptedSecrets: Buffer.from("sealed-application-secret"),
          encryptionKeyVersion: 1,
          id: applicationId,
          ownerUserId: null,
          provider: "example",
          revision: 1,
          status: "active",
          updatedAt: "2026-08-20T12:00:00.000Z",
        })),
        listApplicationSourceDefaults: vi.fn(async () => ({
          example: "deployment-oauth" as const,
        })),
        listProviderApplications: vi.fn(async () => [
          {
            clientId: "deployment-client-id",
            createdAt: "2026-08-20T12:00:00.000Z",
            displayName: "Deployment OAuth",
            encryptedSecrets: Buffer.from("sealed-application-secret"),
            encryptionKeyVersion: 1,
            id: applicationId,
            ownerUserId: null,
            provider: "example",
            revision: 1,
            status: "active" as const,
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
        ]),
      } as unknown as IntegrationRepository,
      vault: {} as never,
    });

    await service.beginAuthorization({
      definitionId: "example",
      ownerUserId,
      requestSurface: "canonical",
      returnPath: "/integrations",
      surface: "desktop",
    });

    expect(JSON.parse(attemptPayload.payload ?? "")).toMatchObject({
      applicationSource: "deployment-oauth",
      providerApplicationId: applicationId,
    });
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it.each([
    { identity: "userinfo", ackFails: false, persists: true, pullFailure: null },
    { identity: "token-response", ackFails: false, persists: true, pullFailure: null },
    { identity: "userinfo", ackFails: true, persists: true, pullFailure: null },
    { identity: "userinfo", ackFails: false, persists: false, pullFailure: null },
    { identity: "userinfo", ackFails: false, persists: false, pullFailure: "expired" },
    { identity: "userinfo", ackFails: false, persists: false, pullFailure: "client-rejected" },
  ] as const)(
    "finishes from durable state: $identity, ACK failure=$ackFails, persisted=$persists, pull=$pullFailure",
    async ({ identity, ackFails, persists, pullFailure }) => {
      const ownerUserId = createId("user");
      const original = refreshDefinition();
      const definition =
        identity === "userinfo"
          ? original
          : {
              ...original,
              authMethods: original.authMethods.map((method) =>
                method.kind === "oauth"
                  ? {
                      ...method,
                      oauth: {
                        ...method.oauth,
                        identity: {
                          source: "token-response" as const,
                          identityPath: "bot_user_id",
                          tenantPath: "team.id",
                        },
                      },
                    }
                  : method,
              ),
            };
      let savedConnectionId: IntegrationConnectionId | null = null;
      const accountSubject = `acct_${crypto.randomUUID()}`;
      let storedPayload: Readonly<Record<string, string>> = {};
      let brokerRequest: Record<string, unknown> = {};
      const attemptId = createIntegrationId("oauthAttempt");
      const expiresAt = new Date("2026-08-20T12:10:00.000Z");
      const attempts = {
        begin: vi.fn(async (input) => {
          storedPayload = (await input.payload("unused-local-state")).payload;
          return { attemptId, expiresAt, launchTicket: "L".repeat(43) };
        }),
        claimHosted: vi.fn(async () => ({
          id: attemptId,
          ownerUserId,
          payload: storedPayload,
          surface: "web" as const,
        })),
        fail: vi.fn(async () => undefined),
        inspect: vi.fn(async () => storedPayload),
        status: vi.fn(async () =>
          savedConnectionId
            ? { connectionId: savedConnectionId, expiresAt, status: "completed" as const }
            : { expiresAt, status: "launched" as const },
        ),
      };
      // Every hop crosses the real protocol schemas the broker client parses, so a request the Host
      // sends with a field the contract does not carry fails here instead of in production.
      const broker = {
        acknowledge: vi.fn(async () => {
          if (ackFails) throw new Error("broker acknowledgement unavailable");
        }),
        createAttempt: vi.fn(async (input: unknown) => {
          brokerRequest = CreateHostedOAuthAttemptRequestSchema.parse(input);
          return CreateHostedOAuthAttemptResponseSchema.parse({
            attemptId: brokerRequest.attemptId,
            expiresAt: brokerRequest.expiresAt,
            launchUrl: "https://account.example.test/launch",
          });
        }),
        issuer: "https://account.example.test",
        metadata: vi.fn(async () => ({
          callbackRelayProviders: [],
          providerRevisions: { example: 1 },
        })),
        pull: vi.fn(async () => {
          const context = {
            accountSubject: brokerRequest.accountSubject,
            attemptId: brokerRequest.attemptId,
            authorizationDigest: brokerRequest.authorizationDigest,
            definitionId: brokerRequest.definitionId,
            deploymentAuthorityDigest: brokerRequest.deploymentAuthorityDigest,
            expiresAt: brokerRequest.expiresAt,
            providerApplicationRevision: brokerRequest.providerApplicationRevision,
            schemaVersion: 1,
          };
          if (pullFailure)
            return PullHostedOAuthResultResponseSchema.parse({
              attemptId: brokerRequest.attemptId,
              expiresAt: brokerRequest.expiresAt,
              failureCode: pullFailure === "expired" ? null : pullFailure,
              retryGeneration: 1,
              sealedResult: null,
              status: pullFailure === "expired" ? "expired" : "failed",
            });
          return PullHostedOAuthResultResponseSchema.parse({
            attemptId: brokerRequest.attemptId,
            expiresAt: brokerRequest.expiresAt,
            failureCode: null,
            retryGeneration: 1,
            sealedResult: sealOAuthBrokerPayload(
              {
                accessToken: "host-only-access-token",
                grantedScopes: ["openid", "email"],
                refreshToken: "host-only-refresh-token",
                tokenType: "Bearer",
                ...(identity === "token-response"
                  ? {
                      tokenResponseIdentity: {
                        externalIdentityId: "subject-1",
                        externalTenantId: "team-1",
                      },
                    }
                  : {}),
              },
              String(brokerRequest.hostPublicKey),
              context,
            ),
            status: "sealed",
          });
        }),
        status: vi.fn(async () => ({ status: "sealed" as const })),
      };
      const completeOAuthAttempt = vi.fn(
        async (input: { readonly connection: { readonly id: IntegrationConnectionId } }) => {
          if (persists) savedConnectionId = input.connection.id;
        },
      );
      const seal = vi.fn(async () => ({ envelope: Buffer.from("host-vault"), keyVersion: 1 }));
      const onConnectionConnected = vi.fn(async () => undefined);
      const service = new IntegrationService({
        onConnectionConnected,
        attempts: attempts as never,
        definitions: [definition],
        deploymentPosture: async () => "account-linked-personal" as const,
        fetch: vi.fn(async () => Response.json({ name: "Hosted user", sub: "subject-1" })),
        hostedOAuth: {
          accountSubject: vi.fn(async () => ({
            issuer: "https://account.example.test",
            linkGeneration: "G".repeat(43),
            subject: accountSubject,
          })) as never,
          broker: broker as never,
          deploymentAuthorityDigest: "D".repeat(43),
        },
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        publicUrl: new URL("https://host.example.test"),
        repository: {
          completeOAuthAttempt,
          findReusableConnectionId: vi.fn(async () => null),
          listApplicationSourceDefaults: vi.fn(async () => ({})),
          listProviderApplications: vi.fn(async () => []),
        } as unknown as IntegrationRepository,
        vault: { seal } as never,
      });

      await service.beginAuthorization({
        applicationSource: "hosted-oauth",
        definitionId: definition.id,
        ownerUserId,
        requestSurface: "canonical",
        returnPath: "/integrations",
        surface: "web",
      });
      broker.pull.mockRejectedValueOnce(new Error("lost broker response"));
      await expect(service.authorizationStatus({ attemptId, ownerUserId })).rejects.toThrow(
        "lost broker response",
      );
      expect(attempts.fail).not.toHaveBeenCalled();
      expect(onConnectionConnected).not.toHaveBeenCalled();
      if (pullFailure) {
        await expect(service.authorizationStatus({ attemptId, ownerUserId })).rejects.toMatchObject(
          { reason: pullFailure },
        );
        expect(attempts.fail).toHaveBeenCalledWith(attemptId, pullFailure);
        expect(completeOAuthAttempt).not.toHaveBeenCalled();
        return;
      }
      const completionStatus = await service.authorizationStatus({ attemptId, ownerUserId });
      expect(completionStatus).toEqual({
        expiresAt,
        ...(persists
          ? { connectionId: savedConnectionId, status: "completed" }
          : { status: "launched" }),
      });
      expect(attempts.fail).not.toHaveBeenCalled();
      // A hosted completion happens inside the status poll, with no browser
      // callback: the connected signal must fire here, before "completed" is
      // reported, so a poller sees a settled world.
      expect(onConnectionConnected).toHaveBeenCalledExactlyOnceWith({
        connectionId: completeOAuthAttempt.mock.calls[0]![0].connection.id,
        ownerUserId,
      });
      expect(seal).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "host-only-access-token",
          refreshToken: "host-only-refresh-token",
        }),
        expect.objectContaining({ purpose: "provider-connection" }),
      );
      expect(completeOAuthAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: expect.objectContaining({
            applicationSource: {
              brokerIssuer: "https://account.example.test",
              kind: "hosted-oauth",
              providerApplicationRevision: 1,
            },
            externalIdentityId: "subject-1",
          }),
        }),
      );
      expect(broker.acknowledge).toHaveBeenCalledOnce();
    },
  );

  it.each(["outage", "client-rejected", "invalid-provider-response", "expired"] as const)(
    "preserves durable authorization status after %s",
    async (outcome) => {
      const ownerUserId = createId("user");
      const attemptId = createIntegrationId("oauthAttempt");
      const brokerAttemptId = `hoa_${attemptId.slice("ioa_".length)}`;
      const accountSubject = `acct_${crypto.randomUUID()}`;
      const expiresAt = new Date("2026-08-20T12:10:00.000Z");
      let savedFailure: string | null = null;
      const localStatus = () =>
        savedFailure === null
          ? { expiresAt, status: "launched" as const }
          : savedFailure === "expired"
            ? { expiresAt, status: "expired" as const }
            : { expiresAt, failureCode: savedFailure, status: "failed" as const };
      const attempts = {
        fail: vi.fn(async (_id: string, reason: string) => {
          savedFailure = reason;
        }),
        inspect: vi.fn(async () => ({
          payload: JSON.stringify({
            accountIssuer: "https://account.example.test",
            accountLinkGeneration: "G".repeat(43),
            accountSubject,
            applicationSource: "hosted-oauth",
            authMethodId: "oauth",
            authorizationDigest: "A".repeat(43),
            brokerAttemptId,
            brokerExpiresAt: expiresAt.toISOString(),
            definitionId: "google-gmail",
            deploymentAuthorityDigest: "D".repeat(43),
            hostPrivateKey: "private-host-attempt-key",
            provider: "google",
            providerApplicationRevision: 1,
            returnPath: "/integrations",
          }),
        })),
        status: vi.fn(async () => localStatus()),
      };
      const service = new IntegrationService({
        onConnectionConnected: vi.fn(async () => undefined),
        attempts: attempts as never,
        deploymentPosture: async () => "account-linked-personal" as const,
        hostedOAuth: {
          accountSubject: vi.fn(async () => ({
            issuer: "https://account.example.test",
            linkGeneration: "G".repeat(43),
            subject: accountSubject,
          })) as never,
          broker: {
            issuer: "https://account.example.test",
            status: vi.fn(async () => {
              if (outcome === "outage") throw new Error("broker unavailable");
              return {
                status: outcome === "expired" ? "expired" : "failed",
                failureCode: outcome === "expired" ? null : outcome,
              };
            }),
          } as never,
          deploymentAuthorityDigest: "D".repeat(43),
        },
        publicUrl: new URL("https://host.example.test"),
        repository: {} as IntegrationRepository,
        vault: {} as never,
      });

      const first = await service.authorizationStatus({ attemptId, ownerUserId });
      expect(first).toEqual(localStatus());
      expect(savedFailure).toBe(outcome === "outage" ? null : outcome);
      await expect(service.authorizationStatus({ attemptId, ownerUserId })).resolves.toEqual(first);
    },
  );

  it("preserves a durable hosted completion after the broker runtime is removed", async () => {
    const ownerUserId = createId("user");
    const attemptId = createIntegrationId("oauthAttempt");
    const connectionId = createIntegrationId("connection");
    const expiresAt = new Date("2026-08-20T12:10:00.000Z");
    const completed = { connectionId, expiresAt, status: "completed" as const };
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {
        inspect: vi.fn(async () => ({
          payload: JSON.stringify({
            accountIssuer: "https://account.example.test",
            accountLinkGeneration: "G".repeat(43),
            accountSubject: `acct_${crypto.randomUUID()}`,
            applicationSource: "hosted-oauth",
            authMethodId: "oauth",
            authorizationDigest: "A".repeat(43),
            brokerAttemptId: `hoa_${attemptId.slice("ioa_".length)}`,
            brokerExpiresAt: expiresAt.toISOString(),
            definitionId: "google-gmail",
            deploymentAuthorityDigest: "D".repeat(43),
            hostPrivateKey: "private-host-attempt-key",
            provider: "google",
            providerApplicationRevision: 1,
            returnPath: "/integrations",
          }),
        })),
        status: vi.fn(async () => completed),
      } as never,
      deploymentPosture: async () => "account-linked-personal" as const,
      publicUrl: new URL("https://host.example.test"),
      repository: {} as IntegrationRepository,
      vault: {} as never,
    });

    await expect(service.authorizationStatus({ attemptId, ownerUserId })).resolves.toEqual(
      completed,
    );
  });
});

describe("IntegrationService OAuth error classification", () => {
  async function callbackWithError(error: string) {
    const ownerUserId = createId("user");
    const definition = refreshDefinition();
    const applicationId = createIntegrationId("providerApplication");
    const application = {
      clientId: "example-client",
      createdAt: "2026-08-20T12:00:00.000Z",
      displayName: "Example app",
      encryptedSecrets: Buffer.from("sealed-application-secret"),
      encryptionKeyVersion: 1,
      id: applicationId,
      ownerUserId: null,
      provider: "example" as const,
      revision: 1,
      status: "active" as const,
      updatedAt: "2026-08-20T12:00:00.000Z",
    };
    const attemptState = "s".repeat(43);
    let attemptId = createIntegrationId("oauthAttempt");
    let attemptPayload: Readonly<Record<string, string>> | undefined;
    const fail = vi.fn(async () => undefined);
    const attempts = {
      begin: vi.fn(async (input) => {
        attemptId = input.id;
        attemptPayload = (await input.payload(attemptState)).payload;
        return {
          attemptId,
          expiresAt: new Date("2026-08-20T12:10:00.000Z"),
          launchTicket: "t".repeat(43),
          state: attemptState,
        };
      }),
      claim: vi.fn(async () => ({
        id: attemptId,
        ownerUserId,
        payload: attemptPayload ?? {},
        surface: "web" as const,
      })),
      fail,
      identifyCallback: vi.fn(async () => attemptId),
    };
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: attempts as never,
      definitions: [definition],
      deploymentPosture: async () => "independent-self-hosted" as const,
      publicUrl: new URL("https://host.example.test"),
      repository: {
        getProviderApplication: vi.fn(async () => application),
        listApplicationSourceDefaults: vi.fn(async () => ({})),
        listProviderApplications: vi.fn(async () => [application]),
      } as unknown as IntegrationRepository,
      vault: {
        open: vi.fn(async () => ({ clientSecret: "client-secret" })),
        seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
      } as never,
    });
    await service.beginAuthorization({
      definitionId: definition.id,
      ownerUserId,
      requestSurface: "canonical",
      returnPath: "/integrations",
      surface: "web",
    });
    return {
      callback: service.handleAuthorizationCallback({
        attemptId,
        browserBinding: "b".repeat(43),
        parameters: new URLSearchParams({ error, state: attemptState }),
        provider: "example",
        state: attemptState,
      }),
      fail,
    };
  }

  it("reports an explicit user decline as denied", async () => {
    const { callback, fail } = await callbackWithError("access_denied");

    await expect(callback).resolves.toMatchObject({ status: "denied" });
    expect(fail).toHaveBeenCalledWith(expect.anything(), "denied");
  });

  it.each(["server_error", "temporarily_unavailable", "invalid_scope"])(
    "never tells the user they declined for %s",
    async (error) => {
      const { callback, fail } = await callbackWithError(error);

      await expect(callback).resolves.toMatchObject({
        returnPath: "/integrations",
        status: "failed",
        surface: "web",
      });
      expect(fail).toHaveBeenCalledWith(expect.anything(), "provider-exchange-failed");
      expect(fail).not.toHaveBeenCalledWith(expect.anything(), "denied");
    },
  );
});

describe("IntegrationService authorization scope coverage", () => {
  it("names the scopes the provider withheld at the authorization exchange", async () => {
    const ownerUserId = createId("user");
    const definition = refreshDefinition();
    const applicationId = createIntegrationId("providerApplication");
    const application = {
      clientId: "example-client",
      createdAt: "2026-08-20T12:00:00.000Z",
      displayName: "Example app",
      encryptedSecrets: Buffer.from("sealed-application-secret"),
      encryptionKeyVersion: 1,
      id: applicationId,
      ownerUserId: null,
      provider: "example" as const,
      revision: 1,
      status: "active" as const,
      updatedAt: "2026-08-20T12:00:00.000Z",
    };
    const attemptState = "s".repeat(43);
    let attemptId = createIntegrationId("oauthAttempt");
    let attemptPayload: Readonly<Record<string, string>> | undefined;
    const attempts = {
      begin: vi.fn(async (input) => {
        attemptId = input.id;
        attemptPayload = (await input.payload(attemptState)).payload;
        return {
          attemptId,
          expiresAt: new Date("2026-08-20T12:10:00.000Z"),
          launchTicket: "t".repeat(43),
          state: attemptState,
        };
      }),
      claim: vi.fn(async () => ({
        id: attemptId,
        ownerUserId,
        payload: attemptPayload ?? {},
        surface: "web" as const,
      })),
      fail: vi.fn(async () => undefined),
      identifyCallback: vi.fn(async () => attemptId),
    };
    const service = new IntegrationService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: attempts as never,
      definitions: [definition],
      deploymentPosture: async () => "independent-self-hosted" as const,
      fetch: vi.fn(async (target: unknown) =>
        String(target).includes("userinfo")
          ? Response.json({ name: "Example person", sub: "account-1" })
          : Response.json(
              { access_token: "access-token", scope: "openid", token_type: "Bearer" },
              { headers: { "cache-control": "no-store" } },
            ),
      ) as unknown as typeof globalThis.fetch,
      publicUrl: new URL("https://host.example.test"),
      repository: {
        getProviderApplication: vi.fn(async () => application),
        listApplicationSourceDefaults: vi.fn(async () => ({})),
        listProviderApplications: vi.fn(async () => [application]),
      } as unknown as IntegrationRepository,
      vault: {
        open: vi.fn(async () => ({ clientSecret: "client-secret" })),
        seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
      } as never,
    });
    await service.beginAuthorization({
      definitionId: definition.id,
      ownerUserId,
      requestSurface: "canonical",
      returnPath: "/integrations",
      surface: "web",
    });

    await expect(
      service.handleAuthorizationCallback({
        attemptId,
        browserBinding: "b".repeat(43),
        parameters: new URLSearchParams({
          code: "authorization-code",
          scope: "openid",
          state: attemptState,
        }),
        provider: "example",
        state: attemptState,
      }),
    ).resolves.toMatchObject({
      returnPath: "/integrations",
      status: "failed",
      surface: "web",
    });
    expect(attempts.fail).toHaveBeenCalledWith(attemptId, "scope-escalation");
  });
});

describe("IntegrationService disconnect", () => {
  it("revokes the token upstream and claims nothing more", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const fixture = disconnectFixture({ fetch, revocable: true });

    await expect(fixture.service.disconnect(fixture.request)).resolves.toEqual({
      notice: null,
      revokedUpstream: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://provider.example/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });

  /**
   * An account nobody can remove is worse than one whose provider copy outlives
   * the removal, so the local credential goes either way and the caller is told.
   */
  it("destroys the credential locally and says the provider token may still be live", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const fixture = disconnectFixture({ fetch, revocable: false });

    await expect(fixture.service.disconnect(fixture.request)).resolves.toEqual({
      notice:
        "The account was removed from Opensteer, but its Example token could not be revoked because Example declares no token revocation endpoint. It may stay valid until it expires — revoke it in Example's own security settings.",
      revokedUpstream: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });

  it("does not claim a hosted broker revoked a token it cannot authenticate for", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const fixture = disconnectFixture({ fetch, hosted: true, revocable: true });

    const outcome = await fixture.service.disconnect(fixture.request);

    expect(outcome.revokedUpstream).toBe(false);
    expect(outcome.notice).toContain("did not accept its revocation request");
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });

  it("seals hosted revocation to the exact account, app and deployment", async () => {
    const keys = generateOAuthBrokerEphemeralKeyPair();
    const revoke = vi.fn(async (raw: unknown) => {
      const request = CreateHostedOAuthRevocationRequestSchema.parse(raw);
      const { brokerSealedCredential, ...binding } = request;
      const context = OAuthBrokerRevocationContextSchema.parse({ ...binding, schemaVersion: 1 });
      expect(openOAuthBrokerPayload(brokerSealedCredential, keys.privateKey, context)).toEqual({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      });
      expect(JSON.stringify(raw)).not.toContain("access-token");
      expect(context.accountSubject.issuer).toBe("https://account.example.test");
      expect(context.deploymentAuthorityDigest).toBe("D".repeat(43));
      return { revoked: true, transactionId: request.transactionId };
    });
    const fetch = vi.fn(async () => Response.json({}));
    const fixture = disconnectFixture({
      fetch,
      hosted: true,
      revocable: true,
      broker: {
        issuer: "https://account.example.test",
        metadata: async () => ({
          providerRevisions: { example: 1 },
          encryptionPublicKey: keys.publicKey,
        }),
        revoke,
      },
    });
    expect(await fixture.service.disconnect(fixture.request)).toEqual({
      notice: null,
      revokedUpstream: true,
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });

  it("does not send a token to a replacement hosted app", async () => {
    const revoke = vi.fn();
    const fixture = disconnectFixture({
      fetch: vi.fn(),
      hosted: true,
      revocable: true,
      broker: {
        issuer: "https://account.example.test",
        metadata: async () => ({ providerRevisions: { example: 2 } }),
        revoke,
      },
    });
    expect((await fixture.service.disconnect(fixture.request)).revokedUpstream).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });

  it("removes the local credential when the provider rejects revocation", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const fixture = disconnectFixture({ fetch, revocable: true });

    await expect(fixture.service.disconnect(fixture.request)).resolves.toEqual({
      notice:
        "The account was removed from Opensteer, but its Example token could not be revoked because the provider did not accept its revocation request. It may stay valid until it expires — revoke it in Example's own security settings.",
      revokedUpstream: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.revokeConnection).toHaveBeenCalledOnce();
  });
});

function disconnectFixture(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly hosted?: boolean;
  readonly revocable: boolean;
  readonly broker?: unknown;
}) {
  const connectionId = createIntegrationId("connection");
  const ownerUserId = createId("user");
  const application: IntegrationProviderApplicationRecord = {
    clientId: "client-id",
    encryptedSecrets: Buffer.from("application"),
    encryptionKeyVersion: 1,
    id: createIntegrationId("providerApplication"),
    ownerUserId: null,
    provider: "example",
    revision: 1,
    scopes: [],
    status: "enabled",
  } as unknown as IntegrationProviderApplicationRecord;
  const base = refreshDefinition();
  const method = base.authMethods[0];
  if (method?.kind !== "oauth") throw new Error("The refresh definition must declare OAuth");
  const definition = IntegrationDefinitionSchema.parse({
    ...base,
    authMethods: [
      {
        ...method,
        oauth: {
          ...method.oauth,
          ...(input.revocable
            ? {
                revocation: {
                  clientAuth: "basic",
                  method: "post-form",
                  tokenField: "token",
                  tokenSource: "access-token",
                  url: "https://provider.example/revoke",
                },
              }
            : {}),
        },
      },
    ],
  });
  const revokeConnection = vi.fn(async () => undefined);
  const service = new IntegrationService({
    onConnectionConnected: vi.fn(async () => undefined),
    attempts: {} as never,
    definitions: [definition],
    deploymentPosture: async () => "independent-self-hosted" as const,
    fetch: input.fetch,
    publicUrl: new URL("https://host.example.test"),
    ...(input.broker
      ? {
          hostedOAuth: {
            broker: input.broker as never,
            deploymentAuthorityDigest: "D".repeat(43),
            accountSubject: async () =>
              ({
                issuer: "https://account.example.test",
                subject: "acct_00000000-0000-4000-8000-000000000001",
                linkGeneration: "G".repeat(43),
              }) as never,
          },
        }
      : {}),
    repository: {
      getConnectionForRevocation: vi.fn(async () => ({
        connection: {
          applicationSource: input.hosted
            ? {
                kind: "hosted-oauth",
                brokerIssuer: "https://account.example.test",
                providerApplicationRevision: 1,
              }
            : {
                kind: "deployment-oauth",
                providerApplicationId: application.id,
                providerApplicationRevision: 1,
              },
          authorizationDigest: authorizationDigest(definition),
          authMethodId: "oauth",
          definitionId: definition.id,
          id: connectionId,
          provider: "example",
        },
        encryptedCredential: Buffer.from("connection"),
        encryptionKeyVersion: 1,
        ...(input.hosted ? {} : { providerApplication: application }),
      })),
      revokeConnection,
    } as unknown as IntegrationRepository,
    vault: {
      open: vi.fn(async (envelope: Buffer) =>
        envelope.toString() === "application"
          ? { clientSecret: "client-secret" }
          : { accessToken: "access-token", refreshToken: "refresh-token" },
      ),
      seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
    } as never,
  });
  return {
    request: { connectionId, ownerUserId, requestId: "disconnect" } as const,
    revokeConnection,
    service,
  };
}

function refreshDefinition() {
  return IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "oauth",
        kind: "oauth",
        label: "Example OAuth",
        oauth: {
          authorizationUrl: "https://provider.example/authorize",
          clientAuth: "body",
          identity: {
            displayNamePath: "name",
            identityPath: "sub",
            source: "userinfo",
            userinfoUrl: "https://provider.example/userinfo",
          },
          scopeSeparator: " ",
          scopes: ["openid", "email"],
          tokenUrl: "https://provider.example/token",
          usesPkce: true,
        },
        placements: [
          {
            carrier: "header",
            name: "Authorization",
            prefix: "Bearer ",
            variable: "accessToken",
          },
        ],
      },
    ],
    config: {},
    description: "Example provider",
    hostedOAuth: {
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    },
    id: "example",
    name: "Example",
    provider: "example",
    setupUrl: "https://provider.example/developers",
  });
}

/**
 * A hosted broker that answers refreshes across the real protocol schemas, exactly as
 * HostedOAuthBrokerClient parses them. A request carrying a field the contract never had fails
 * here rather than dying before the network on every hosted refresh in production.
 */
function hostedRefreshBroker(
  outcome:
    | { readonly grantedScopes?: readonly string[]; readonly status: "sealed" }
    | {
        readonly failureCode: string;
        readonly providerError: string | null;
        readonly status: "failed";
      },
) {
  const encryption = generateOAuthBrokerEphemeralKeyPair();
  let request: ReturnType<typeof CreateHostedOAuthRefreshRequestSchema.parse>;
  const refreshContext = () => ({
    authorizationDigest: request.authorizationDigest,
    definitionId: request.definitionId,
    deploymentAuthorityDigest: request.deploymentAuthorityDigest,
    expiresAt: request.expiresAt,
    providerApplicationRevision: request.providerApplicationRevision,
    schemaVersion: 1,
    transactionId: request.transactionId,
  });
  return {
    acknowledgeRefresh: vi.fn(async () => undefined),
    issuer: "https://account.example.test",
    metadata: vi.fn(async () =>
      OAuthBrokerPublicMetadataSchema.parse({
        callbackRelayProviders: [],
        encryptionPublicKey: encryption.publicKey,
        issuer: "https://account.example.test",
        providerRevisions: { example: 1 },
      }),
    ),
    pullRefresh: vi.fn(async () =>
      PullHostedOAuthRefreshResponseSchema.parse({
        expiresAt: request.expiresAt,
        failureCode: null,
        providerError: null,
        sealedResult: sealOAuthBrokerPayload(
          {
            accessToken: "hosted-access-token",
            grantedScopes:
              outcome.status === "sealed" && outcome.grantedScopes
                ? [...outcome.grantedScopes]
                : ["openid", "email"],
            refreshToken: "hosted-rotated-refresh-token",
            tokenType: "Bearer",
          },
          request.hostPublicKey,
          refreshContext(),
        ),
        status: "sealed",
        transactionId: request.transactionId,
      }),
    ),
    refresh: vi.fn(async (input: unknown) => {
      request = CreateHostedOAuthRefreshRequestSchema.parse(input);
      return CreateHostedOAuthRefreshResponseSchema.parse({
        expiresAt: request.expiresAt,
        failureCode: outcome.status === "failed" ? outcome.failureCode : null,
        providerError: outcome.status === "failed" ? outcome.providerError : null,
        status: outcome.status,
        transactionId: request.transactionId,
      });
    }),
    /** What the Host actually sealed to the broker, opened with the broker's own key. */
    sealedRefreshToken: () =>
      openOAuthBrokerPayload(
        request.brokerSealedCredential,
        encryption.privateKey,
        refreshContext(),
      ),
  };
}

function hostedRefreshHarness(broker: unknown) {
  const definition = refreshDefinition();
  const connection = IntegrationConnectionSummarySchema.parse({
    ...refreshConnectionFields(definition),
    applicationSource: {
      brokerIssuer: "https://account.example.test",
      kind: "hosted-oauth",
      providerApplicationRevision: 1,
    },
    providerApplicationId: null,
  });
  return refreshHarness({
    connection,
    definition,
    hostedOAuth: {
      accountSubject: vi.fn(async () => ({
        issuer: "https://account.example.test",
        linkGeneration: "G".repeat(43),
        subject: `acct_${crypto.randomUUID()}`,
      })) as never,
      broker: broker as never,
      deploymentAuthorityDigest: "D".repeat(43),
    },
    posture: "account-linked-personal",
  });
}

function deploymentRefreshHarness() {
  const applicationId = createIntegrationId("providerApplication");
  const definition = refreshDefinition();
  const application = {
    clientId: "client-id",
    createdAt: "2026-08-13T12:00:00.000Z",
    displayName: "Example app",
    encryptedSecrets: Buffer.from("application"),
    encryptionKeyVersion: 1,
    id: applicationId,
    ownerUserId: null,
    provider: "example",
    revision: 1,
    status: "active" as const,
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
  const connection = IntegrationConnectionSummarySchema.parse({
    ...refreshConnectionFields(definition),
    applicationSource: {
      callbackUrl: "https://host.example/v1/integrations/oauth/callback/example",
      kind: "deployment-oauth",
      providerApplicationId: applicationId,
      providerApplicationRevision: 1,
    },
    providerApplicationId: applicationId,
  });
  const providerFetch = vi.fn(async () => Response.json({}));
  return {
    ...refreshHarness({
      connection,
      definition,
      fetch: providerFetch,
      posture: "independent-self-hosted",
      providerApplication: application,
    }),
    providerFetch,
  };
}

function refreshConnectionFields(definition: ReturnType<typeof refreshDefinition>) {
  return {
    accountIdentifier: "account@example.com",
    authMethodId: "oauth",
    authorizationDigest: authorizationDigest(definition),
    computer: null,
    connectionMethod: "managed-oauth",
    createdAt: "2026-08-13T12:00:00.000Z",
    definitionId: definition.id,
    displayName: "Example account",
    externalIdentityId: "account-1",
    externalTenantId: null,
    grantedScopes: ["openid", "email"],
    id: createIntegrationId("connection"),
    provider: "example",
    status: "connected",
    statusDetail: null,
    statusReason: null,
    updatedAt: "2026-08-13T12:00:00.000Z",
  } as const;
}

function refreshHarness(input: {
  readonly connection: IntegrationConnectionSummary;
  readonly definition: ReturnType<typeof refreshDefinition>;
  readonly fetch?: typeof globalThis.fetch;
  readonly hostedOAuth?: ConstructorParameters<typeof IntegrationService>[0]["hostedOAuth"];
  readonly posture: IntegrationDeploymentPosture;
  readonly providerApplication?: IntegrationProviderApplicationRecord;
}) {
  const ownerUserId = createId("user");
  const connectionId = input.connection.id;
  const markConnectionNeedsAttention = vi.fn(async () => undefined);
  const replaceConnectionCredential = vi.fn(async () => true);
  const service = new IntegrationService({
    onConnectionConnected: vi.fn(async () => undefined),
    attempts: {} as never,
    definitions: [input.definition],
    deploymentPosture: async () => input.posture,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.hostedOAuth ? { hostedOAuth: input.hostedOAuth } : {}),
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    publicUrl: new URL("https://host.example"),
    repository: {
      getConnectionForAccess: vi.fn(async () => ({
        connection: input.connection,
        credentialGeneration: 1,
        encryptedCredential: Buffer.from("connection"),
        encryptionKeyVersion: 1,
        ...(input.providerApplication ? { providerApplication: input.providerApplication } : {}),
      })),
      listApplicationSourceDefaults: vi.fn(async () => ({})),
      listProviderApplications: vi.fn(async () =>
        input.providerApplication ? [input.providerApplication] : [],
      ),
      markConnectionNeedsAttention,
      recordConnectionAccess: vi.fn(async () => undefined),
      replaceConnectionCredential,
    } as unknown as IntegrationRepository,
    vault: {
      open: vi.fn(async (envelope: Buffer) =>
        envelope.toString() === "application"
          ? { clientSecret: "client-secret" }
          : {
              accessToken: "expired-access-token",
              expiresAt: "1",
              refreshToken: "refresh-token",
              tokenType: "Bearer",
            },
      ),
      seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
    },
  });
  return {
    connectionId,
    markConnectionNeedsAttention,
    ownerUserId,
    replaceConnectionCredential,
    request: { connectionId, operation: "identity.get", ownerUserId } as const,
    service,
  };
}

function hostedOAuthFixture(
  options: {
    readonly metadataRevision?: number | null;
    readonly metadataUnavailable?: boolean;
  } = {},
) {
  return {
    accountSubject: vi.fn(async () => null),
    broker: {
      issuer: "https://account.example.test",
      metadata: vi.fn(async () => {
        if (options.metadataUnavailable) throw new Error("broker metadata unavailable");
        const revision = options.metadataRevision === undefined ? 1 : options.metadataRevision;
        return {
          callbackRelayProviders: [],
          providerRevisions: revision === null ? {} : { example: revision },
        };
      }),
    } as never,
    deploymentAuthorityDigest: "D".repeat(43),
  };
}

function oauthAuthorityService(input: {
  readonly connections?: readonly IntegrationConnectionSummary[];
  readonly hosted: boolean;
  readonly metadataRevision?: number | null;
  readonly metadataUnavailable?: boolean;
  readonly posture: IntegrationDeploymentPosture;
  readonly providerApplications: readonly IntegrationProviderApplicationRecord[];
  readonly saved: Readonly<Record<string, "deployment-oauth" | "hosted-oauth">>;
}) {
  return new IntegrationService({
    onConnectionConnected: vi.fn(async () => undefined),
    attempts: {} as never,
    definitions: [refreshDefinition()],
    deploymentPosture: async () => input.posture,
    ...(input.hosted
      ? {
          hostedOAuth: hostedOAuthFixture({
            ...(input.metadataRevision === undefined
              ? {}
              : { metadataRevision: input.metadataRevision }),
            ...(input.metadataUnavailable ? { metadataUnavailable: true } : {}),
          }),
        }
      : {}),
    publicUrl: new URL("https://host.example.test"),
    repository: {
      listApplicationSourceDefaults: vi.fn(async () => input.saved),
      listConnections: vi.fn(async () => input.connections ?? []),
      listProviderApplications: vi.fn(async () => input.providerApplications),
    } as unknown as IntegrationRepository,
    vault: {} as never,
  });
}

function installedDefinitionService(input: {
  readonly checkHealth: IntegrationAdapter["checkHealth"];
  readonly connectApiKey: IntegrationRepository["connectApiKey"];
  readonly definitions?: readonly IntegrationDefinition[];
  readonly installedDefinition: InstalledIntegrationDefinitionLookup;
}): IntegrationService {
  return new IntegrationService({
    onConnectionConnected: vi.fn(async () => undefined),
    adapters: [testGraphqlAdapter(input.checkHealth)],
    attempts: {} as never,
    definitions: input.definitions ?? [],
    deploymentPosture: async () => "independent-self-hosted" as const,
    installedDefinition: input.installedDefinition,
    publicUrl: new URL("https://opensteer.example.test"),
    repository: {
      connectApiKey: input.connectApiKey,
      findReusableConnectionId: vi.fn(async () => null),
    } as unknown as IntegrationRepository,
    vault: {
      open: vi.fn(),
      seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
    },
  });
}

function testGraphqlAdapter(checkHealth: IntegrationAdapter["checkHealth"]): IntegrationAdapter {
  return {
    credentialDisclosure: () => ({ destinations: ["https://api.example.com"], check: true }),
    checkHealth,
    async invokeTool() {
      return { kind: "ok", value: {} };
    },
    kind: "graphql",
    parseConfig: (config) => config,
    async snapshotConfig(config) {
      if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw new TypeError("Test integration config must be an object");
      }
      return config as Readonly<Record<string, unknown>>;
    },
    async resolveTools() {
      return { definitions: {}, tools: [] };
    },
  };
}

function apiKeyService(input: {
  readonly checkHealth: IntegrationAdapter["checkHealth"];
  readonly onConnectionConnected?: IntegrationConnectionConnected;
  readonly repository: IntegrationRepository;
  readonly seal: (
    values: Readonly<Record<string, string>>,
    context: unknown,
  ) => Promise<{
    readonly envelope: Buffer;
    readonly keyVersion: number;
  }>;
}): IntegrationService {
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "api-key",
        inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
        kind: "api-key",
        label: "Linear API key",
        placements: [
          {
            carrier: "header",
            name: "Authorization",
            prefix: "Bearer ",
            variable: "apiKey",
          },
        ],
      },
    ],
    config: { endpoint: "https://api.linear.test/graphql" },
    description: "Linear issues",
    id: "linear",
    name: "Linear",
    provider: "linear",
  });
  return new IntegrationService({
    adapters: [testGraphqlAdapter(input.checkHealth)],
    attempts: {} as never,
    definitions: [definition],
    installedDefinition: async () => definition,
    onConnectionConnected: input.onConnectionConnected ?? vi.fn(async () => undefined),
    deploymentPosture: async () => "independent-self-hosted" as const,
    publicUrl: new URL("https://opensteer.example.test"),
    repository: input.repository,
    vault: { open: vi.fn(), seal: input.seal },
  });
}
