import { describe, expect, it } from "vitest";
import {
  CreateHostedOAuthAttemptRequestSchema,
  CreateOAuthCallbackRelayRequestSchema,
  CreateHostedOAuthRevocationRequestSchema,
  CreateHostedOAuthRevocationResponseSchema,
  CreateHostedOAuthRefreshResponseSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRevocationTransactionIdSchema,
  HostedOAuthRefreshTransactionIdSchema,
  OAuthBrokerCallbackRelayContextSchema,
  OAuthBrokerRevocationContextSchema,
  PullHostedOAuthRefreshResponseSchema,
} from "./oauth-broker.js";

describe("hosted OAuth broker protocol", () => {
  const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
  const accountSubject = {
    issuer: "https://accounts.opensteer.test",
    subject: `acct_${crypto.randomUUID()}`,
  };

  it("requires versioned one-use IDs, explicit expiry, and a catalog authorization digest", () => {
    const request = {
      accountSubject,
      attemptId,
      authorizationDigest: "c".repeat(43),
      definitionId: "google",
      deploymentAuthorityDigest: "a".repeat(43),
      expiresAt: "2030-01-01T00:00:00.000Z",
      hostPublicKey: "b".repeat(43),
      provider: "google",
      providerApplicationRevision: 1,
    };
    expect(CreateHostedOAuthAttemptRequestSchema.parse(request).attemptId).toBe(attemptId);
    expect(
      CreateHostedOAuthAttemptRequestSchema.safeParse({ ...request, capabilities: ["admin"] })
        .success,
    ).toBe(false);
    expect(
      CreateHostedOAuthAttemptRequestSchema.safeParse({ ...request, expiresAt: undefined }).success,
    ).toBe(false);
  });

  it("binds a custom callback relay without accepting a client secret", () => {
    const request = {
      accountSubject,
      attemptId,
      authorizationDigest: "c".repeat(43),
      authorizationUrl: "https://slack.com/oauth/v2/authorize?state=opaque",
      clientId: "slack-client",
      definitionId: "slack",
      deploymentAuthorityDigest: "a".repeat(43),
      expiresAt: "2030-01-01T00:00:00.000Z",
      hostPublicKey: "b".repeat(43),
      provider: "slack",
      providerApplicationId: `ipa_${crypto.randomUUID()}`,
      providerApplicationRevision: 2,
      returnPath: `/settings/integrations?attempt=${attemptId}`,
    };
    expect(CreateOAuthCallbackRelayRequestSchema.parse(request)).toMatchObject({
      provider: "slack",
    });
    expect(
      CreateOAuthCallbackRelayRequestSchema.safeParse({
        ...request,
        clientSecret: "must-stay-home",
      }).success,
    ).toBe(false);
    expect(
      CreateOAuthCallbackRelayRequestSchema.safeParse({ ...request, returnPath: "//evil.test" })
        .success,
    ).toBe(false);
    expect(
      OAuthBrokerCallbackRelayContextSchema.parse({
        accountSubject,
        attemptId,
        authorizationDigest: request.authorizationDigest,
        definitionId: request.definitionId,
        deploymentAuthorityDigest: request.deploymentAuthorityDigest,
        expiresAt: request.expiresAt,
        providerApplicationId: request.providerApplicationId,
        providerApplicationRevision: request.providerApplicationRevision,
        redirectUrl: "https://accounts.opensteer.test/v1/oauth-broker/callback/slack",
        schemaVersion: 1,
      }),
    ).toMatchObject({ providerApplicationRevision: 2 });
  });

  it("classifies a refused refresh and passes the provider error through bounded", () => {
    const transactionId = HostedOAuthRefreshTransactionIdSchema.parse(`hor_${crypto.randomUUID()}`);
    const response = {
      expiresAt: "2030-01-01T00:00:00.000Z",
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      status: "failed",
      transactionId,
    };
    expect(CreateHostedOAuthRefreshResponseSchema.parse(response)).toEqual(response);
    expect(
      CreateHostedOAuthRefreshResponseSchema.parse({
        ...response,
        failureCode: null,
        providerError: null,
        status: "sealed",
      }).providerError,
    ).toBeNull();
    expect(
      CreateHostedOAuthRefreshResponseSchema.safeParse({ ...response, providerError: "Not A Code" })
        .success,
    ).toBe(false);
    expect(
      CreateHostedOAuthRefreshResponseSchema.safeParse({
        ...response,
        providerError: "e".repeat(65),
      }).success,
    ).toBe(false);
    expect(
      PullHostedOAuthRefreshResponseSchema.parse({
        ...response,
        failureCode: "client-rejected",
        providerError: "invalid_client",
        sealedResult: null,
      }),
    ).toMatchObject({ failureCode: "client-rejected", providerError: "invalid_client" });
    expect(
      PullHostedOAuthRefreshResponseSchema.safeParse({
        expiresAt: response.expiresAt,
        failureCode: response.failureCode,
        sealedResult: null,
        status: response.status,
        transactionId,
      }).success,
    ).toBe(false);
  });

  it("binds hosted revocation to the Account, deployment, provider revision, and transaction", () => {
    const transactionId = HostedOAuthRevocationTransactionIdSchema.parse(
      `hov_${crypto.randomUUID()}`,
    );
    const context = {
      accountSubject,
      authorizationDigest: "c".repeat(43),
      definitionId: "discord",
      deploymentAuthorityDigest: "a".repeat(43),
      expiresAt: "2030-01-01T00:00:00.000Z",
      provider: "discord",
      providerApplicationRevision: 1,
      schemaVersion: 1 as const,
      transactionId,
    };
    expect(OAuthBrokerRevocationContextSchema.parse(context)).toEqual(context);
    const request = {
      ...context,
      brokerSealedCredential: {
        ciphertext: "c2VhbGVk",
        ephemeralPublicKey: "b".repeat(43),
        nonce: "n".repeat(16),
        tag: "t".repeat(22),
        version: 1 as const,
      },
    };
    const { schemaVersion: _schemaVersion, ...wireRequest } = request;
    expect(CreateHostedOAuthRevocationRequestSchema.parse(wireRequest)).toMatchObject({
      provider: "discord",
      transactionId,
    });
    expect(
      CreateHostedOAuthRevocationRequestSchema.safeParse({
        ...wireRequest,
        refreshToken: "must-be-sealed",
      }).success,
    ).toBe(false);
    expect(
      CreateHostedOAuthRevocationResponseSchema.parse({ revoked: true, transactionId }),
    ).toEqual({ revoked: true, transactionId });
  });
});
