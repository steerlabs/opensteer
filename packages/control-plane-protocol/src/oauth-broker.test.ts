import { describe, expect, it } from "vitest";
import {
  CreatePluginOAuthAttemptRequestSchema,
  CreatePluginOAuthCallbackRelayRequestSchema,
  CreatePluginOAuthRefreshRequestSchema,
  CreatePluginOAuthRevocationRequestSchema,
  CreateHostedOAuthRevocationResponseSchema,
  CreateHostedOAuthRefreshResponseSchema,
  HostedOAuthAttemptIdSchema,
  OAuthBrokerPluginAuthorizationContextSchema,
  OAuthBrokerPluginRelayContextSchema,
  OAuthBrokerPluginRevocationContextSchema,
  PullHostedOAuthRefreshResponseSchema,
} from "./oauth-broker.js";

const attempt = {
  kind: "plugin" as const,
  attemptId: HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`),
  provider: "fixture",
  registryRevision: 7,
  requestedScopes: ["read"],
  expiresAt: "2030-01-01T00:00:00.000Z",
  binding: {
    accountSubject: {
      issuer: "https://accounts.example.test",
      subject: `acct_${crypto.randomUUID()}`,
    },
    accountLinkGeneration: "g".repeat(43),
    deploymentAuthorityDigest: "a".repeat(43),
    hostPublicKey: "k".repeat(43),
    requirementDigest: "r".repeat(43),
    redirectUrl: "https://accounts.example.test/v1/oauth-broker/callback/fixture",
  },
};
const envelope = {
  ciphertext: "c2VhbGVk",
  ephemeralPublicKey: "b".repeat(43),
  nonce: "n".repeat(16),
  tag: "t".repeat(22),
  version: 1 as const,
};

describe("plugin OAuth broker protocol", () => {
  it("requires explicit expiry and every reviewed Host binding, rejecting the retired catalog request", () => {
    expect(CreatePluginOAuthAttemptRequestSchema.parse(attempt).attemptId).toBe(attempt.attemptId);
    for (const field of Object.keys(attempt.binding)) {
      expect(
        CreatePluginOAuthAttemptRequestSchema.safeParse({
          ...attempt,
          binding: { ...attempt.binding, [field]: undefined },
        }).success,
        field,
      ).toBe(false);
    }
    for (const change of [
      { expiresAt: undefined },
      { registryRevision: undefined },
      { authorizationDigest: "c".repeat(43) },
      { kind: undefined },
    ]) {
      expect(
        CreatePluginOAuthAttemptRequestSchema.safeParse({ ...attempt, ...change }).success,
      ).toBe(false);
    }
    expect(
      CreatePluginOAuthAttemptRequestSchema.safeParse({
        accountSubject: attempt.binding.accountSubject,
        attemptId: attempt.attemptId,
        authorizationDigest: "c".repeat(43),
        definitionId: "google-gmail",
        deploymentAuthorityDigest: attempt.binding.deploymentAuthorityDigest,
        expiresAt: attempt.expiresAt,
        hostPublicKey: attempt.binding.hostPublicKey,
        provider: "google",
        providerApplicationRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      OAuthBrokerPluginAuthorizationContextSchema.safeParse({
        provider: attempt.provider,
        registryRevision: 7,
        requestedScopes: ["read"],
        binding: attempt.binding,
        attemptId: attempt.attemptId,
        expiresAt: attempt.expiresAt,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it.each([48_199, 48_216, 80, 65_535, 48_203.5])(
    "refuses a return port outside the reserved block (%s)",
    (appReturnPort) => {
      expect(
        CreatePluginOAuthAttemptRequestSchema.safeParse({ ...attempt, appReturnPort }).success,
      ).toBe(false);
    },
  );

  it("pins a custom relay without accepting its secret or PKCE verifier", () => {
    const request = {
      ...attempt,
      kind: "plugin-relay",
      authorizationUrl: "https://provider.example.test/authorize?state=opaque",
      relay: {
        clientId: "custom-client",
        issuer: "https://provider.example.test",
        authorizationEndpoint: "https://provider.example.test/authorize",
        authorizationResponseIssuerParameterSupported: true,
        usesPkce: true,
        scopeSeparator: " ",
      },
      returnPath: "/settings/plugins",
    };
    expect(CreatePluginOAuthCallbackRelayRequestSchema.parse(request)).toMatchObject({
      provider: "fixture",
    });
    for (const change of [
      { clientSecret: "must-stay-home" },
      { codeVerifier: "must-stay-home" },
      { returnPath: "//evil.test" },
    ]) {
      expect(
        CreatePluginOAuthCallbackRelayRequestSchema.safeParse({ ...request, ...change }).success,
      ).toBe(false);
    }
    expect(
      OAuthBrokerPluginRelayContextSchema.parse({
        provider: request.provider,
        registryRevision: 7,
        requestedScopes: ["read"],
        binding: request.binding,
        relay: request.relay,
        attemptId: request.attemptId,
        expiresAt: request.expiresAt,
        schemaVersion: 2,
      }),
    ).toMatchObject({ relay: request.relay });
  });

  it("binds refresh and revocation to the same plugin pins and accepts credentials only sealed", () => {
    const context = OAuthBrokerPluginRevocationContextSchema.parse({
      provider: attempt.provider,
      registryRevision: 7,
      requestedScopes: ["read"],
      binding: attempt.binding,
      expiresAt: attempt.expiresAt,
      schemaVersion: 2,
      transactionId: `hov_${crypto.randomUUID()}`,
    });
    const { schemaVersion: _version, ...fields } = context;
    const request = { ...fields, kind: "plugin", brokerSealedCredential: envelope };
    expect(CreatePluginOAuthRevocationRequestSchema.parse(request)).toMatchObject({
      transactionId: context.transactionId,
    });
    expect(
      CreatePluginOAuthRevocationRequestSchema.safeParse({
        ...request,
        refreshToken: "must-be-sealed",
      }).success,
    ).toBe(false);
    const refresh = {
      ...request,
      transactionId: `hor_${crypto.randomUUID()}`,
      grantedScopes: ["read"],
    };
    expect(CreatePluginOAuthRefreshRequestSchema.parse(refresh)).toMatchObject({
      grantedScopes: ["read"],
    });
    expect(
      CreatePluginOAuthRefreshRequestSchema.safeParse({ ...refresh, accessToken: "must-be-sealed" })
        .success,
    ).toBe(false);
    expect(
      CreateHostedOAuthRevocationResponseSchema.parse({
        revoked: true,
        transactionId: context.transactionId,
      }),
    ).toEqual({ revoked: true, transactionId: context.transactionId });
  });

  it("keeps grant, client and outage classifications and only bounded provider error codes", () => {
    const response = {
      expiresAt: attempt.expiresAt,
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      status: "failed",
      transactionId: `hor_${crypto.randomUUID()}`,
    };
    expect(CreateHostedOAuthRefreshResponseSchema.parse(response)).toEqual(response);
    for (const providerError of ["Not A Code", "e".repeat(65)]) {
      expect(
        CreateHostedOAuthRefreshResponseSchema.safeParse({ ...response, providerError }).success,
      ).toBe(false);
    }
    for (const [failureCode, providerError] of [
      ["client-rejected", "invalid_client"],
      ["provider-exchange-failed", null],
    ]) {
      expect(
        PullHostedOAuthRefreshResponseSchema.parse({
          ...response,
          failureCode,
          providerError,
          sealedResult: null,
        }),
      ).toMatchObject({ failureCode, providerError });
    }
    expect(
      CreateHostedOAuthRefreshResponseSchema.safeParse({
        ...response,
        failureCode: "catalog-version-skew",
      }).success,
    ).toBe(false);
  });
});
