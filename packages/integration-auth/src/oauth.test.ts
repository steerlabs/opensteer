import { OAuthMethodConfigSchema } from "@opensteer/integration-core";
import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedOAuthEndpointUrl,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  oauthAuthorizationFailure,
  OAuth2Error,
  oauthAuthorizationResponseState,
  oauthFailureKind,
  oauthUserDeniedAuthorization,
  refreshAccessToken,
  shouldRefreshToken,
  validateOAuthAuthorizationResponse,
} from "./oauth.js";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
} from "./discovery.js";
import {
  buildDeclarativeAuthorizationUrl,
  exchangeDeclarativeAuthorizationToken,
  extractDeclarativeCredential,
  missingRequiredScopes,
  refreshDeclarativeCredential,
} from "./flow.js";

const oauthConfig = OAuthMethodConfigSchema.parse({
  authorizationUrl: "https://identity.example/authorize",
  clientAuth: "none",
  tokenUrl: "https://identity.example/token",
  usesPkce: true,
  scopeSeparator: " ",
  extraAuthorizeParams: { audience: "api", prompt: "consent" },
  scopes: ["openid", "profile", "contacts.read"],
  identity: {
    accountIdentifierPath: "account.email",
    source: "userinfo",
    userinfoUrl: "https://identity.example/userinfo",
    identityPath: "account.id",
    tenantPath: "account.tenant.id",
    displayNamePath: "account.name",
  },
});

