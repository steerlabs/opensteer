import { createHash } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  CreateHostedOAuthAttemptRequestSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRevocationTransactionIdSchema,
  HostedOAuthRefreshTransactionIdSchema,
  OAuthBrokerAuthorizationContextSchema,
  OAuthBrokerRefreshContextSchema,
  OAuthBrokerRevocationContextSchema,
  OAuthBrokerTokenBundleSchema,
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
import { describe, expect, it, vi } from "vitest";
import type { HostedOAuthAttemptDurableInput } from "./hosted-oauth-broker-store.js";
import {
  assertHostedOAuthAccountLink,
  HostedOAuthBrokerService,
  scopeDigest,
} from "./hosted-oauth-broker-service.js";

describe("HostedOAuthBrokerService authority", () => {
  it("publishes the configured install page for the exact hosted GitHub App", () => {
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "github-client",
          clientSecret: "github-secret",
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          provider: "github",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 6).toString("base64url"),
      issuer: new URL("https://accounts.opensteer.test"),
      store: {} as never,
    });

    expect(broker.metadata()).toMatchObject({
      installationUrls: {
        github: "https://github.com/apps/opensteer/installations/new",
      },
      providerRevisions: { github: 1 },
    });
    expect(broker.metadata(false)).not.toHaveProperty("installationUrls");
  });

  it("rejects link mismatch even when an email could be equal", () => {
    const presentedAccount = {
      email: "same-person@example.test",
      issuer: "https://accounts.opensteer.test",
      subject: `acct_${crypto.randomUUID()}`,
    };
    expect(() =>
      assertHostedOAuthAccountLink(
        presentedAccount,
        "https://accounts.opensteer.test",
        `acct_${crypto.randomUUID()}`,
      ),
    ).toThrow("Account link does not match");
  });

  it("uses an order-independent exact scope digest", () => {
    expect(scopeDigest(["openid", "email", "profile"])).toBe(
      scopeDigest(["profile", "openid", "email", "email"]),
    );
    expect(scopeDigest(["openid", "email"])).not.toBe(scopeDigest(["openid", "email", "profile"]));
  });
});

