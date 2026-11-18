import { createHash } from "node:crypto";
import { vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  ControlPlaneAccountIdSchema,
  CreatePluginOAuthAttemptRequestSchema,
  OAuthBrokerPluginAuthorizationContextSchema,
  OAuthBrokerPluginRefreshContextSchema,
  OAuthBrokerPluginRevocationContextSchema,
  OAuthBrokerTokenBundleSchema,
  oauthBrokerManagedTokenContextVersion,
  OAuthBrokerSealedEnvelopeSchema,
} from "@opensteer/control-plane-protocol";
import {
  generateOAuthBrokerEphemeralKeyPair,
  hostedOAuthDeploymentAuthorityDigest,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
} from "@opensteer/control-plane-protocol/broker-sealing";
import { HostedOAuthBrokerService } from "./hosted-oauth-broker-service.js";
import type { HostedOAuthBrokerStore } from "./hosted-oauth-broker-store.js";
import { brokerProviderFixture } from "./hosted-oauth-broker.test-support.js";
import type { HostedOAuthProviderApplication } from "./hosted-oauth-provider-registry.js";

type AttemptRow = Awaited<ReturnType<HostedOAuthBrokerStore["createAttempt"]>>;
type RefreshRow = Awaited<ReturnType<HostedOAuthBrokerStore["claimRefresh"]>>["row"];

