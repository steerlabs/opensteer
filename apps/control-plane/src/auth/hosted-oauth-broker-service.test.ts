import { brokerProviderFixture } from "./hosted-oauth-broker.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { providerScenario } from "./hosted-oauth-broker-provider.test-support.js";
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
          ...brokerProviderFixture("github"),
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
    });
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

describe("plugin provider grants", () => {
  const microsoftScopes = ["offline_access", "Mail.ReadWrite", "Mail.Send"];
  const microsoftGrantedScopes = ["Mail.ReadWrite", "Mail.Send", "User.Read"];
  const qualifiedMicrosoftScopes = microsoftGrantedScopes
    .map((scope) => `https://graph.microsoft.com/${scope}`)
    .join(" ");

  it("completes API-only Microsoft sign-in with previously consented Graph scopes", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({
        access_token: "microsoft-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: qualifiedMicrosoftScopes,
        token_type: "Bearer",
        id_token: "incidental.jwt.is-not-identity",
      });
    });
    const s = providerScenario("microsoft", fetch, microsoftScopes);
    const started = await s.begin();
    expect(started.url.origin + started.url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(started.url.searchParams.get("scope")).toBe(microsoftScopes.join(" "));
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
      await started.complete({
        iss: "https://login.microsoftonline.com/tenant/v2.0",
        session_state: "extension",
      }),
    ).toMatchObject({ status: "sealed" });
    const exchange = calls[0]!;
    expect(exchange.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(await exchange.text());
    expect(exchange.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(body)).toMatchObject({
      client_id: "microsoft-client",
      client_secret: "microsoft-secret",
      grant_type: "authorization_code",
      redirect_uri: s.request.binding.redirectUrl,
    });
    expect(s.verifierDigest(body.get("code_verifier")!)).toBe(
      started.url.searchParams.get("code_challenge"),
    );
    expect(s.authorizationBundle()).toEqual({
      accessToken: "microsoft-access",
      expiresAt: s.now.getTime() + 3600_000,
      refreshToken: "rotated-refresh",
      grantedScopes: microsoftGrantedScopes,
      tokenType: "bearer",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.broker.metadata().pluginProviders?.microsoft).not.toHaveProperty("revocationUrl");
    const before = calls.length;
    await expect(s.broker.revoke(s.authority, s.revocationRequest())).rejects.toMatchObject({
      code: "bad_request",
      message: "Hosted OAuth provider does not declare token revocation",
    });
    expect(calls).toHaveLength(before);
  });

  it("renews Microsoft with the exact requested scopes and keeps allowed cumulative grants", async () => {
    let request: Request | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: qualifiedMicrosoftScopes,
        token_type: "Bearer",
        id_token: "incidental.jwt.is-not-identity",
      });
    });
    const s = providerScenario("microsoft", fetch, microsoftScopes);
    const refresh = s.refreshRequest(qualifiedMicrosoftScopes.split(" "));
    expect(await s.broker.refresh(s.authority, refresh)).toMatchObject({ status: "sealed" });
    expect(request!.url).toBe(s.application.oauth.tokenUrl);
    expect(request!.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(await request!.text()))).toEqual({
      client_id: "microsoft-client",
      client_secret: "microsoft-secret",
      grant_type: "refresh_token",
      refresh_token: "original-refresh",
      scope: microsoftScopes.join(" "),
    });
    expect(s.refreshBundle(refresh)).toEqual({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      expiresAt: s.now.getTime() + 3600_000,
      grantedScopes: microsoftGrantedScopes,
      tokenType: "bearer",
    });
  });

  it("records the scopes sent on refresh when the provider omits an unchanged scope", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "new-access", token_type: "Bearer" }),
    );
    const s = providerScenario("microsoft", fetch, microsoftScopes);
    const refresh = s.refreshRequest(microsoftGrantedScopes);
    expect(await s.broker.refresh(s.authority, refresh)).toMatchObject({ status: "sealed" });
    expect(s.refreshBundle(refresh).grantedScopes).toEqual(microsoftScopes);
  });

  it.each([
    ["outside the registry", [...microsoftGrantedScopes, "Directory.ReadWrite.All"]],
    ["missing a requested permission", ["Mail.ReadWrite", "User.Read"]],
  ])("refuses a grant %s at sign-in and refresh", async (_reason, scopes) => {
    const fetch = vi.fn(async () =>
      Response.json({
        access_token: "rejected-access",
        refresh_token: "rejected-refresh",
        scope: scopes.map((scope) => `https://graph.microsoft.com/${scope}`).join(" "),
        token_type: "Bearer",
      }),
    );
    const s = providerScenario("microsoft", fetch, microsoftScopes);
    const started = await s.begin();
    expect(await started.complete()).toMatchObject({
      status: "failed",
      failureCode: "scope-escalation",
    });
    expect(s.store.sealAttempt).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    await expect(s.broker.refresh(s.authority, s.refreshRequest(scopes))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const refresh = s.refreshRequest(microsoftGrantedScopes);
    await expect(s.broker.refresh(s.authority, refresh)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.store.failRefresh).toHaveBeenCalledWith(
      refresh.transactionId,
      "scope-escalation",
      null,
      s.now,
    );
    expect(s.store.sealRefresh).not.toHaveBeenCalled();
  });

  it("exchanges and refreshes GitHub App user tokens with PKCE, without OAuth scopes or an installation grant", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({
        access_token: "ghu_access",
        refresh_token: "ghr_rotated",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
        scope: "",
        token_type: "bearer",
      });
    });
    const s = providerScenario("github", fetch);
    const started = await s.begin();
    expect(started.url.origin + started.url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.url.searchParams.has("scope")).toBe(false);
    expect(s.broker.metadata().installationUrls.github).toBe(
      "https://github.com/apps/opensteer/installations/new",
    );
    expect(await started.complete()).toMatchObject({ status: "sealed" });
    const exchange = new URLSearchParams(await calls[0]!.text());
    expect(exchange.get("client_secret")).toBe("github-secret");
    expect(exchange.has("scope")).toBe(false);
    expect(s.verifierDigest(exchange.get("code_verifier")!)).toBe(
      started.url.searchParams.get("code_challenge"),
    );
    expect(s.authorizationBundle()).toEqual({
      accessToken: "ghu_access",
      refreshToken: "ghr_rotated",
      expiresAt: s.now.getTime() + 28_800_000,
      grantedScopes: [],
      tokenType: "bearer",
    });
    const refresh = s.refreshRequest();
    expect(await s.broker.refresh(s.authority, refresh)).toMatchObject({ status: "sealed" });
    expect(calls[1]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[1]!.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(await calls[1]!.text()))).toEqual({
      client_id: "github-client",
      client_secret: "github-secret",
      grant_type: "refresh_token",
      refresh_token: "original-refresh",
    });
    expect(s.refreshBundle(refresh)).toMatchObject({
      accessToken: "ghu_access",
      refreshToken: "ghr_rotated",
      grantedScopes: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses Discord's confidential flow without PKCE and revokes with the broker's client", async () => {
    const calls: Request[] = [];
    let failRevocation = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith("/revoke"))
        return new Response(failRevocation ? "discord-secret rotated-refresh" : null, {
          status: failRevocation ? 400 : 200,
        });
      return Response.json({
        access_token: "discord-access",
        refresh_token: "rotated-refresh",
        expires_in: 604_800,
        scope: "identify email guilds",
        token_type: "Bearer",
      });
    });
    const s = providerScenario("discord", fetch);
    const started = await s.begin();
    expect(started.url.origin + started.url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(started.url.searchParams.get("scope")).toBe("identify email guilds");
    expect(started.url.searchParams.get("prompt")).toBe("consent");
    expect(started.url.searchParams.has("code_challenge")).toBe(false);
    expect(await started.complete()).toMatchObject({ status: "sealed" });
    expect(Object.fromEntries(new URLSearchParams(await calls[0]!.text()))).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      grant_type: "authorization_code",
      code: "provider-code",
      redirect_uri: s.request.binding.redirectUrl,
    });
    const refresh = s.refreshRequest();
    expect(await s.broker.refresh(s.authority, refresh)).toMatchObject({ status: "sealed" });
    expect(Object.fromEntries(new URLSearchParams(await calls[1]!.text()))).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      grant_type: "refresh_token",
      refresh_token: "original-refresh",
      scope: "identify email guilds",
    });
    expect(s.refreshBundle(refresh)).toMatchObject({ refreshToken: "rotated-refresh" });
    const revoke = s.revocationRequest();
    expect(await s.broker.revoke(s.authority, revoke)).toMatchObject({ revoked: true });
    expect(calls[2]!.url).toBe("https://discord.com/api/v10/oauth2/token/revoke");
    expect(calls[2]!.headers.has("authorization")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(await calls[2]!.text()))).toEqual({
      client_id: "discord-client",
      client_secret: "discord-secret",
      token: "rotated-refresh",
    });
    failRevocation = true;
    await expect(s.broker.revoke(s.authority, revoke)).rejects.toMatchObject({
      code: "unavailable",
      message: "Hosted OAuth provider did not accept token revocation",
    });
    const before = calls.length;
    for (const change of [
      { registryRevision: 2 },
      { expiresAt: new Date(s.now.getTime() - 1).toISOString() },
      { binding: { ...revoke.binding, accountLinkGeneration: "h".repeat(43) } },
      {
        binding: {
          ...revoke.binding,
          accountSubject: {
            ...revoke.binding.accountSubject,
            subject: `acct_${crypto.randomUUID()}`,
          },
        },
      },
    ]) {
      await expect(s.broker.revoke(s.authority, { ...revoke, ...change })).rejects.toThrow();
    }
    expect(calls).toHaveLength(before);
  });

  it.each(["authorization", "refresh", "revocation"])(
    "refuses expired and overlong %s requests before provider access",
    async (kind) => {
      const fetch = vi.fn(async () => {
        throw new Error("Provider must not be contacted");
      });
      const s = providerScenario("google", fetch);
      const maximum = kind === "authorization" ? 600_000 : 120_000;
      const request =
        kind === "authorization"
          ? s.request
          : kind === "refresh"
            ? s.refreshRequest()
            : s.revocationRequest();
      for (const offset of [0, maximum + 1]) {
        const input = { ...request, expiresAt: new Date(s.now.getTime() + offset).toISOString() };
        const operation =
          kind === "authorization"
            ? s.broker.createAuthorizationAttempt(s.authority, input)
            : kind === "refresh"
              ? s.broker.refresh(s.authority, input)
              : s.broker.revoke(s.authority, input);
        await expect(operation).rejects.toMatchObject({ code: "bad_request" });
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(s.store.createAttempt).not.toHaveBeenCalled();
      expect(s.store.claimRefresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["google", "invalid_grant", "grant-rejected"],
    ["google", "invalid_client", "client-rejected"],
    ["google", "invalid_scope", "provider-exchange-failed"],
    ["github", "bad_refresh_token", "grant-rejected"],
    ["github", "invalid_grant", "grant-rejected"],
    ["microsoft", "invalid_grant", "grant-rejected"],
  ])(
    "classifies %s refresh error %s as %s without exposing the provider body",
    async (provider, providerError, failureCode) => {
      const fetch = vi.fn(async () =>
        Response.json(
          { error: providerError, error_description: "secret-provider-body" },
          { status: 400 },
        ),
      );
      const s = providerScenario(provider, fetch);
      const refresh = s.refreshRequest();
      const result = await s.broker.refresh(s.authority, refresh);
      expect(result).toMatchObject({ status: "failed", failureCode, providerError });
      expect(s.store.failRefresh).toHaveBeenCalledWith(
        refresh.transactionId,
        failureCode,
        providerError,
        s.now,
      );
      expect(s.store.sealRefresh).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("secret-provider-body");
    },
  );

  it.each(["http", "transport", "unbounded-code"])(
    "keeps a %s refresh failure unattributed and safe",
    async (kind) => {
      const fetch = vi.fn(async () => {
        if (kind === "transport") throw new Error("original-refresh provider-secret");
        return kind === "http"
          ? new Response("provider-secret", { status: 503 })
          : Response.json(
              { error: "Not A Bounded Code", error_description: "provider-secret" },
              { status: 400 },
            );
      });
      const s = providerScenario("google", fetch);
      const result = await s.broker.refresh(s.authority, s.refreshRequest());
      expect(result).toMatchObject({
        status: "failed",
        failureCode: "provider-exchange-failed",
        providerError: null,
      });
      expect(JSON.stringify(result)).not.toContain("provider-secret");
    },
  );
});