describe("HostedOAuthBrokerService authorization session", () => {
  it("keeps transaction context server-side and accepts Google response extensions", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    type AttemptRow = Omit<
      HostedOAuthAttemptDurableInput,
      "contextKeyVersion" | "encryptedContext" | "launchTicketHash"
    > & {
      readonly contextKeyVersion: number | null;
      readonly createdAt: Date;
      readonly encryptedContext: Buffer | null;
      readonly failureCode: string | null;
      readonly launchTicketHash: string | null;
      readonly retryGeneration: number;
      readonly sealedCiphertext: OAuthBrokerSealedEnvelope | null;
      readonly status: "pending" | "launched" | "exchanging" | "sealed" | "denied" | "failed";
      readonly updatedAt: Date;
    };
    let row: AttemptRow | null = null;
    const currentRow = (): AttemptRow => {
      if (!row) throw new Error("Attempt is unavailable");
      return row;
    };
    const createAttempt = vi.fn(async (input: HostedOAuthAttemptDurableInput, createdAt: Date) => {
      row ??= {
        ...input,
        createdAt,
        failureCode: null,
        retryGeneration: 0,
        sealedCiphertext: null,
        status: "pending",
        updatedAt: createdAt,
      };
      return row;
    });
    const launchAttempt = vi.fn(
      async (input: {
        accountId: string;
        attemptId: typeof attemptId;
        launchTicketHash: string;
        now: Date;
      }) => {
        if (
          !row ||
          input.accountId !== accountId ||
          input.attemptId !== row.attemptId ||
          input.launchTicketHash !== row.launchTicketHash ||
          row.status !== "pending"
        ) {
          return null;
        }
        row = { ...row, launchTicketHash: null, status: "launched" };
        return row;
      },
    );
    const claimCallback = vi.fn(async (stateHash: string) => {
      if (!row || row.status !== "launched" || row.stateHash !== stateHash) return null;
      row = { ...row, status: "exchanging" };
      return row;
    });
    const sealAttempt = vi.fn(
      async (_attemptId: typeof attemptId, sealedCiphertext: OAuthBrokerSealedEnvelope) => {
        if (!row) throw new Error("Attempt is unavailable");
        row = {
          ...row,
          contextKeyVersion: null,
          encryptedContext: null,
          launchTicketHash: null,
          sealedCiphertext,
          status: "sealed",
        };
      },
    );
    const definition = integrationDefinitions.find((candidate) => candidate.id === "google-gmail");
    if (!definition) throw new Error("Google Gmail test definition is unavailable");
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
    if (!method || method.kind !== "oauth")
      throw new Error("Google Gmail OAuth method is unavailable");
    const requestedScopes = method.oauth.scopes;
    const failAttempt = vi.fn(async () => undefined);
    const providerFetch = vi.fn(async () =>
      Response.json(
        {
          access_token: "google-access-token",
          expires_in: 3_600,
          refresh_token: "google-refresh-token",
          scope: requestedScopes.join(" "),
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      ),
    );
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
      store: {
        claimCallback,
        createAttempt,
        deploymentBinding: vi.fn(async () => binding),
        failAttempt,
        hasDeploymentAccess: vi.fn(async () => true),
        launchAttempt,
        sealAttempt,
      } as never,
    });
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const request = CreateHostedOAuthAttemptRequestSchema.parse({
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      attemptId,
      authorizationDigest: authorizationDigest(definition),
      definitionId: definition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      hostPublicKey: recipient.publicKey,
      provider: "google",
      providerApplicationRevision: 1,
      returnPath: "/settings/integrations?view=accounts",
    });
    const authority = {
      credentialHash: "unused",
      deploymentId,
      hostInstanceId,
    };

    const created = await broker.createAuthorizationAttempt(authority, request);
    const launchUrl = new URL(created.launchUrl);
    const launchTicket = launchUrl.searchParams.get("ticket")!;
    expect(launchTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(launchUrl.searchParams.has("payload")).toBe(false);
    expect(created.launchUrl.length).toBeLessThan(256);
    expect(currentRow().encryptedContext).toBeInstanceOf(Buffer);

    const authorizationUrl = new URL(
      await broker.launchAuthorization(accountId, attemptId, launchTicket),
    );
    const state = authorizationUrl.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(state).not.toBe(launchTicket);
    expect(state).not.toContain("hbs1");

    const completed = await broker.completeAuthorization({
      parameters: new URLSearchParams({
        authuser: "0",
        code: "google-authorization-code",
        future_google_field: "accepted",
        iss: "https://accounts.google.com",
        prompt: "consent",
        scope: requestedScopes.join(" "),
        state,
      }),
      provider: "google",
    });
    expect(completed).toEqual({
      attemptId,
      returnUrl: `https://host.example.test/settings/integrations?view=accounts&integrationAttempt=ioa_${attemptId.slice("hoa_".length)}`,
      status: "sealed",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(failAttempt).not.toHaveBeenCalled();
    expect(sealAttempt).toHaveBeenCalledOnce();
    expect(currentRow().encryptedContext).toBeNull();

    row = null;
    const changedAttemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
    const changedRequest = CreateHostedOAuthAttemptRequestSchema.parse({
      ...request,
      attemptId: changedAttemptId,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
    });
    const changedCreated = await broker.createAuthorizationAttempt(authority, changedRequest);
    const changedLaunchTicket = new URL(changedCreated.launchUrl).searchParams.get("ticket")!;
    const changedAuthorizationUrl = new URL(
      await broker.launchAuthorization(accountId, changedAttemptId, changedLaunchTicket),
    );
    binding.activeHostInstanceId = createId("hostInstance");
    const rejected = await broker.completeAuthorization({
      parameters: new URLSearchParams({
        code: "must-not-be-exchanged",
        iss: "https://accounts.google.com",
        state: changedAuthorizationUrl.searchParams.get("state")!,
      }),
      provider: "google",
    });
    expect(rejected).toEqual({
      attemptId: changedAttemptId,
      status: "failed",
      failureCode: "account-link-mismatch",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(failAttempt).toHaveBeenLastCalledWith(
      changedAttemptId,
      "failed",
      "account-link-mismatch",
      now,
    );
  });
});

describe("HostedOAuthBrokerService Microsoft authorization", () => {
  it("uses the common authority, exact delegated scopes, PKCE, and body client authentication", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
    const definition = integrationDefinitions.find(
      (candidate) => candidate.id === "microsoft-outlook-mail",
    );
    if (!definition) throw new Error("Microsoft Outlook Mail test definition is unavailable");
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
    if (!method || method.kind !== "oauth") {
      throw new Error("Microsoft Outlook Mail OAuth method is unavailable");
    }
    const requestedScopes = method.oauth.scopes;
    const microsoftTokenScopes = [
      "openid",
      "profile",
      "email",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
      "https://graph.microsoft.com/MailboxSettings.ReadWrite",
    ];
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    type AttemptRow = Omit<
      HostedOAuthAttemptDurableInput,
      "contextKeyVersion" | "encryptedContext" | "launchTicketHash"
    > & {
      readonly contextKeyVersion: number | null;
      readonly createdAt: Date;
      readonly encryptedContext: Buffer | null;
      readonly failureCode: string | null;
      readonly launchTicketHash: string | null;
      readonly retryGeneration: number;
      readonly sealedCiphertext: OAuthBrokerSealedEnvelope | null;
      readonly status: "pending" | "launched" | "exchanging" | "sealed" | "denied" | "failed";
      readonly updatedAt: Date;
    };
    let row: AttemptRow | null = null;
    const currentRow = (): AttemptRow => {
      if (!row) throw new Error("Attempt is unavailable");
      return row;
    };
    const failAttempt = vi.fn(async () => undefined);
    const store = {
      claimCallback: vi.fn(async (stateHash: string) => {
        if (!row || row.status !== "launched" || row.stateHash !== stateHash) return null;
        row = { ...row, status: "exchanging" };
        return row;
      }),
      createAttempt: vi.fn(
        async (input: HostedOAuthAttemptDurableInput, createdAt: Date): Promise<AttemptRow> => {
          row ??= {
            ...input,
            createdAt,
            failureCode: null,
            retryGeneration: 0,
            sealedCiphertext: null,
            status: "pending",
            updatedAt: createdAt,
          };
          return row;
        },
      ),
      deploymentBinding: vi.fn(async () => binding),
      failAttempt,
      hasDeploymentAccess: vi.fn(async () => true),
      launchAttempt: vi.fn(
        async (input: {
          accountId: string;
          attemptId: typeof attemptId;
          launchTicketHash: string;
        }) => {
          if (
            !row ||
            row.status !== "pending" ||
            input.accountId !== accountId ||
            input.attemptId !== row.attemptId ||
            input.launchTicketHash !== row.launchTicketHash
          ) {
            return null;
          }
          row = { ...row, launchTicketHash: null, status: "launched" };
          return row;
        },
      ),
      sealAttempt: vi.fn(
        async (_attemptId: typeof attemptId, sealedCiphertext: OAuthBrokerSealedEnvelope) => {
          row = {
            ...currentRow(),
            contextKeyVersion: null,
            encryptedContext: null,
            launchTicketHash: null,
            sealedCiphertext,
            status: "sealed",
          };
        },
      ),
    };
    const capturedTokenRequest = {
      body: null as URLSearchParams | null,
      headers: null as Headers | null,
    };
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      capturedTokenRequest.body = new URLSearchParams(await request.clone().text());
      capturedTokenRequest.headers = request.headers;
      return Response.json(
        {
          access_token: "microsoft-access-token",
          expires_in: 3_600,
          refresh_token: "microsoft-refresh-token",
          // Microsoft does not return offline_access because it is a request for a refresh token,
          // and it may qualify Graph grants even when the authorize request used short names.
          scope: microsoftTokenScopes.join(" "),
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "microsoft-client",
          clientSecret: "microsoft-secret",
          provider: "microsoft",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 9).toString("base64url"),
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      store: store as never,
    });
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const request = CreateHostedOAuthAttemptRequestSchema.parse({
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      attemptId,
      authorizationDigest: authorizationDigest(definition),
      definitionId: definition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      hostPublicKey: recipient.publicKey,
      provider: "microsoft",
      providerApplicationRevision: 1,
      returnPath: "/settings/integrations?view=accounts",
    });
    const authority = { credentialHash: "unused", deploymentId, hostInstanceId };

    const created = await broker.createAuthorizationAttempt(authority, request);
    const launchTicket = new URL(created.launchUrl).searchParams.get("ticket")!;
    const authorizationUrl = new URL(
      await broker.launchAuthorization(accountId, attemptId, launchTicket),
    );

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("microsoft-client");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://accounts.opensteer.test/v1/oauth-broker/callback/microsoft",
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(new Set(authorizationUrl.searchParams.get("scope")?.split(" "))).toEqual(
      new Set(requestedScopes),
    );
    expect(requestedScopes).toEqual([
      "offline_access",
      "openid",
      "profile",
      "email",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
    ]);
    const state = authorizationUrl.searchParams.get("state")!;
    const codeChallenge = authorizationUrl.searchParams.get("code_challenge")!;

    await expect(
      broker.completeAuthorization({
        parameters: new URLSearchParams({
          client_info: "tenant-specific-extension",
          code: "microsoft-authorization-code",
          // The common authority can return a tenant-specific issuer. The catalog intentionally
          // leaves issuer validation unset and binds the response with state and the token request.
          iss: "https://login.microsoftonline.com/tenant-id/v2.0",
          session_state: crypto.randomUUID(),
          state,
        }),
        provider: "microsoft",
      }),
    ).resolves.toEqual({
      attemptId,
      returnUrl: `https://host.example.test/settings/integrations?view=accounts&integrationAttempt=ioa_${attemptId.slice("hoa_".length)}`,
      status: "sealed",
    });

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(failAttempt).not.toHaveBeenCalled();
    expect(capturedTokenRequest.headers?.has("authorization")).toBe(false);
    expect(Object.fromEntries(capturedTokenRequest.body!)).toMatchObject({
      client_id: "microsoft-client",
      client_secret: "microsoft-secret",
      code: "microsoft-authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://accounts.opensteer.test/v1/oauth-broker/callback/microsoft",
    });
    const verifier = capturedTokenRequest.body!.get("code_verifier")!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(codeChallenge);

    const sealingContext = OAuthBrokerAuthorizationContextSchema.parse({
      accountSubject: request.accountSubject,
      attemptId,
      authorizationDigest: request.authorizationDigest,
      definitionId: request.definitionId,
      deploymentAuthorityDigest: request.deploymentAuthorityDigest,
      expiresAt,
      providerApplicationRevision: 1,
      schemaVersion: 1,
    });
    expect(
      OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          currentRow().sealedCiphertext!,
          recipient.privateKey,
          sealingContext,
        ),
      ),
    ).toEqual({
      accessToken: "microsoft-access-token",
      expiresAt: now.getTime() + 3_600_000,
      grantedScopes: requestedScopes.filter((scope) => scope !== "offline_access"),
      refreshToken: "microsoft-refresh-token",
      tokenType: "bearer",
    });
  });
});