export function providerScenario(
  provider: string,
  fetch: typeof globalThis.fetch,
  scopes?: string[],
) {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
  const authority = {
    credentialHash: "unused",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
  };
  const deployment = {
    id: authority.deploymentId,
    activeHostInstanceId: authority.hostInstanceId,
    canonicalOrigin: "https://host.example.test",
    hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    ownerAccountId: accountId,
    reachability: "canonical" as const,
  };
  const recipient = generateOAuthBrokerEphemeralKeyPair();
  const application: HostedOAuthProviderApplication = {
    ...brokerProviderFixture(provider),
    provider,
    revision: 1,
    clientId: `${provider}-client`,
    clientSecret: `${provider}-secret`,
    ...(provider === "github"
      ? { installationUrl: "https://github.com/apps/opensteer/installations/new" }
      : {}),
  };
  if (provider === "microsoft")
    application.oauth = {
      ...application.oauth,
      scopeAliases: Object.fromEntries(
        application.allowedScopes
          .filter((scope) => scope.includes("."))
          .map((scope) => [scope, [`https://graph.microsoft.com/${scope}`]]),
      ),
    };
  let attempt: AttemptRow;
  let refreshed: RefreshRow;
  const store = {
    deploymentBinding: vi.fn(async () => deployment),
    hasDeploymentAccess: vi.fn(async () => true),
    createAttempt: vi.fn<HostedOAuthBrokerStore["createAttempt"]>(async (input) => {
      attempt = {
        ...input,
        returnProofHash: null,
        browserBindingHash: null,
        status: "pending",
        retryGeneration: 0,
        failureCode: null,
        sealedCiphertext: null,
        createdAt: now,
        updatedAt: now,
      };
      return attempt;
    }),
    inspectLaunchAttempt: vi.fn<HostedOAuthBrokerStore["inspectLaunchAttempt"]>(
      async () => attempt,
    ),
    launchAttempt: vi.fn<HostedOAuthBrokerStore["launchAttempt"]>(async (input) => {
      if (attempt.status !== "pending" || input.launchTicketHash !== attempt.launchTicketHash)
        return null;
      attempt = {
        ...attempt,
        status: "launched",
        browserBindingHash: attempt.launchTicketHash,
        launchTicketHash: null,
      };
      return attempt;
    }),
    claimCallback: vi.fn<HostedOAuthBrokerStore["claimCallback"]>(async (input) => {
      if (
        attempt.status !== "launched" ||
        input.provider !== attempt.provider ||
        input.stateHash !== attempt.stateHash ||
        !input.browserBindings.some(
          (binding) =>
            binding.attemptId === attempt.attemptId && binding.hash === attempt.browserBindingHash,
        )
      )
        return null;
      attempt = { ...attempt, status: "exchanging" };
      return attempt;
    }),
    callbackAttemptId: vi.fn(async () => attempt.attemptId),
    failAttempt: vi.fn<HostedOAuthBrokerStore["failAttempt"]>(async (_id, status, failureCode) => {
      attempt = { ...attempt, status, failureCode, encryptedContext: null };
    }),
    sealAttempt: vi.fn<HostedOAuthBrokerStore["sealAttempt"]>(async (_id, sealedCiphertext) => {
      attempt = { ...attempt, status: "sealed", sealedCiphertext, encryptedContext: null };
    }),
    claimRefresh: vi.fn<HostedOAuthBrokerStore["claimRefresh"]>(async (input) => {
      refreshed = {
        ...input,
        requestBindingDigest: input.requestBindingDigest ?? null,
        createdAt: now,
        updatedAt: now,
        failureCode: null,
        providerError: null,
        sealedCiphertext: null,
        status: "pending",
      };
      return { claimed: true as const, row: refreshed };
    }),
    failRefresh: vi.fn<HostedOAuthBrokerStore["failRefresh"]>(
      async (_id, failureCode, providerError) => {
        refreshed = { ...refreshed, status: "failed", failureCode, providerError };
      },
    ),
    sealRefresh: vi.fn<HostedOAuthBrokerStore["sealRefresh"]>(async (_id, sealedCiphertext) => {
      refreshed = { ...refreshed, status: "sealed", sealedCiphertext };
    }),
  };
  const broker = new HostedOAuthBrokerService({
    applications: [application],
    fetch,
    issuer: new URL("https://accounts.example.test"),
    now: () => now,
    attemptContextEncryptionKey: Buffer.alloc(32, 9).toString("base64url"),
    store: store as unknown as HostedOAuthBrokerStore,
  });
  const request = CreatePluginOAuthAttemptRequestSchema.parse({
    kind: "plugin",
    attemptId: `hoa_${crypto.randomUUID()}`,
    provider,
    registryRevision: 1,
    requestedScopes: scopes ?? application.oauth.scopes,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    returnPath: "/plugins",
    binding: {
      accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
      accountLinkGeneration: "g".repeat(43),
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(deployment),
      hostPublicKey: recipient.publicKey,
      requirementDigest: "r".repeat(43),
      redirectUrl: broker.callbackUrl(provider),
    },
  });
  const pins = {
    provider,
    registryRevision: request.registryRevision,
    requestedScopes: request.requestedScopes,
    binding: request.binding,
    expiresAt: request.expiresAt,
    schemaVersion: oauthBrokerManagedTokenContextVersion,
  };
  return {
    broker,
    authority,
    request,
    application,
    now,
    store,
    async begin() {
      const created = await broker.createAuthorizationAttempt(authority, request);
      const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
      const url = new URL(await broker.launchAuthorization(accountId, request.attemptId, ticket));
      return {
        url,
        complete: (extra: Record<string, string> = {}) =>
          broker.completeAuthorization({
            provider,
            parameters: new URLSearchParams({
              state: url.searchParams.get("state")!,
              code: "provider-code",
              ...extra,
            }),
            cookieHeader: `__Secure-opensteer.oauth.${request.attemptId}=${ticket}`,
          }),
      };
    },
    authorizationBundle() {
      return OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          OAuthBrokerSealedEnvelopeSchema.parse(attempt.sealedCiphertext),
          recipient.privateKey,
          OAuthBrokerPluginAuthorizationContextSchema.parse({
            ...pins,
            attemptId: request.attemptId,
          }),
        ),
      );
    },
    refreshRequest(
      grantedScopes = request.requestedScopes.filter((scope) => scope !== "offline_access"),
    ) {
      const context = OAuthBrokerPluginRefreshContextSchema.parse({
        ...pins,
        transactionId: `hor_${crypto.randomUUID()}`,
      });
      const { schemaVersion: _version, ...fields } = context;
      return {
        ...fields,
        kind: "plugin",
        grantedScopes,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { refreshToken: "original-refresh" },
          broker.metadata().encryptionPublicKey,
          context,
        ),
      };
    },
    refreshBundle(input: { transactionId: string }) {
      return OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          OAuthBrokerSealedEnvelopeSchema.parse(refreshed.sealedCiphertext),
          recipient.privateKey,
          OAuthBrokerPluginRefreshContextSchema.parse({
            ...pins,
            transactionId: input.transactionId,
          }),
        ),
      );
    },
    revocationRequest() {
      const context = OAuthBrokerPluginRevocationContextSchema.parse({
        ...pins,
        schemaVersion: 2,
        transactionId: `hov_${crypto.randomUUID()}`,
      });
      const { schemaVersion: _version, ...fields } = context;
      return {
        ...fields,
        kind: "plugin",
        brokerSealedCredential: sealOAuthBrokerPayload(
          { accessToken: "rotated-access", refreshToken: "rotated-refresh" },
          broker.metadata().encryptionPublicKey,
          context,
        ),
      };
    },
    verifierDigest: (value: string) => createHash("sha256").update(value).digest("base64url"),
  };
}