describe("OAuth primitives", () => {
  it("accepts provider callback extensions and validates the issuer", () => {
    const parameters = new URLSearchParams({
      authuser: "0",
      code: "authorization-code",
      future_google_parameter: "future-value",
      iss: "https://accounts.google.com",
      prompt: "consent",
      scope: "openid email",
      state: "S".repeat(43),
    });
    expect(oauthAuthorizationResponseState(parameters)).toBe("S".repeat(43));
    expect(
      validateOAuthAuthorizationResponse({
        clientId: "google-client",
        issuer: "https://accounts.google.com",
        parameters,
      }),
    ).toEqual({ code: "authorization-code", kind: "success", state: "S".repeat(43) });
  });

  it("returns a provider denial only after state and issuer validation", () => {
    expect(
      validateOAuthAuthorizationResponse({
        clientId: "client",
        issuer: "https://identity.example",
        parameters: new URLSearchParams({
          error: "access_denied",
          error_description: "The user declined",
          iss: "https://identity.example",
          state: "S".repeat(43),
        }),
      }),
    ).toEqual({
      error: "access_denied",
      errorDescription: "The user declined",
      kind: "error",
      state: "S".repeat(43),
    });
  });

  it.each([
    new URLSearchParams({ code: "code", state: "not-a-state" }),
    new URLSearchParams(`code=one&code=two&state=${"S".repeat(43)}`),
    new URLSearchParams(`code=code&state=${"S".repeat(43)}&state=${"T".repeat(43)}`),
    new URLSearchParams({
      code: "code",
      iss: "https://attacker.example",
      state: "S".repeat(43),
    }),
    new URLSearchParams(
      `code=code&iss=https://identity.example&iss=https://attacker.example&state=${"S".repeat(43)}`,
    ),
    new URLSearchParams({ code: "code", error: "access_denied", state: "S".repeat(43) }),
  ])("rejects an ambiguous or unbound authorization response", (parameters) => {
    expect(() =>
      validateOAuthAuthorizationResponse({
        clientId: "client",
        issuer: "https://identity.example",
        parameters,
      }),
    ).toThrow();
  });

  it("skips issuer equality when no issuer is configured but still rejects a duplicate iss", () => {
    expect(
      validateOAuthAuthorizationResponse({
        clientId: "client",
        issuer: null,
        parameters: new URLSearchParams({
          code: "authorization-code",
          iss: "https://login.microsoftonline.com/tenant-id/v2.0",
          state: "S".repeat(43),
        }),
      }),
    ).toEqual({ code: "authorization-code", kind: "success", state: "S".repeat(43) });
    expect(() =>
      validateOAuthAuthorizationResponse({
        clientId: "client",
        issuer: null,
        parameters: new URLSearchParams(
          `code=code&iss=https://one.example&iss=https://two.example&state=${"S".repeat(43)}`,
        ),
      }),
    ).toThrow();
  });

  it.each([
    ["access_denied", true],
    ["consent_required", true],
    ["server_error", false],
    ["temporarily_unavailable", false],
    ["invalid_scope", false],
    ["invalid_client", false],
  ])("classifies %s as a user denial: %s", (error, denied) => {
    expect(oauthUserDeniedAuthorization(error)).toBe(denied);
  });

  it("builds an authorization URL with scopes, PKCE, resource, and extras", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationUrl: "https://identity.example/authorize?existing=yes",
        clientId: "client",
        redirectUrl: "https://app.example/callback",
        scopes: ["one", "two"],
        state: "state",
        codeChallenge: "challenge",
        resource: "https://api.example/mcp",
        extraParams: { prompt: "consent" },
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client",
      redirect_uri: "https://app.example/callback",
      response_type: "code",
      scope: "one two",
      state: "state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: "https://api.example/mcp",
      prompt: "consent",
      existing: "yes",
    });
  });

  it("rejects unsafe endpoint schemes while allowing loopback HTTP", () => {
    expect(() => assertSupportedOAuthEndpointUrl("http://identity.example/token")).toThrow(
      "https: or loopback",
    );
    expect(() => assertSupportedOAuthEndpointUrl("file:///tmp/token")).toThrow();
    expect(assertSupportedOAuthEndpointUrl("http://127.0.0.1:4312/token")).toBe(
      "http://127.0.0.1:4312/token",
    );
  });

  it("uses a 60-second refresh skew and leaves unknown expiry reactive", () => {
    expect(shouldRefreshToken({ expiresAt: 160_000, now: 100_000 })).toBe(true);
    expect(shouldRefreshToken({ expiresAt: 160_001, now: 100_000 })).toBe(false);
    expect(shouldRefreshToken({ expiresAt: null, now: 100_000 })).toBe(false);
  });

  it("classifies token errors by the recovery each one demands", () => {
    expect(oauthFailureKind("invalid_grant")).toBe("grant-rejected");
    expect(oauthFailureKind("bad_refresh_token")).toBe("grant-rejected");
    expect(oauthFailureKind("invalid_client")).toBe("client-rejected");
    expect(oauthFailureKind("incorrect_client_credentials")).toBe("client-rejected");
    expect(oauthFailureKind("unauthorized_client")).toBe("client-rejected");
    expect(oauthFailureKind("invalid_scope")).toBe("unknown");
    expect(oauthFailureKind("temporarily_unavailable")).toBe("unknown");
    expect(oauthFailureKind(undefined)).toBe("unknown");
  });

  it("carries the provider error code out of a rejected refresh", async () => {
    const fetch_ = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const rejected = await refreshAccessToken({
      clientId: "client",
      clientSecret: "secret",
      fetch: fetch_ as typeof fetch,
      refreshToken: "revoked",
      tokenUrl: "https://identity.example/token",
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(OAuth2Error);
    expect((rejected as OAuth2Error).error).toBe("invalid_grant");
    expect(oauthFailureKind((rejected as OAuth2Error).error)).toBe("grant-rejected");
  });

  it("classifies bounded provider errors separately from invalid responses", async () => {
    const rejected = await refreshAccessToken({
      clientId: "client",
      fetch: (async () =>
        Response.json(
          { error: "invalid_grant" },
          { status: 400, headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
      refreshToken: "revoked",
      tokenUrl: "https://identity.example/token",
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(rejected)).toEqual({
      failureCode: "grant-rejected",
      providerError: "invalid_grant",
    });
    expect(
      oauthAuthorizationFailure(
        new OAuth2Error("malformed response", { failureKind: "invalid-response" }),
      ),
    ).toEqual({ failureCode: "invalid-provider-response", providerError: null });
  });

  it("does not expose provider descriptions and rejects bound tokens used with Bearer placements", async () => {
    const providerFailure = await exchangeAuthorizationCode({
      clientId: "client",
      code: "code",
      fetch: (async () =>
        Response.json(
          { error: "invalid_grant", error_description: "secret provider diagnostic" },
          { status: 400, headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
      redirectUrl: "https://app.example/callback",
      tokenUrl: "https://identity.example/token",
    }).catch((error: unknown) => error);
    expect(providerFailure).toBeInstanceOf(OAuth2Error);
    expect((providerFailure as Error).message).not.toContain("secret provider diagnostic");

    const boundToken = await exchangeAuthorizationCode({
      clientId: "client",
      code: "code",
      fetch: (async () =>
        Response.json(
          { access_token: "bound", token_type: "DPoP" },
          { headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
      redirectUrl: "https://app.example/callback",
      tokenUrl: "https://identity.example/token",
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(boundToken)).toEqual({
      failureCode: "invalid-provider-response",
      providerError: null,
    });
  });

  it("classifies standard token endpoint 5xx responses as transport failures", async () => {
    for (const response of [
      new Response("upstream trace", { status: 503 }),
      Response.json(
        { error: "temporarily_unavailable", error_description: "internal provider detail" },
        { status: 502 },
      ),
    ]) {
      const rejected = await exchangeAuthorizationCode({
        clientId: "client",
        code: "code",
        fetch: (async () => response.clone()) as typeof fetch,
        redirectUrl: "https://app.example/callback",
        tokenUrl: "https://identity.example/token",
      }).catch((error: unknown) => error);
      expect(oauthAuthorizationFailure(rejected)).toEqual({
        failureCode: "provider-exchange-failed",
        providerError: null,
      });
      expect((rejected as Error).message).not.toContain("provider detail");
      expect("cause" in (rejected as object)).toBe(false);
    }
  });

  it.each([
    {
      name: "Google",
      response: {
        access_token: "google-access",
        expires_in: 3_600,
        refresh_token: "google-refresh",
        scope: "openid email profile",
        token_type: "Bearer",
      },
    },
    {
      name: "GitHub",
      response: { access_token: "github-access", scope: "", token_type: "bearer" },
    },
    {
      name: "Discord",
      response: {
        access_token: "discord-access",
        expires_in: 604_800,
        refresh_token: "discord-refresh",
        scope: "identify email guilds",
        token_type: "Bearer",
      },
    },
    {
      name: "Microsoft",
      response: {
        access_token: "microsoft-access",
        expires_in: 3_599,
        refresh_token: "microsoft-refresh",
        scope: "openid profile email User.Read",
        token_type: "Bearer",
      },
    },
  ])("accepts a representative $name token response", async ({ response }) => {
    await expect(
      exchangeAuthorizationCode({
        clientId: "client",
        code: "code",
        fetch: (async () =>
          Response.json(response, { headers: { "cache-control": "no-store" } })) as typeof fetch,
        redirectUrl: "https://app.example/callback",
        tokenUrl: "https://identity.example/token",
      }),
    ).resolves.toMatchObject({ access_token: response.access_token, token_type: "bearer" });
  });

  it("accepts Slack's bot token response and preserves its identity fields", async () => {
    const slackConfig = OAuthMethodConfigSchema.parse({
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      clientAuth: "body",
      identity: {
        displayNamePath: "team.name",
        identityPath: "bot_user_id",
        source: "token-response",
        tenantPath: "team.id",
      },
      scopeSeparator: ",",
      scopes: ["chat:write"],
      tokenResponseProfile: "slack-bot",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      usesPkce: false,
    });
    const result = await exchangeDeclarativeAuthorizationToken({
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      config: slackConfig,
      fetch: (async () =>
        Response.json(
          {
            access_token: "xoxb-access",
            bot_user_id: "U012BOT",
            ok: true,
            scope: "chat:write",
            team: { id: "T012TEAM", name: "Acme" },
            token_type: "bot",
          },
          { headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
      redirectUrl: "https://app.example/callback",
    });
    expect(result.tokenResponse).toMatchObject({
      access_token: "xoxb-access",
      bot_user_id: "U012BOT",
      token_type: "bearer",
    });
    expect(result.tokenResponseIdentity).toEqual({
      displayName: "Acme",
      externalIdentityId: "U012BOT",
      externalTenantId: "T012TEAM",
    });
  });

  it("explicitly ignores incidental ID tokens when userinfo is the identity authority", async () => {
    const config = OAuthMethodConfigSchema.parse({
      ...oauthConfig,
      idTokenValidation: "ignore",
    });
    const tokenFetch = vi.fn(async () =>
      Response.json(
        {
          access_token: "microsoft-access",
          id_token: "tenant-specific.jwt.is-not-identity",
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      ),
    );
    const exchanged = await exchangeDeclarativeAuthorizationToken({
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      config,
      fetch: tokenFetch as typeof fetch,
      redirectUrl: "https://app.example/callback",
    });
    expect(exchanged.tokenResponse).toMatchObject({
      access_token: "microsoft-access",
      token_type: "bearer",
    });
    expect(exchanged.tokenResponse).not.toHaveProperty("id_token");

    await expect(
      refreshDeclarativeCredential({
        clientId: "client",
        clientSecret: "secret",
        config,
        fetch: tokenFetch as typeof fetch,
        grantedScopes: config.scopes,
        refreshToken: "refresh",
      }),
    ).resolves.toMatchObject({ accessToken: "microsoft-access" });
  });

  it("forbids ignoring an ID token when token response fields are identity authority", () => {
    expect(() =>
      OAuthMethodConfigSchema.parse({
        ...oauthConfig,
        idTokenValidation: "ignore",
        identity: { source: "token-response", identityPath: "account.id" },
      }),
    ).toThrow("requires userinfo");
  });

  it("turns Slack's HTTP-200 error envelope into a bounded provider error", async () => {
    const rejected = await exchangeAuthorizationCode({
      clientId: "client",
      code: "code",
      fetch: (async () =>
        Response.json(
          { error: "invalid_code", ok: false },
          { headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
      redirectUrl: "https://app.example/callback",
      tokenResponseProfile: "slack-bot",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(rejected)).toEqual({
      failureCode: "provider-exchange-failed",
      providerError: "invalid_code",
    });
  });

  it("distinguishes Slack transport failures from malformed success responses", async () => {
    const attempt = async (response: Response) =>
      exchangeAuthorizationCode({
        clientId: "client",
        code: "code",
        fetch: (async () => response) as typeof fetch,
        redirectUrl: "https://app.example/callback",
        tokenResponseProfile: "slack-bot",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
      }).catch((error: unknown) => error);

    const outage = await attempt(new Response("upstream trace", { status: 503 }));
    expect(oauthAuthorizationFailure(outage)).toEqual({
      failureCode: "provider-exchange-failed",
      providerError: null,
    });
    expect((outage as Error).message).not.toContain("upstream trace");

    const malformed = await attempt(new Response("not json", { status: 200 }));
    expect(oauthAuthorizationFailure(malformed)).toEqual({
      failureCode: "invalid-provider-response",
      providerError: null,
    });
  });

  it.each(["bad_verification_code", "bad_refresh_token"])(
    "preserves GitHub's bounded HTTP-200 %s error",
    async (error) => {
      const rejected = await exchangeAuthorizationCode({
        clientId: "client",
        code: "code",
        fetch: (async () =>
          Response.json(
            { error, error_description: "raw provider detail" },
            { headers: { "cache-control": "no-store" } },
          )) as typeof fetch,
        redirectUrl: "https://app.example/callback",
        tokenUrl: "https://github.com/login/oauth/access_token",
      }).catch((cause: unknown) => cause);
      expect(oauthAuthorizationFailure(rejected)).toEqual({
        failureCode: "grant-rejected",
        providerError: error,
      });
      expect((rejected as Error).message).not.toContain("raw provider detail");
      expect("cause" in (rejected as object)).toBe(false);
    },
  );

  it("classifies one proper Basic invalid_client challenge without retaining it", async () => {
    const rejected = await exchangeAuthorizationCode({
      clientId: "client",
      clientSecret: "wrong",
      code: "code",
      fetch: (async () =>
        new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="oauth", error="invalid_client"' },
        })) as typeof fetch,
      redirectUrl: "https://app.example/callback",
      tokenUrl: "https://identity.example/token",
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(rejected)).toEqual({
      failureCode: "client-rejected",
      providerError: "invalid_client",
    });
    expect("cause" in (rejected as object)).toBe(false);
  });

  it.each([
    {
      name: "Google",
      profile: undefined,
      response: { access_token: "google-next", expires_in: 3_600, token_type: "Bearer" },
    },
    {
      name: "GitHub",
      profile: undefined,
      response: {
        access_token: "github-next",
        expires_in: 28_800,
        refresh_token: "github-refresh-next",
        token_type: "bearer",
      },
    },
    {
      name: "Discord",
      profile: undefined,
      response: {
        access_token: "discord-next",
        expires_in: 604_800,
        refresh_token: "discord-refresh-next",
        scope: "identify email guilds",
        token_type: "Bearer",
      },
    },
    {
      name: "Microsoft",
      profile: undefined,
      response: {
        access_token: "microsoft-next",
        expires_in: 3_599,
        refresh_token: "microsoft-refresh-next",
        scope: "openid profile email User.Read",
        token_type: "Bearer",
      },
    },
    {
      name: "Slack",
      profile: "slack-bot" as const,
      response: {
        access_token: "xoxe.xoxb-next",
        expires_in: 43_200,
        ok: true,
        refresh_token: "xoxe-refresh-next",
        scope: "chat:write",
        token_type: "bot",
      },
    },
  ])("accepts a representative $name refresh response", async ({ profile, response }) => {
    await expect(
      refreshAccessToken({
        clientId: "client",
        fetch: (async () =>
          Response.json(response, { headers: { "cache-control": "no-store" } })) as typeof fetch,
        refreshToken: "refresh",
        ...(profile ? { tokenResponseProfile: profile } : {}),
        tokenUrl: "https://identity.example/token",
      }),
    ).resolves.toMatchObject({ access_token: response.access_token, token_type: "bearer" });
  });

  it("validates an ID token against an explicit issuer when it differs from the token origin", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const idToken = `${encode({ alg: "RS256" })}.${encode({
      aud: "client",
      exp: now + 3_600,
      iat: now,
      iss: "https://accounts.google.com",
      sub: "google-user",
    })}.c2ln`;
    const fetch_ = vi.fn(async () =>
      Response.json(
        { access_token: "access", id_token: idToken, token_type: "Bearer" },
        { headers: { "cache-control": "no-store" } },
      ),
    );

    await expect(
      exchangeAuthorizationCode({
        clientId: "client",
        code: "code",
        fetch: fetch_ as typeof fetch,
        issuer: "https://accounts.google.com",
        redirectUrl: "https://app.example/callback",
        tokenUrl: "https://oauth2.googleapis.com/token",
      }),
    ).resolves.toMatchObject({ access_token: "access", id_token: idToken });
    const wrongIssuer = await exchangeAuthorizationCode({
      clientId: "client",
      code: "code",
      fetch: fetch_ as typeof fetch,
      redirectUrl: "https://app.example/callback",
      tokenUrl: "https://oauth2.googleapis.com/token",
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(wrongIssuer)).toEqual({
      failureCode: "invalid-provider-response",
      providerError: null,
    });
  });
});

describe("OAuth discovery", () => {
  it("discovers path-scoped RFC 9728 metadata", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.example/.well-known/oauth-protected-resource/mcp");
      return new Response(
        JSON.stringify({
          resource: "https://api.example/mcp",
          authorization_servers: ["https://identity.example"],
        }),
        { status: 200 },
      );
    });
    await expect(
      discoverProtectedResourceMetadata("https://api.example/mcp", {
        fetch: fetch_ as typeof fetch,
      }),
    ).resolves.toMatchObject({
      metadataUrl: "https://api.example/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("falls back from RFC 8414 to OIDC discovery", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("oauth-authorization-server")) return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({
          issuer: "https://identity.example",
          authorization_endpoint: "https://identity.example/authorize",
          token_endpoint: "https://identity.example/token",
          registration_endpoint: "https://identity.example/register",
        }),
        { status: 200 },
      );
    });
    await expect(
      discoverAuthorizationServerMetadata("https://identity.example", {
        fetch: fetch_ as typeof fetch,
      }),
    ).resolves.toMatchObject({
      metadataUrl: "https://identity.example/.well-known/openid-configuration",
      metadata: { token_endpoint: "https://identity.example/token" },
    });
  });

  it("registers a dynamic client and accepts HTTP 200", async () => {
    const fetch_ = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        redirect_uris: ["https://app.example/callback"],
        token_endpoint_auth_method: "none",
      });
      return new Response(JSON.stringify({ client_id: "dynamic-client" }), { status: 200 });
    });
    await expect(
      registerDynamicClient(
        {
          registrationEndpoint: "https://identity.example/register",
          metadata: {
            redirect_uris: ["https://app.example/callback"],
            token_endpoint_auth_method: "none",
          },
        },
        { fetch: fetch_ as typeof fetch },
      ),
    ).resolves.toMatchObject({ client_id: "dynamic-client" });
  });
});

describe("declarative OAuth flow", () => {
  it("uses the fixed scope set and builds PKCE authorization", async () => {
    const result = await buildDeclarativeAuthorizationUrl({
      config: oauthConfig,
      clientId: "client",
      redirectUrl: "https://app.example/callback",
      state: "state",
    });
    expect(result.codeVerifier).toBeTruthy();
    expect(new URL(result.authorizationUrl).searchParams.get("audience")).toBe("api");
  });

  it("extracts identity from a token response", async () => {
    const tokenIdentityConfig = OAuthMethodConfigSchema.parse({
      ...oauthConfig,
      identity: {
        accountIdentifierPath: "account.email",
        source: "token-response",
        identityPath: "account.id",
        tenantPath: "account.tenant",
        displayNamePath: "account.name",
      },
    });
    await expect(
      extractDeclarativeCredential({
        config: tokenIdentityConfig,
        now: 1_000,
        tokenResponse: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 60,
          scope: "openid profile",
          account: { email: "ada@example.com", id: 42, tenant: "tenant", name: "Ada" },
        },
      }),
    ).resolves.toEqual({
      accessToken: "access",
      accountIdentifier: "ada@example.com",
      refreshToken: "refresh",
      expiresAt: 61_000,
      externalIdentityId: "42",
      externalTenantId: "tenant",
      displayName: "Ada",
      grantedScopes: ["openid", "profile"],
    });
  });

  it("distinguishes an absent scope from an explicitly empty scope", async () => {
    const tokenIdentityConfig = OAuthMethodConfigSchema.parse({
      ...oauthConfig,
      identity: { source: "token-response", identityPath: "account.id" },
    });
    const absent = await extractDeclarativeCredential({
      config: tokenIdentityConfig,
      tokenResponse: { access_token: "access", account: { id: "account" } },
    });
    const empty = await extractDeclarativeCredential({
      config: tokenIdentityConfig,
      tokenResponse: { access_token: "access", account: { id: "account" }, scope: "" },
    });
    expect(absent.grantedScopes).toEqual(tokenIdentityConfig.scopes);
    expect(empty.grantedScopes).toEqual([]);
  });

  it("requires a declared token-response tenant instead of guessing one", async () => {
    const tokenIdentityConfig = OAuthMethodConfigSchema.parse({
      ...oauthConfig,
      identity: {
        source: "token-response",
        identityPath: "account.id",
        tenantPath: "account.tenant",
      },
    });
    const rejected = await extractDeclarativeCredential({
      config: tokenIdentityConfig,
      tokenResponse: { access_token: "access", account: { id: "account" } },
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(rejected)).toEqual({
      failureCode: "invalid-provider-response",
      providerError: null,
    });
  });

  it("fetches and extracts a userinfo identity", async () => {
    const fetch_ = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      return new Response(
        JSON.stringify({
          account: {
            email: "grace@example.com",
            id: "user",
            tenant: { id: "workspace" },
            name: "Grace",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      extractDeclarativeCredential({
        config: oauthConfig,
        tokenResponse: { access_token: "access" },
        fetch: fetch_ as typeof fetch,
      }),
    ).resolves.toMatchObject({
      accountIdentifier: "grace@example.com",
      externalIdentityId: "user",
      externalTenantId: "workspace",
      displayName: "Grace",
      grantedScopes: ["openid", "profile", "contacts.read"],
    });
  });

  it.each([
    {
      name: "malformed JSON",
      response: new Response("not json", { status: 200 }),
    },
    {
      name: "missing identity",
      response: Response.json({ account: { tenant: { id: "workspace" } } }),
    },
    {
      name: "missing tenant",
      response: Response.json({ account: { id: "user" } }),
    },
  ])("classifies userinfo $name without retaining provider data", async ({ response }) => {
    const rejected = await extractDeclarativeCredential({
      config: oauthConfig,
      tokenResponse: { access_token: "access" },
      fetch: (async () => response.clone()) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(oauthAuthorizationFailure(rejected)).toEqual({
      failureCode: "invalid-provider-response",
      providerError: null,
    });
    expect(rejected).toBeInstanceOf(OAuth2Error);
    expect("cause" in (rejected as object)).toBe(false);
  });

  it("classifies userinfo network and HTTP failures as transport failures", async () => {
    for (const fetch_ of [
      (async () => {
        throw new TypeError("socket included raw provider data");
      }) as typeof fetch,
      (async () => new Response("raw provider body", { status: 503 })) as typeof fetch,
    ]) {
      const rejected = await extractDeclarativeCredential({
        config: oauthConfig,
        tokenResponse: { access_token: "access" },
        fetch: fetch_,
      }).catch((error: unknown) => error);
      expect(oauthAuthorizationFailure(rejected)).toEqual({
        failureCode: "provider-exchange-failed",
        providerError: null,
      });
      expect((rejected as Error).message).not.toContain("raw provider");
      expect("cause" in (rejected as object)).toBe(false);
    }
  });
});

describe("OIDC access-token scope validation", () => {
  it("does not require offline_access to be echoed and still rejects missing data permissions", () => {
    const config = {
      ...oauthConfig,
      scopes: ["openid", "offline_access", "Mail.ReadWrite", "Mail.Send"],
      scopeAliases: { "Mail.ReadWrite": ["https://graph.microsoft.com/Mail.ReadWrite"] },
    };
    expect(
      missingRequiredScopes({
        config,
        requiredScopes: config.scopes,
        grantedScopes: ["openid", "https://graph.microsoft.com/Mail.ReadWrite", "Mail.Send"],
      }),
    ).toEqual([]);
    expect(
      missingRequiredScopes({
        config,
        requiredScopes: config.scopes,
        grantedScopes: ["openid", "https://graph.microsoft.com/Mail.ReadWrite"],
      }),
    ).toEqual(["Mail.Send"]);
  });
  it("does not exempt a same-named scope outside an OIDC method", () => {
    const config = { ...oauthConfig, scopes: ["offline_access", "data.read"] };
    expect(
      missingRequiredScopes({
        config,
        requiredScopes: config.scopes,
        grantedScopes: ["data.read"],
      }),
    ).toEqual(["offline_access"]);
  });
});