describe("HostedOAuthBrokerService refresh failure classification", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const definition = integrationDefinitions.find((candidate) => candidate.id === "google-gmail");
  if (!definition) throw new Error("Google Gmail test definition is unavailable");
  const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
  if (!method || method.kind !== "oauth")
    throw new Error("Google Gmail OAuth method is unavailable");
  const definitionId = definition.id;
  const definitionDigest = authorizationDigest(definition);
  const grantedScopes = method.oauth.scopes;

  function refreshScenario(providerFetch: typeof globalThis.fetch) {
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const transactionId = HostedOAuthRefreshTransactionIdSchema.parse(`hor_${crypto.randomUUID()}`);
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    let row = {
      accountSubject: accountId,
      deploymentId,
      expiresAt: new Date(expiresAt),
      failureCode: null as string | null,
      hostPublicKey: generateOAuthBrokerEphemeralKeyPair().publicKey,
      provider: "google",
      providerApplicationRevision: 1,
      providerError: null as string | null,
      sealedCiphertext: null as OAuthBrokerSealedEnvelope | null,
      status: "pending" as "pending" | "sealed" | "failed",
      transactionId,
    };
    const failRefresh = vi.fn(
      async (
        _transactionId: typeof transactionId,
        failureCode: string,
        providerError: string | null,
      ) => {
        row = { ...row, failureCode, providerError, status: "failed" };
      },
    );
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
      store: {
        claimRefresh: vi.fn(async () => ({ claimed: true as const, row })),
        deploymentBinding: vi.fn(async () => binding),
        failRefresh,
        hasDeploymentAccess: vi.fn(async () => true),
        sealRefresh: vi.fn(async () => undefined),
      } as never,
    });
    const context = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: definitionDigest,
      definitionId,
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
      definitionId: context.definitionId,
      deploymentAuthorityDigest: context.deploymentAuthorityDigest,
      expiresAt,
      grantedScopes,
      hostPublicKey: row.hostPublicKey,
      provider: "google",
      providerApplicationRevision: 1,
      transactionId,
    };
    const authority = {
      credentialHash: "unused",
      deploymentId,
      hostInstanceId,
    };
    return {
      broker,
      currentRow: () => row,
      failRefresh,
      refresh: () => broker.refresh(authority, request),
      transactionId,
    };
  }

  const oauthError = (error: string) =>
    vi.fn(async () =>
      Response.json({ error }, { headers: { "cache-control": "no-store" }, status: 400 }),
    ) as unknown as typeof globalThis.fetch;

  it("reports a rejected grant so the Host knows reconnecting is the only recovery", async () => {
    const scenario = refreshScenario(oauthError("invalid_grant"));
    await expect(scenario.refresh()).resolves.toEqual({
      expiresAt: "2026-08-24T12:01:00.000Z",
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      status: "failed",
      transactionId: scenario.transactionId,
    });
    expect(scenario.failRefresh).toHaveBeenCalledWith(
      scenario.transactionId,
      "grant-rejected",
      "invalid_grant",
      now,
    );
    expect(scenario.currentRow()).toMatchObject({
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      status: "failed",
    });
  });

  it("reports a rejected OAuth client so reconnecting is not offered", async () => {
    const scenario = refreshScenario(oauthError("invalid_client"));
    await expect(scenario.refresh()).resolves.toMatchObject({
      failureCode: "client-rejected",
      providerError: "invalid_client",
      status: "failed",
    });
    expect(scenario.currentRow().failureCode).toBe("client-rejected");
  });

  it("keeps an unattributable provider outage unclassified and carries no error code", async () => {
    const scenario = refreshScenario(
      vi.fn(
        async () => new Response("upstream is down", { status: 503 }),
      ) as unknown as typeof globalThis.fetch,
    );
    await expect(scenario.refresh()).resolves.toMatchObject({
      failureCode: "provider-exchange-failed",
      providerError: null,
      status: "failed",
    });
    expect(scenario.currentRow()).toMatchObject({
      failureCode: "provider-exchange-failed",
      providerError: null,
    });
  });

  it("preserves an unmapped provider error code beside the unclassified failure", async () => {
    const scenario = refreshScenario(oauthError("invalid_scope"));
    await expect(scenario.refresh()).resolves.toMatchObject({
      failureCode: "provider-exchange-failed",
      providerError: "invalid_scope",
      status: "failed",
    });
    expect(scenario.currentRow().providerError).toBe("invalid_scope");
  });
});

