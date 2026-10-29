import { describe, expect, it } from "vitest";
import {
  BeginIntegrationAuthorizationSchema,
  IntegrationProviderManifestSchema,
  IntegrationProviderAuthorizationSchema,
  IntegrationProposalSummarySchema,
  createIntegrationId,
  integrationDefinitionToProviderManifest,
  defaultOAuthApplicationSource,
  integrationApplicationCallbackUrl,
  integrationProposalPreviewMaxSerializedBytes,
  integrationProposalSummary,
  providerAuthorizationIncludesSource,
  resolveIntegrationDeploymentPosture,
  resolveIntegrationReadiness,
} from "./index.js";

describe("integration catalog", () => {
  it("keeps provider setup fields inside the public contract", () => {
    const manifest = integrationDefinitionToProviderManifest({
      adapter: "openapi",
      authMethods: [
        {
          id: "oauth",
          kind: "oauth",
          label: "Example OAuth",
          oauth: {
            authorizationUrl: "https://example.com/authorize",
            clientAuth: "body",
            identity: { identityPath: "id", source: "token-response" },
            scopeSeparator: " ",
            scopes: ["email.read"],
            tokenUrl: "https://example.com/token",
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
      description: "Example mail provider",
      id: "example",
      name: "Example",
      provider: "example",
      setupUrl: "https://example.com/developers",
    });
    expect(IntegrationProviderManifestSchema.parse(manifest)).toMatchObject({
      provider: "example",
      secretFields: ["clientSecret"],
    });
  });
});

describe("integration authorization input", () => {
  it("accepts an origin-relative return path and rejects protocol-relative redirects", () => {
    expect(
      BeginIntegrationAuthorizationSchema.parse({
        definitionId: "google-gmail",
        returnPath: "/settings/integrations",
        surface: "web",
      }).returnPath,
    ).toBe("/settings/integrations");
    expect(() =>
      BeginIntegrationAuthorizationSchema.parse({
        definitionId: "google-gmail",
        returnPath: "//attacker.example",
        surface: "web",
      }),
    ).toThrow();
  });

  it("does not let a client override the server-selected OAuth source", () => {
    expect(() =>
      BeginIntegrationAuthorizationSchema.parse({
        applicationSource: "hosted-oauth",
        capabilities: ["email.read"],
        definitionId: "google-gmail",
        provider: "google",
        returnPath: "/settings/integrations",
        surface: "web",
      }),
    ).toThrow();
  });
});

describe("provider application sources", () => {
  const deployment = {
    callbackUrl: "https://host.example/v1/integrations/oauth/callback/google",
    kind: "deployment-oauth" as const,
    providerApplicationId: createIntegrationId("providerApplication"),
    providerApplicationRevision: 3,
  };

  it("applies posture defaults per provider and keeps an existing pinned value stable", () => {
    const hosted = defaultOAuthApplicationSource({
      brokerIssuer: "https://accounts.opensteer.test",
      deploymentSource: deployment,
      hostedProviderApplicationRevision: 4,
      posture: "account-linked-personal",
    });
    expect(hosted?.kind).toBe("hosted-oauth");
    expect(
      defaultOAuthApplicationSource({
        brokerIssuer: "https://accounts.opensteer.test",
        deploymentSource: deployment,
        hostedProviderApplicationRevision: 4,
        posture: "independent-self-hosted",
      }),
    ).toEqual(deployment);
    expect(
      defaultOAuthApplicationSource({
        brokerIssuer: "https://accounts.opensteer.test",
        deploymentSource: deployment,
        hostedProviderApplicationRevision: 4,
        posture: "account-adopted-self-hosted",
      }),
    ).toEqual(deployment);
    expect(defaultOAuthApplicationSource({ posture: "account-free-personal" })).toBeNull();
    expect(deployment.providerApplicationRevision).toBe(3);
  });

  it("projects callback authority from the pinned source", () => {
    expect(integrationApplicationCallbackUrl(deployment, "google").origin).toBe(
      "https://host.example",
    );
    expect(
      integrationApplicationCallbackUrl(
        {
          brokerIssuer: "https://accounts.opensteer.test",
          kind: "hosted-oauth",
          providerApplicationRevision: 4,
        },
        "google",
      ).toString(),
    ).toBe("https://accounts.opensteer.test/v1/oauth-broker/callback/google");
  });

  it("matches only the exact issuer/application revision pinned by Host authority", () => {
    const hosted = {
      brokerIssuer: "https://accounts.opensteer.test",
      kind: "hosted-oauth" as const,
      providerApplicationRevision: 4,
    };
    const authorization = IntegrationProviderAuthorizationSchema.parse({
      availableSources: [hosted],
      code: "READY",
      detail: "Hosted OAuth is ready.",
      selectedSource: hosted,
      selectedSourceKind: "hosted-oauth",
      hostedOAuthStatus: "available" as const,
    });

    expect(providerAuthorizationIncludesSource(authorization, hosted)).toBe(true);
    expect(
      providerAuthorizationIncludesSource(authorization, {
        ...hosted,
        providerApplicationRevision: 5,
      }),
    ).toBe(false);
    expect(() =>
      IntegrationProviderAuthorizationSchema.parse({
        ...authorization,
        selectedSource: { ...hosted, providerApplicationRevision: 5 },
      }),
    ).toThrow();
  });

  it.each([
    ["canonical", false, "server", "account-adopted-self-hosted"],
    [null, true, "personal", "account-linked-personal"],
    [null, false, "personal", "account-free-personal"],
    [null, false, "server", "independent-self-hosted"],
  ] as const)(
    "derives %s/%s/%s as %s",
    (accountReachability, personalAccountLinked, kind, expected) => {
      expect(
        resolveIntegrationDeploymentPosture({
          accountReachability,
          personalAccountLinked,
          kind,
        }),
      ).toBe(expected);
    },
  );
});

describe("integration proposal projections", () => {
  it("keeps the exact proposal source private while preserving verified approval facts", () => {
    const summary = integrationProposalSummary({
      authMethods: ["none"],
      digest: "a".repeat(43),
      kind: "openapi",
      preview: { operationCount: 2 },
      source: { content: '{"openapi":"3.1.0"}', type: "inline" },
    });
    expect(summary).toEqual({
      authMethods: ["none"],
      digest: "a".repeat(43),
      kind: "openapi",
      preview: { operationCount: 2 },
      source: { type: "inline" },
    });
    expect(() =>
      IntegrationProposalSummarySchema.parse({
        ...summary,
        source: { content: "private source", type: "inline" },
      }),
    ).toThrow();
  });

  /**
   * The approval card's payload column is bounded and the document behind a
   * preview is not, so the projection has to shorten the preview rather than
   * let a large document produce a summary nothing can store.
   */
  it("bounds a preview without losing the facts an approver reads", () => {
    const summary = integrationProposalSummary({
      authMethods: ["none"],
      digest: "a".repeat(43),
      kind: "openapi",
      preview: {
        operationCount: 4_000,
        tags: Array.from(
          { length: 4_000 },
          (_unused, index) => `tag-${index}-${"long".repeat(60)}`,
        ),
        title: "Huge API",
      },
      source: { content: '{"openapi":"3.1.0"}', type: "inline" },
    });

    expect(
      new TextEncoder().encode(JSON.stringify(summary.preview)).byteLength,
    ).toBeLessThanOrEqual(integrationProposalPreviewMaxSerializedBytes);
    expect(summary.preview).toMatchObject({
      operationCount: 4_000,
      title: "Huge API",
      truncated: true,
    });
    // A collection that cannot fit the remaining budget is dropped outright
    // rather than left looking complete.
    expect(summary.preview).not.toHaveProperty("tags");
    expect(() => IntegrationProposalSummarySchema.parse(summary)).not.toThrow();
  });

  it("keeps a collection that fits, capped and marked", () => {
    const summary = integrationProposalSummary({
      authMethods: ["none"],
      digest: "b".repeat(43),
      kind: "mcp",
      preview: {
        toolNames: Array.from({ length: 400 }, (_unused, index) => `tool-${index}`),
        transport: "streamable-http",
      },
      source: { origin: "https://mcp.example.test", type: "url", url: "https://mcp.example.test" },
    });

    expect(summary.preview).toMatchObject({ transport: "streamable-http", truncated: true });
    expect(summary.preview.toolNames).toHaveLength(50);
  });
});

describe("integration readiness", () => {
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const deploymentSource = {
    callbackUrl: "https://host.example/v1/integrations/oauth/callback/google",
    kind: "deployment-oauth" as const,
    providerApplicationId: createIntegrationId("providerApplication"),
    providerApplicationRevision: 3,
  };
  const readyProviderAuthorization = {
    availableSources: [deploymentSource],
    code: "READY" as const,
    detail: "Using the deployment OAuth application.",
    selectedSource: deploymentSource,
    selectedSourceKind: "deployment-oauth" as const,
    hostedOAuthStatus: "available" as const,
  };
  const base = {
    connectionRequirement: {
      definitionId: "google-gmail",
      kind: "provider" as const,
      provider: "google",
      providerApplicationRequired: true,
    },
    connections: [],
    hasAccess: () => false,
    installationStatus: "active" as const,
    providerAuthorization: {
      availableSources: [],
      code: "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED" as const,
      detail: "Link Opensteer Account or use your own OAuth app.",
      selectedSource: null,
      selectedSourceKind: null,
      hostedOAuthStatus: "unsupported" as const,
    },
    requiredAccess: "read" as const,
    requiredConnectionId: null,
    serverId,
    serverStatus: "active" as const,
  };

  it("distinguishes administrator setup, user sign-in, grants, and ready access", () => {
    expect(resolveIntegrationReadiness(base).code).toBe("ADMIN_CONFIGURATION_REQUIRED");

    const configured = {
      ...base,
      providerAuthorization: readyProviderAuthorization,
    };
    expect(resolveIntegrationReadiness(configured).code).toBe("USER_AUTHORIZATION_REQUIRED");

    const connected = {
      ...configured,
      connections: [
        {
          applicationSourceAvailable: true,
          connectionKind: "provider-account" as const,
          definitionId: "google-gmail",
          id: connectionId,
          integrationServerId: null,
          provider: "google",
          status: "connected" as const,
        },
      ],
    };
    expect(resolveIntegrationReadiness(connected)).toMatchObject({
      code: "ACCESS_GRANT_REQUIRED",
      connectionId,
      requiredAccess: "read",
    });
    expect(
      resolveIntegrationReadiness({ ...connected, hasAccess: (id) => id === connectionId }),
    ).toMatchObject({ code: "READY", connectionId, requiredAccess: null });
  });

  it("reports reauthorization instead of pretending a broken connection is usable", () => {
    expect(
      resolveIntegrationReadiness({
        ...base,
        connections: [
          {
            applicationSourceAvailable: true,
            connectionKind: "provider-account",
            definitionId: "google-gmail",
            id: connectionId,
            integrationServerId: null,
            provider: "google",
            status: "needs-attention",
          },
        ],
        providerAuthorization: readyProviderAuthorization,
      }),
    ).toMatchObject({ code: "REAUTHORIZATION_REQUIRED", connectionId });
  });

  it("requires a new application source after an Account-hosted OAuth link is removed", () => {
    expect(
      resolveIntegrationReadiness({
        ...base,
        connections: [
          {
            applicationSourceAvailable: false,
            connectionKind: "provider-account",
            definitionId: "google-gmail",
            id: connectionId,
            integrationServerId: null,
            provider: "google",
            status: "needs-attention",
          },
        ],
      }),
    ).toMatchObject({
      code: "ADMIN_CONFIGURATION_REQUIRED",
      connectionId,
      detail: "Link Opensteer Account or use your own OAuth app.",
    });
  });
});