describe("HostedOAuthBrokerService Microsoft refresh", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const definition = integrationDefinitions.find(
    (candidate) => candidate.id === "microsoft-outlook-mail",
  );
  if (!definition) throw new Error("Microsoft Outlook Mail test definition is unavailable");
  const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
  if (!method || method.kind !== "oauth") {
    throw new Error("Microsoft Outlook Mail OAuth method is unavailable");
  }
  const microsoftDefinition = definition;
  const microsoftMethod = method;

  function scenario(
    providerFetch: typeof globalThis.fetch,
    grantedScopes: readonly string[] = microsoftMethod.oauth.scopes.filter(
      (scope) => scope !== "offline_access",
    ),
  ) {
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const transactionId = HostedOAuthRefreshTransactionIdSchema.parse(`hor_${crypto.randomUUID()}`);
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const definitionDigest = authorizationDigest(microsoftDefinition);
    const context = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: definitionDigest,
      definitionId: microsoftDefinition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      providerApplicationRevision: 1,
      schemaVersion: 1,
      transactionId,
    });
    let row = {
      accountSubject: accountId,
      deploymentId,
      expiresAt: new Date(expiresAt),
      failureCode: null as string | null,
      hostPublicKey: recipient.publicKey,
      provider: "microsoft",
      providerApplicationRevision: 1,
      providerError: null as string | null,
      sealedCiphertext: null as OAuthBrokerSealedEnvelope | null,
      status: "pending" as "pending" | "sealed" | "failed",
      transactionId,
    };
    const failRefresh = vi.fn(
      async (
        _transactionId: typeof transactionId,
        failureCode: string,
        providerError: string | null,
      ) => {
        row = { ...row, failureCode, providerError, status: "failed" };
      },
    );
    const sealRefresh = vi.fn(
      async (_transactionId: typeof transactionId, sealedCiphertext: OAuthBrokerSealedEnvelope) => {
        row = { ...row, sealedCiphertext, status: "sealed" };
      },
    );
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "microsoft-client",
          clientSecret: "microsoft-secret",
          provider: "microsoft",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 10).toString("base64url"),
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      store: {
        claimRefresh: vi.fn(async () => ({ claimed: true as const, row })),
        deploymentBinding: vi.fn(async () => binding),
        failRefresh,
        hasDeploymentAccess: vi.fn(async () => true),
        sealRefresh,
      } as never,
    });
    const request = {
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      authorizationDigest: definitionDigest,
      brokerSealedCredential: sealOAuthBrokerPayload(
        { refreshToken: "microsoft-original-refresh-token" },
        broker.metadata().encryptionPublicKey,
        context,
      ),
      definitionId: microsoftDefinition.id,
      deploymentAuthorityDigest: context.deploymentAuthorityDigest,
      expiresAt,
      grantedScopes,
      hostPublicKey: recipient.publicKey,
      provider: "microsoft",
      providerApplicationRevision: 1,
      transactionId,
    };
    return {
      context,
      currentRow: () => row,
      failRefresh,
      recipient,
      refresh: () =>
        broker.refresh({ credentialHash: "unused", deploymentId, hostInstanceId }, request),
      transactionId,
    };
  }

  it("sends the prior refresh token with exact scopes and persists Microsoft's rotated token", async () => {
    const capturedRefreshRequest = {
      body: null as URLSearchParams | null,
      headers: null as Headers | null,
    };
    const test = scenario(
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
        capturedRefreshRequest.body = new URLSearchParams(await request.clone().text());
        capturedRefreshRequest.headers = request.headers;
        return Response.json(
          {
            access_token: "microsoft-refreshed-access-token",
            expires_in: 3_600,
            refresh_token: "microsoft-rotated-refresh-token",
            scope: [
              "openid",
              "profile",
              "email",
              "https://graph.microsoft.com/User.Read",
              "https://graph.microsoft.com/Mail.ReadWrite",
              "https://graph.microsoft.com/Mail.Send",
              "https://graph.microsoft.com/MailboxSettings.ReadWrite",
            ].join(" "),
            token_type: "Bearer",
          },
          { headers: { "cache-control": "no-store" } },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    await expect(test.refresh()).resolves.toEqual({
      expiresAt: "2026-08-24T12:01:00.000Z",
      failureCode: null,
      providerError: null,
      status: "sealed",
      transactionId: test.transactionId,
    });
    expect(capturedRefreshRequest.headers?.has("authorization")).toBe(false);
    expect(Object.fromEntries(capturedRefreshRequest.body!)).toMatchObject({
      client_id: "microsoft-client",
      client_secret: "microsoft-secret",
      grant_type: "refresh_token",
      refresh_token: "microsoft-original-refresh-token",
      scope: microsoftMethod.oauth.scopes.join(" "),
    });
    expect(
      OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          test.currentRow().sealedCiphertext!,
          test.recipient.privateKey,
          test.context,
        ),
      ),
    ).toEqual({
      accessToken: "microsoft-refreshed-access-token",
      expiresAt: now.getTime() + 3_600_000,
      grantedScopes: microsoftMethod.oauth.scopes.filter((scope) => scope !== "offline_access"),
      refreshToken: "microsoft-rotated-refresh-token",
      tokenType: "bearer",
    });
  });

  it("classifies Microsoft's invalid_grant response as a dead user grant", async () => {
    const test = scenario(
      vi.fn(async () =>
        Response.json(
          {
            error: "invalid_grant",
            error_codes: [70_008],
            error_description: "The refresh token has expired due to inactivity.",
          },
          { headers: { "cache-control": "no-store" }, status: 400 },
        ),
      ) as unknown as typeof globalThis.fetch,
    );

    await expect(test.refresh()).resolves.toMatchObject({
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      status: "failed",
    });
    expect(test.failRefresh).toHaveBeenCalledWith(
      test.transactionId,
      "grant-rejected",
      "invalid_grant",
      now,
    );
    expect(test.currentRow()).toMatchObject({
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
      sealedCiphertext: null,
      status: "failed",
    });
  });

  it("fails closed when a refreshed Microsoft token loses a functional grant", async () => {
    const test = scenario(
      vi.fn(async () =>
        Response.json(
          {
            access_token: "microsoft-narrowed-access-token",
            refresh_token: "microsoft-rotated-refresh-token",
            scope: [
              "openid",
              "profile",
              "email",
              "https://graph.microsoft.com/User.Read",
              "https://graph.microsoft.com/Mail.ReadWrite",
              "https://graph.microsoft.com/MailboxSettings.ReadWrite",
            ].join(" "),
            token_type: "Bearer",
          },
          { headers: { "cache-control": "no-store" } },
        ),
      ) as unknown as typeof globalThis.fetch,
    );

    await expect(test.refresh()).rejects.toThrow(
      "Hosted OAuth refresh is missing required functional scopes",
    );
    expect(test.failRefresh).toHaveBeenCalledWith(
      test.transactionId,
      "scope-escalation",
      null,
      now,
    );
    expect(test.currentRow()).toMatchObject({
      failureCode: "scope-escalation",
      sealedCiphertext: null,
      status: "failed",
    });
  });

  it("refuses refresh before exchange when a functional Microsoft grant is missing", async () => {
    const providerFetch = vi.fn(async () => {
      throw new Error("provider exchange must not run");
    }) as unknown as typeof globalThis.fetch;
    const test = scenario(
      providerFetch,
      microsoftMethod.oauth.scopes.filter(
        (scope) => scope !== "offline_access" && scope !== "Mail.Send",
      ),
    );

    await expect(test.refresh()).rejects.toThrow(
      "Hosted OAuth refresh is missing required functional scopes",
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("HostedOAuthBrokerService GitHub user tokens", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const definition = integrationDefinitions.find((candidate) => candidate.id === "github");
  if (!definition) throw new Error("GitHub test definition is unavailable");
  const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
  if (!method || method.kind !== "oauth") throw new Error("GitHub OAuth method is unavailable");
  const githubDefinition = definition;

  function authorizationScenario(providerFetch: typeof globalThis.fetch) {
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    type AttemptRow = Omit<
      HostedOAuthAttemptDurableInput,
      "contextKeyVersion" | "encryptedContext" | "launchTicketHash"
    > & {
      readonly contextKeyVersion: number | null;
      readonly createdAt: Date;
      readonly encryptedContext: Buffer | null;
      readonly failureCode: string | null;
      readonly launchTicketHash: string | null;
      readonly retryGeneration: number;
      readonly sealedCiphertext: OAuthBrokerSealedEnvelope | null;
      readonly status: "pending" | "launched" | "exchanging" | "sealed" | "failed";
      readonly updatedAt: Date;
    };
    let row: AttemptRow | null = null;
    const currentRow = (): AttemptRow => {
      if (!row) throw new Error("GitHub attempt is unavailable");
      return row;
    };
    const failAttempt = vi.fn(async () => undefined);
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "Iv23lip88ORd2qUNRuId",
          clientSecret: "github-secret",
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          provider: "github",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 11).toString("base64url"),
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      store: {
        claimCallback: vi.fn(async (stateHash: string) => {
          if (!row || row.status !== "launched" || row.stateHash !== stateHash) return null;
          row = { ...row, status: "exchanging" };
          return row;
        }),
        createAttempt: vi.fn(
          async (input: HostedOAuthAttemptDurableInput, createdAt: Date): Promise<AttemptRow> => {
            row ??= {
              ...input,
              createdAt,
              failureCode: null,
              retryGeneration: 0,
              sealedCiphertext: null,
              status: "pending",
              updatedAt: createdAt,
            };
            return row;
          },
        ),
        deploymentBinding: vi.fn(async () => binding),
        failAttempt,
        hasDeploymentAccess: vi.fn(async () => true),
        launchAttempt: vi.fn(
          async (input: {
            accountId: string;
            attemptId: typeof attemptId;
            launchTicketHash: string;
          }) => {
            if (
              !row ||
              row.status !== "pending" ||
              input.accountId !== accountId ||
              input.attemptId !== row.attemptId ||
              input.launchTicketHash !== row.launchTicketHash
            ) {
              return null;
            }
            row = { ...row, launchTicketHash: null, status: "launched" };
            return row;
          },
        ),
        sealAttempt: vi.fn(
          async (_attemptId: typeof attemptId, sealedCiphertext: OAuthBrokerSealedEnvelope) => {
            row = {
              ...currentRow(),
              contextKeyVersion: null,
              encryptedContext: null,
              launchTicketHash: null,
              sealedCiphertext,
              status: "sealed",
            };
          },
        ),
      } as never,
    });
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const request = CreateHostedOAuthAttemptRequestSchema.parse({
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      attemptId,
      authorizationDigest: authorizationDigest(githubDefinition),
      definitionId: githubDefinition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      hostPublicKey: recipient.publicKey,
      provider: "github",
      providerApplicationRevision: 1,
      returnPath: `/settings/integrations?attempt=${attemptId}`,
    });
    return {
      attemptId,
      authority: { credentialHash: "unused", deploymentId, hostInstanceId },
      broker,
      context: OAuthBrokerAuthorizationContextSchema.parse({
        accountSubject: request.accountSubject,
        attemptId,
        authorizationDigest: request.authorizationDigest,
        definitionId: request.definitionId,
        deploymentAuthorityDigest: request.deploymentAuthorityDigest,
        expiresAt,
        providerApplicationRevision: 1,
        schemaVersion: 1,
      }),
      currentRow,
      failAttempt,
      recipient,
      request,
    };
  }

  function refreshScenario(providerFetch: typeof globalThis.fetch) {
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const transactionId = HostedOAuthRefreshTransactionIdSchema.parse(`hor_${crypto.randomUUID()}`);
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const context = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: authorizationDigest(githubDefinition),
      definitionId: githubDefinition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      providerApplicationRevision: 1,
      schemaVersion: 1,
      transactionId,
    });
    let row = {
      accountSubject: accountId,
      deploymentId,
      expiresAt: new Date(expiresAt),
      failureCode: null as string | null,
      hostPublicKey: recipient.publicKey,
      provider: "github",
      providerApplicationRevision: 1,
      providerError: null as string | null,
      sealedCiphertext: null as OAuthBrokerSealedEnvelope | null,
      status: "pending" as "pending" | "sealed" | "failed",
      transactionId,
    };
    const failRefresh = vi.fn(
      async (
        _transactionId: typeof transactionId,
        failureCode: string,
        providerError: string | null,
      ) => {
        row = { ...row, failureCode, providerError, status: "failed" };
      },
    );
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "Iv23lip88ORd2qUNRuId",
          clientSecret: "github-secret",
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          provider: "github",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 12).toString("base64url"),
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      store: {
        claimRefresh: vi.fn(async () => ({ claimed: true as const, row })),
        deploymentBinding: vi.fn(async () => binding),
        failRefresh,
        hasDeploymentAccess: vi.fn(async () => true),
        sealRefresh: vi.fn(
          async (
            _transactionId: typeof transactionId,
            sealedCiphertext: OAuthBrokerSealedEnvelope,
          ) => {
            row = { ...row, sealedCiphertext, status: "sealed" };
          },
        ),
      } as never,
    });
    const request = {
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      authorizationDigest: context.authorizationDigest,
      brokerSealedCredential: sealOAuthBrokerPayload(
        { refreshToken: "ghr_original" },
        broker.metadata().encryptionPublicKey,
        context,
      ),
      definitionId: githubDefinition.id,
      deploymentAuthorityDigest: context.deploymentAuthorityDigest,
      expiresAt,
      grantedScopes: [],
      hostPublicKey: recipient.publicKey,
      provider: "github",
      providerApplicationRevision: 1,
      transactionId,
    };
    return {
      context,
      currentRow: () => row,
      failRefresh,
      recipient,
      refresh: () =>
        broker.refresh({ credentialHash: "unused", deploymentId, hostInstanceId }, request),
      transactionId,
    };
  }

  it("exchanges a PKCE code with no scope parameter and leaves identity lookup to the Host", async () => {
    const tokenRequest = { body: null as URLSearchParams | null, headers: null as Headers | null };
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe("https://github.com/login/oauth/access_token");
      tokenRequest.body = new URLSearchParams(await request.clone().text());
      tokenRequest.headers = request.headers;
      return Response.json(
        {
          access_token: "ghu_access",
          expires_in: 28_800,
          refresh_token: "ghr_refresh",
          refresh_token_expires_in: 15_897_600,
          scope: "",
          token_type: "bearer",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const test = authorizationScenario(providerFetch);

    const created = await test.broker.createAuthorizationAttempt(test.authority, test.request);
    const launchTicket = new URL(created.launchUrl).searchParams.get("ticket")!;
    const authorizationUrl = new URL(
      await test.broker.launchAuthorization(
        test.request.accountSubject.subject,
        test.attemptId,
        launchTicket,
      ),
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("Iv23lip88ORd2qUNRuId");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://accounts.opensteer.test/v1/oauth-broker/callback/github",
    );
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const codeChallenge = authorizationUrl.searchParams.get("code_challenge")!;
    const state = authorizationUrl.searchParams.get("state")!;

    await expect(
      test.broker.completeAuthorization({
        parameters: new URLSearchParams({ code: "github-code", state }),
        provider: "github",
      }),
    ).resolves.toMatchObject({ attemptId: test.attemptId, status: "sealed" });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(test.failAttempt).not.toHaveBeenCalled();
    expect(tokenRequest.headers?.has("authorization")).toBe(false);
    expect(Object.fromEntries(tokenRequest.body!)).toMatchObject({
      client_id: "Iv23lip88ORd2qUNRuId",
      client_secret: "github-secret",
      code: "github-code",
      grant_type: "authorization_code",
      redirect_uri: "https://accounts.opensteer.test/v1/oauth-broker/callback/github",
    });
    expect(tokenRequest.body!.has("scope")).toBe(false);
    const verifier = tokenRequest.body!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(codeChallenge);
    expect(
      OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          test.currentRow().sealedCiphertext!,
          test.recipient.privateKey,
          test.context,
        ),
      ),
    ).toEqual({
      accessToken: "ghu_access",
      expiresAt: now.getTime() + 28_800_000,
      grantedScopes: [],
      refreshToken: "ghr_refresh",
      tokenType: "bearer",
    });
  });

  it("rotates GitHub's refresh token without sending a scope parameter", async () => {
    const refreshRequest = {
      body: null as URLSearchParams | null,
      headers: null as Headers | null,
    };
    const test = refreshScenario(
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.url).toBe("https://github.com/login/oauth/access_token");
        refreshRequest.body = new URLSearchParams(await request.clone().text());
        refreshRequest.headers = request.headers;
        return Response.json(
          {
            access_token: "ghu_rotated_access",
            expires_in: 28_800,
            refresh_token: "ghr_rotated",
            refresh_token_expires_in: 15_897_600,
            scope: "",
            token_type: "bearer",
          },
          { headers: { "cache-control": "no-store" } },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    await expect(test.refresh()).resolves.toMatchObject({ status: "sealed" });
    expect(refreshRequest.headers?.has("authorization")).toBe(false);
    expect(Object.fromEntries(refreshRequest.body!)).toEqual({
      client_id: "Iv23lip88ORd2qUNRuId",
      client_secret: "github-secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_original",
    });
    expect(
      OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(
          test.currentRow().sealedCiphertext!,
          test.recipient.privateKey,
          test.context,
        ),
      ),
    ).toEqual({
      accessToken: "ghu_rotated_access",
      expiresAt: now.getTime() + 28_800_000,
      grantedScopes: [],
      refreshToken: "ghr_rotated",
      tokenType: "bearer",
    });
  });

  it.each(["invalid_grant", "bad_refresh_token"])(
    "classifies GitHub's %s refresh refusal as a dead user grant",
    async (providerError) => {
      const test = refreshScenario(
        vi.fn(async () =>
          Response.json(
            { error: providerError },
            { headers: { "cache-control": "no-store" }, status: 400 },
          ),
        ) as unknown as typeof globalThis.fetch,
      );
      await expect(test.refresh()).resolves.toMatchObject({
        failureCode: "grant-rejected",
        providerError,
        status: "failed",
      });
      expect(test.failRefresh).toHaveBeenCalledWith(
        test.transactionId,
        "grant-rejected",
        providerError,
        now,
      );
    },
  );
});

describe("HostedOAuthBrokerService Discord tokens", () => {
  it("uses Discord's confidential flow, rotates refresh tokens, and revokes the authorization", async () => {
    const now = new Date("2026-09-18T12:00:00.000Z");
    const definition = integrationDefinitions.find((candidate) => candidate.id === "discord");
    if (!definition) throw new Error("Discord test definition is unavailable");
    const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
    if (!method || method.kind !== "oauth") throw new Error("Discord OAuth method is unavailable");
    expect(method.oauth.scopes).toEqual(["identify", "email", "guilds"]);
    expect(method.oauth.usesPkce).toBe(false);
    expect(method.oauth.clientAuth).toBe("body");

    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
    const refreshTransactionId = HostedOAuthRefreshTransactionIdSchema.parse(
      `hor_${crypto.randomUUID()}`,
    );
    const revocationTransactionId = HostedOAuthRevocationTransactionIdSchema.parse(
      `hov_${crypto.randomUUID()}`,
    );
    const recipient = generateOAuthBrokerEphemeralKeyPair();
    const binding = {
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      id: deploymentId,
      ownerAccountId: accountId,
      reachability: "canonical" as const,
    };
    type AttemptRow = Omit<
      HostedOAuthAttemptDurableInput,
      "contextKeyVersion" | "encryptedContext" | "launchTicketHash"
    > & {
      readonly contextKeyVersion: number | null;
      readonly createdAt: Date;
      readonly encryptedContext: Buffer | null;
      readonly failureCode: string | null;
      readonly launchTicketHash: string | null;
      readonly retryGeneration: number;
      readonly sealedCiphertext: OAuthBrokerSealedEnvelope | null;
      readonly status: "pending" | "launched" | "exchanging" | "sealed" | "failed";
      readonly updatedAt: Date;
    };
    let attemptRow: AttemptRow | null = null;
    const currentAttempt = (): AttemptRow => {
      if (!attemptRow) throw new Error("Discord attempt is unavailable");
      return attemptRow;
    };
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    let refreshRow = {
      accountSubject: accountId,
      deploymentId,
      expiresAt: new Date(expiresAt),
      failureCode: null as string | null,
      hostPublicKey: recipient.publicKey,
      provider: "discord",
      providerApplicationRevision: 1,
      providerError: null as string | null,
      sealedCiphertext: null as OAuthBrokerSealedEnvelope | null,
      status: "pending" as "pending" | "sealed" | "failed",
      transactionId: refreshTransactionId,
    };
    const requests: Array<{ body: URLSearchParams; headers: Headers; url: string }> = [];
    let rejectRevocation = false;
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = new URLSearchParams(await request.clone().text());
      requests.push({ body, headers: request.headers, url: request.url });
      if (request.url.endsWith("/oauth2/token/revoke"))
        return rejectRevocation
          ? new Response("discord-secret discord-rotated-refresh", { status: 400 })
          : new Response(null, { status: 200 });
      if (body.get("grant_type") === "refresh_token") {
        return Response.json(
          {
            access_token: "discord-rotated-access",
            expires_in: 604_800,
            refresh_token: "discord-rotated-refresh",
            scope: "identify email guilds",
            token_type: "Bearer",
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return Response.json(
        {
          access_token: "discord-access",
          expires_in: 604_800,
          refresh_token: "discord-refresh",
          scope: "identify email guilds",
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const broker = new HostedOAuthBrokerService({
      applications: [
        {
          clientId: "discord-client",
          clientSecret: "discord-secret",
          provider: "discord",
          revision: 1,
        },
      ],
      attemptContextEncryptionKey: Buffer.alloc(32, 13).toString("base64url"),
      fetch: providerFetch,
      issuer: new URL("https://accounts.opensteer.test"),
      now: () => now,
      store: {
        claimCallback: vi.fn(async (stateHash: string) => {
          if (!attemptRow || attemptRow.status !== "launched" || attemptRow.stateHash !== stateHash)
            return null;
          attemptRow = { ...attemptRow, status: "exchanging" };
          return attemptRow;
        }),
        claimRefresh: vi.fn(async () => ({ claimed: true as const, row: refreshRow })),
        createAttempt: vi.fn(
          async (input: HostedOAuthAttemptDurableInput, createdAt: Date): Promise<AttemptRow> => {
            attemptRow ??= {
              ...input,
              createdAt,
              failureCode: null,
              retryGeneration: 0,
              sealedCiphertext: null,
              status: "pending",
              updatedAt: createdAt,
            };
            return attemptRow;
          },
        ),
        deploymentBinding: vi.fn(async () => binding),
        failAttempt: vi.fn(async () => undefined),
        failRefresh: vi.fn(async () => undefined),
        hasDeploymentAccess: vi.fn(async () => true),
        launchAttempt: vi.fn(
          async (input: {
            accountId: string;
            attemptId: typeof attemptId;
            launchTicketHash: string;
          }) => {
            if (
              !attemptRow ||
              attemptRow.status !== "pending" ||
              input.accountId !== accountId ||
              input.attemptId !== attemptRow.attemptId ||
              input.launchTicketHash !== attemptRow.launchTicketHash
            )
              return null;
            attemptRow = { ...attemptRow, launchTicketHash: null, status: "launched" };
            return attemptRow;
          },
        ),
        sealAttempt: vi.fn(
          async (_attemptId: typeof attemptId, sealedCiphertext: OAuthBrokerSealedEnvelope) => {
            attemptRow = {
              ...currentAttempt(),
              contextKeyVersion: null,
              encryptedContext: null,
              launchTicketHash: null,
              sealedCiphertext,
              status: "sealed",
            };
          },
        ),
        sealRefresh: vi.fn(
          async (
            _transactionId: typeof refreshTransactionId,
            sealedCiphertext: OAuthBrokerSealedEnvelope,
          ) => {
            refreshRow = { ...refreshRow, sealedCiphertext, status: "sealed" };
          },
        ),
      } as never,
    });
    const authority = { credentialHash: "unused", deploymentId, hostInstanceId };
    const authorizationRequest = CreateHostedOAuthAttemptRequestSchema.parse({
      accountSubject: { issuer: "https://accounts.opensteer.test", subject: accountId },
      attemptId,
      authorizationDigest: authorizationDigest(definition),
      definitionId: definition.id,
      deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
      expiresAt,
      hostPublicKey: recipient.publicKey,
      provider: "discord",
      providerApplicationRevision: 1,
    });
    const created = await broker.createAuthorizationAttempt(authority, authorizationRequest);
    const launchTicket = new URL(created.launchUrl).searchParams.get("ticket")!;
    const authorizationUrl = new URL(
      await broker.launchAuthorization(accountId, attemptId, launchTicket),
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("identify email guilds");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);
    expect(authorizationUrl.searchParams.has("code_challenge_method")).toBe(false);

    const state = authorizationUrl.searchParams.get("state")!;
    await expect(
      broker.completeAuthorization({
        parameters: new URLSearchParams({ code: "discord-code", state }),
        provider: "discord",
      }),
    ).resolves.toMatchObject({ status: "sealed" });
    const exchange = requests[0]!;
    expect(exchange.url).toBe("https://discord.com/api/oauth2/token");
    expect(exchange.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(exchange.body)).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      code: "discord-code",
      grant_type: "authorization_code",
      redirect_uri: "https://accounts.opensteer.test/v1/oauth-broker/callback/discord",
    });
    expect(exchange.body.has("code_verifier")).toBe(false);

    const refreshContext = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: authorizationRequest.authorizationDigest,
      definitionId: definition.id,
      deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
      expiresAt,
      providerApplicationRevision: 1,
      schemaVersion: 1,
      transactionId: refreshTransactionId,
    });
    await expect(
      broker.refresh(authority, {
        accountSubject: authorizationRequest.accountSubject,
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { refreshToken: "discord-refresh" },
          broker.metadata().encryptionPublicKey,
          refreshContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt,
        grantedScopes: ["identify", "email", "guilds"],
        hostPublicKey: recipient.publicKey,
        provider: "discord",
        providerApplicationRevision: 1,
        transactionId: refreshTransactionId,
      }),
    ).resolves.toMatchObject({ status: "sealed" });
    const refresh = requests[1]!;
    expect(refresh.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(refresh.body)).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      grant_type: "refresh_token",
      refresh_token: "discord-refresh",
      scope: "identify email guilds",
    });
    expect(
      OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(refreshRow.sealedCiphertext!, recipient.privateKey, refreshContext),
      ),
    ).toMatchObject({
      accessToken: "discord-rotated-access",
      refreshToken: "discord-rotated-refresh",
    });

    const revocationContext = OAuthBrokerRevocationContextSchema.parse({
      accountSubject: authorizationRequest.accountSubject,
      authorizationDigest: authorizationRequest.authorizationDigest,
      definitionId: definition.id,
      deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
      expiresAt,
      provider: "discord",
      providerApplicationRevision: 1,
      schemaVersion: 1,
      transactionId: revocationTransactionId,
    });
    await expect(
      broker.revoke(authority, {
        accountSubject: authorizationRequest.accountSubject,
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          {
            accessToken: "discord-rotated-access",
            refreshToken: "discord-rotated-refresh",
          },
          broker.metadata().encryptionPublicKey,
          revocationContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt,
        provider: "discord",
        providerApplicationRevision: 1,
        transactionId: revocationTransactionId,
      }),
    ).resolves.toEqual({ revoked: true, transactionId: revocationTransactionId });
    const revocation = requests[2]!;
    expect(revocation.url).toBe("https://discord.com/api/v10/oauth2/token/revoke");
    expect(revocation.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(revocation.body)).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      token: "discord-rotated-refresh",
    });

    const callsAfterSuccess = requests.length;
    const otherAccountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    await expect(
      broker.revoke(authority, {
        accountSubject: {
          issuer: authorizationRequest.accountSubject.issuer,
          subject: otherAccountId,
        },
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { accessToken: "must-not-leak" },
          broker.metadata().encryptionPublicKey,
          revocationContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt,
        provider: "discord",
        providerApplicationRevision: 1,
        transactionId: revocationTransactionId,
      }),
    ).rejects.toThrow();
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterSuccess);

    const expiredTransactionId = HostedOAuthRevocationTransactionIdSchema.parse(
      `hov_${crypto.randomUUID()}`,
    );
    const expiredAt = new Date(now.getTime() - 1).toISOString();
    const expiredContext = OAuthBrokerRevocationContextSchema.parse({
      ...revocationContext,
      expiresAt: expiredAt,
      transactionId: expiredTransactionId,
    });
    await expect(
      broker.revoke(authority, {
        accountSubject: authorizationRequest.accountSubject,
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { accessToken: "must-not-revoke" },
          broker.metadata().encryptionPublicKey,
          expiredContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt: expiredAt,
        provider: "discord",
        providerApplicationRevision: 1,
        transactionId: expiredTransactionId,
      }),
    ).rejects.toThrow("expiry is invalid");
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterSuccess);

    const staleTransactionId = HostedOAuthRevocationTransactionIdSchema.parse(
      `hov_${crypto.randomUUID()}`,
    );
    const staleContext = OAuthBrokerRevocationContextSchema.parse({
      ...revocationContext,
      providerApplicationRevision: 2,
      transactionId: staleTransactionId,
    });
    await expect(
      broker.revoke(authority, {
        accountSubject: authorizationRequest.accountSubject,
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          { accessToken: "must-not-revoke" },
          broker.metadata().encryptionPublicKey,
          staleContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt,
        provider: "discord",
        providerApplicationRevision: 2,
        transactionId: staleTransactionId,
      }),
    ).rejects.toThrow("stale");
    expect(providerFetch).toHaveBeenCalledTimes(callsAfterSuccess);

    rejectRevocation = true;
    const refusedTransactionId = HostedOAuthRevocationTransactionIdSchema.parse(
      `hov_${crypto.randomUUID()}`,
    );
    const refusedContext = OAuthBrokerRevocationContextSchema.parse({
      ...revocationContext,
      transactionId: refusedTransactionId,
    });
    const refusal = await broker
      .revoke(authority, {
        accountSubject: authorizationRequest.accountSubject,
        authorizationDigest: authorizationRequest.authorizationDigest,
        brokerSealedCredential: sealOAuthBrokerPayload(
          {
            accessToken: "discord-rotated-access",
            refreshToken: "discord-rotated-refresh",
          },
          broker.metadata().encryptionPublicKey,
          refusedContext,
        ),
        definitionId: definition.id,
        deploymentAuthorityDigest: authorizationRequest.deploymentAuthorityDigest,
        expiresAt,
        provider: "discord",
        providerApplicationRevision: 1,
        transactionId: refusedTransactionId,
      })
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "unavailable",
      message: "Hosted OAuth provider did not accept token revocation",
    });
    expect(String(refusal)).not.toContain("discord-secret");
    expect(String(refusal)).not.toContain("discord-rotated-refresh");
  });
});
