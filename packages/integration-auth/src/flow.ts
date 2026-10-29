import {
  OAuthTokenResponseIdentitySchema,
  type OAuthMethodConfig,
  type OAuthTokenResponseIdentity,
} from "@opensteer/integration-core";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuth2Error,
  refreshAccessToken,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth.js";

export function normalizeGrantedScopes(
  config: OAuthMethodConfig,
  scopes: readonly string[],
): readonly string[] {
  const aliases = new Map<string, string>();
  for (const [canonical, values] of Object.entries(config.scopeAliases ?? {})) {
    aliases.set(canonical, canonical);
    for (const alias of values) aliases.set(alias, canonical);
  }
  return [...new Set(scopes.map((scope) => aliases.get(scope) ?? scope))];
}

export function missingRequiredScopes(input: {
  readonly config?: OAuthMethodConfig;
  readonly grantedScopes: readonly string[];
  readonly requiredScopes: readonly string[];
}): readonly string[] {
  const granted = new Set(
    input.config ? normalizeGrantedScopes(input.config, input.grantedScopes) : input.grantedScopes,
  );
  const required = input.config
    ? normalizeGrantedScopes(input.config, input.requiredScopes)
    : input.requiredScopes;
  // OIDC offline_access requests a refresh token; it is not access-token authority.
  // Providers may omit it from the returned scope list even after granting it.
  const oidc = input.config?.scopes.includes("openid") === true;
  return [
    ...new Set(
      required.filter((scope) => !(oidc && scope === "offline_access") && !granted.has(scope)),
    ),
  ];
}

interface BuildDeclarativeAuthorizationInput {
  readonly clientId: string;
  readonly config: OAuthMethodConfig;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly redirectUrl: string;
  readonly resource?: string;
  readonly state: string;
}

interface DeclarativeAuthorizationStart {
  readonly authorizationUrl: string;
  readonly codeVerifier?: string;
  readonly scopes: readonly string[];
}

export async function buildDeclarativeAuthorizationUrl(
  input: BuildDeclarativeAuthorizationInput,
): Promise<DeclarativeAuthorizationStart> {
  const scopes = input.config.scopes;
  const pkce = input.config.usesPkce ? await createPkcePair() : undefined;
  return {
    authorizationUrl: buildAuthorizationUrl({
      authorizationUrl: input.config.authorizationUrl,
      clientId: input.clientId,
      redirectUrl: input.redirectUrl,
      scopes,
      state: input.state,
      scopeSeparator: input.config.scopeSeparator,
      ...(input.config.extraAuthorizeParams
        ? { extraParams: input.config.extraAuthorizeParams }
        : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      ...(pkce ? { codeChallenge: pkce.codeChallenge } : {}),
      ...(input.endpointUrlPolicy ? { endpointUrlPolicy: input.endpointUrlPolicy } : {}),
    }),
    scopes,
    ...(pkce ? { codeVerifier: pkce.codeVerifier } : {}),
  };
}

function valueAtPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function optionalStringAt(value: unknown, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const found = valueAtPath(value, path);
  if (typeof found === "string" && found.trim().length > 0) return found;
  if (typeof found === "number" || typeof found === "bigint") return String(found);
  return undefined;
}

export interface DeclarativeCredential {
  readonly accountIdentifier?: string;
  readonly accessToken: string;
  readonly displayName?: string;
  readonly expiresAt?: number;
  readonly externalIdentityId: string;
  readonly externalTenantId?: string;
  readonly grantedScopes: readonly string[];
  readonly refreshToken?: string;
}

/**
 * Selects the catalog-declared identity fields from a token response. This is
 * the only provider response metadata that needs to cross the hosted broker
 * boundary; the full provider document remains ephemeral.
 */
export function extractOAuthTokenResponseIdentity(
  config: OAuthMethodConfig,
  tokenResponse: Readonly<Record<string, unknown>>,
): OAuthTokenResponseIdentity {
  if (config.identity.source !== "token-response") {
    throw new OAuth2Error("OAuth identity source is not the token response", {
      failureKind: "invalid-response",
    });
  }
  const externalIdentityId = optionalStringAt(tokenResponse, config.identity.identityPath);
  if (!externalIdentityId) {
    throw new OAuth2Error(`OAuth identity path "${config.identity.identityPath}" was missing`, {
      failureKind: "invalid-response",
    });
  }
  const externalTenantId = optionalStringAt(tokenResponse, config.identity.tenantPath);
  if (config.identity.tenantPath && !externalTenantId) {
    throw new OAuth2Error(`OAuth identity path "${config.identity.tenantPath}" was missing`, {
      failureKind: "invalid-response",
    });
  }
  return validateOAuthTokenResponseIdentity(config, {
    externalIdentityId,
    ...(externalTenantId ? { externalTenantId } : {}),
    ...optionalIdentityFields(config, tokenResponse),
  });
}

function optionalIdentityFields(
  config: OAuthMethodConfig,
  document: Readonly<Record<string, unknown>>,
): Pick<OAuthTokenResponseIdentity, "accountIdentifier" | "displayName"> {
  const accountIdentifier = optionalStringAt(document, config.identity.accountIdentifierPath);
  const displayName = optionalStringAt(document, config.identity.displayNamePath);
  return {
    ...(accountIdentifier ? { accountIdentifier } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function validateOAuthTokenResponseIdentity(
  config: OAuthMethodConfig,
  identity: OAuthTokenResponseIdentity,
): OAuthTokenResponseIdentity {
  const result = OAuthTokenResponseIdentitySchema.safeParse(identity);
  if (!result.success) {
    throw new OAuth2Error("OAuth token-response identity was invalid", {
      failureKind: "invalid-response",
    });
  }
  const parsed = result.data;
  if (config.identity.source !== "token-response") {
    throw new OAuth2Error("OAuth token-response identity was provided for a userinfo provider", {
      failureKind: "invalid-response",
    });
  }
  if (config.identity.tenantPath && !parsed.externalTenantId) {
    throw new OAuth2Error(`OAuth identity path "${config.identity.tenantPath}" was missing`, {
      failureKind: "invalid-response",
    });
  }
  return parsed;
}

export interface ExtractDeclarativeCredentialInput {
  readonly config: OAuthMethodConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: number;
  readonly tokenResponse: OAuth2TokenResponse & Readonly<Record<string, unknown>>;
  readonly tokenResponseIdentity?: OAuthTokenResponseIdentity;
}

export async function extractDeclarativeCredential(
  input: ExtractDeclarativeCredentialInput,
): Promise<DeclarativeCredential> {
  if (input.tokenResponseIdentity && input.config.identity.source !== "token-response") {
    throw new OAuth2Error("OAuth token-response identity was provided for a userinfo provider", {
      failureKind: "invalid-response",
    });
  }
  const accessToken = input.tokenResponse.access_token;
  let identityDocument: unknown = input.tokenResponse;
  if (input.config.identity.source === "userinfo") {
    const userinfoUrl = input.config.identity.userinfoUrl;
    if (!userinfoUrl)
      throw new OAuth2Error("OAuth userinfo configuration is invalid", {
        failureKind: "invalid-response",
      });
    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(userinfoUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
    } catch {
      throw new OAuth2Error("OAuth userinfo request failed", { failureKind: "transport" });
    }
    if (!response.ok) {
      throw new OAuth2Error("OAuth userinfo request failed", { failureKind: "transport" });
    }
    try {
      identityDocument = (await response.json()) as unknown;
    } catch {
      throw new OAuth2Error("OAuth userinfo endpoint returned an invalid response", {
        failureKind: "invalid-response",
      });
    }
  }
  const tokenResponseIdentity =
    input.config.identity.source === "token-response"
      ? input.tokenResponseIdentity
        ? validateOAuthTokenResponseIdentity(input.config, input.tokenResponseIdentity)
        : extractOAuthTokenResponseIdentity(input.config, input.tokenResponse)
      : undefined;
  const externalIdentityId =
    tokenResponseIdentity?.externalIdentityId ??
    optionalStringAt(identityDocument, input.config.identity.identityPath);
  if (!externalIdentityId)
    throw new OAuth2Error(
      `OAuth identity path "${input.config.identity.identityPath}" was missing`,
      {
        failureKind: "invalid-response",
      },
    );
  const separator = input.config.scopeSeparator;
  const grantedScopes =
    typeof input.tokenResponse.scope === "string"
      ? input.tokenResponse.scope
          .split(separator)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [...input.config.scopes];
  const normalizedScopes = normalizeGrantedScopes(input.config, grantedScopes);
  const expiresIn = input.tokenResponse.expires_in;
  const externalTenantId =
    tokenResponseIdentity?.externalTenantId ??
    optionalStringAt(identityDocument, input.config.identity.tenantPath);
  if (input.config.identity.tenantPath && !externalTenantId) {
    throw new OAuth2Error(`OAuth identity path "${input.config.identity.tenantPath}" was missing`, {
      failureKind: "invalid-response",
    });
  }
  const accountIdentifier =
    tokenResponseIdentity?.accountIdentifier ??
    optionalStringAt(identityDocument, input.config.identity.accountIdentifierPath);
  const displayName =
    tokenResponseIdentity?.displayName ??
    optionalStringAt(identityDocument, input.config.identity.displayNamePath);
  return {
    accessToken,
    externalIdentityId,
    grantedScopes: normalizedScopes,
    ...(input.tokenResponse.refresh_token
      ? { refreshToken: input.tokenResponse.refresh_token }
      : {}),
    ...(typeof expiresIn === "number"
      ? { expiresAt: (input.now ?? Date.now()) + Math.max(0, expiresIn) * 1_000 }
      : {}),
    ...(externalTenantId ? { externalTenantId } : {}),
    ...(accountIdentifier ? { accountIdentifier } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function clientSecretFor(
  config: OAuthMethodConfig,
  clientSecret: string | undefined,
): string | null {
  if (config.clientAuth === "none") return null;
  if (!clientSecret) throw new Error("OAuth client secret is required");
  return clientSecret;
}

function clientAuthFor(config: OAuthMethodConfig): "basic" | "body" | undefined {
  return config.clientAuth === "none" ? undefined : config.clientAuth;
}

export interface ExchangeDeclarativeAuthorizationInput {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly codeVerifier?: string;
  readonly config: OAuthMethodConfig;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: number;
  readonly redirectUrl: string;
}

export interface DeclarativeAuthorizationToken {
  readonly tokenResponse: OAuth2TokenResponse & Readonly<Record<string, unknown>>;
  readonly tokenResponseIdentity?: OAuthTokenResponseIdentity;
}

export async function exchangeDeclarativeAuthorizationToken(
  input: ExchangeDeclarativeAuthorizationInput,
): Promise<DeclarativeAuthorizationToken> {
  const clientAuth = clientAuthFor(input.config);
  const tokenResponse = await exchangeAuthorizationCode({
    ...(clientAuth ? { clientAuth } : {}),
    clientId: input.clientId,
    clientSecret: clientSecretFor(input.config, input.clientSecret),
    code: input.code,
    ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
    ...(input.endpointUrlPolicy ? { endpointUrlPolicy: input.endpointUrlPolicy } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.config.issuer ? { issuer: input.config.issuer } : {}),
    ...(input.config.idTokenValidation
      ? { idTokenValidation: input.config.idTokenValidation }
      : {}),
    ...(input.config.tokenResponseProfile
      ? { tokenResponseProfile: input.config.tokenResponseProfile }
      : {}),
    redirectUrl: input.redirectUrl,
    tokenUrl: input.config.tokenUrl,
  });
  return {
    tokenResponse,
    ...(input.config.identity.source === "token-response"
      ? { tokenResponseIdentity: extractOAuthTokenResponseIdentity(input.config, tokenResponse) }
      : {}),
  };
}

export async function exchangeDeclarativeAuthorization(
  input: ExchangeDeclarativeAuthorizationInput,
): Promise<DeclarativeCredential & { readonly tokenType: string }> {
  const { tokenResponse, tokenResponseIdentity } =
    await exchangeDeclarativeAuthorizationToken(input);
  const credential = await extractDeclarativeCredential({
    config: input.config,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
    tokenResponse,
    ...(tokenResponseIdentity ? { tokenResponseIdentity } : {}),
  });
  return { ...credential, tokenType: tokenResponse.token_type ?? "Bearer" };
}

interface RefreshDeclarativeCredentialInput {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly config: OAuthMethodConfig;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly grantedScopes: readonly string[];
  readonly now?: number;
  readonly refreshToken: string;
}

export async function refreshDeclarativeCredential(
  input: RefreshDeclarativeCredentialInput,
): Promise<{
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly grantedScopes: readonly string[];
  readonly refreshToken: string;
  readonly tokenType: string;
}> {
  const clientAuth = clientAuthFor(input.config);
  const response = await refreshAccessToken({
    ...(clientAuth ? { clientAuth } : {}),
    clientId: input.clientId,
    clientSecret: clientSecretFor(input.config, input.clientSecret),
    ...(input.endpointUrlPolicy ? { endpointUrlPolicy: input.endpointUrlPolicy } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.config.issuer ? { issuer: input.config.issuer } : {}),
    ...(input.config.idTokenValidation
      ? { idTokenValidation: input.config.idTokenValidation }
      : {}),
    ...(input.config.tokenResponseProfile
      ? { tokenResponseProfile: input.config.tokenResponseProfile }
      : {}),
    refreshToken: input.refreshToken,
    scopeSeparator: input.config.scopeSeparator,
    scopes: input.config.scopes,
    tokenUrl: input.config.tokenUrl,
  });
  const scopes =
    typeof response.scope === "string"
      ? response.scope
          .split(input.config.scopeSeparator)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [...input.grantedScopes];
  return {
    accessToken: response.access_token,
    grantedScopes: [...new Set(scopes)],
    refreshToken: response.refresh_token ?? input.refreshToken,
    tokenType: response.token_type ?? "Bearer",
    ...(typeof response.expires_in === "number"
      ? { expiresAt: (input.now ?? Date.now()) + Math.max(0, response.expires_in) * 1_000 }
      : {}),
  };
}

function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cursor = value;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export async function revokeDeclarativeCredential(input: {
  readonly accessToken: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly config: OAuthMethodConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly refreshToken?: string;
}): Promise<void> {
  const revocation = input.config.revocation;
  if (!revocation) return;
  const token =
    revocation.tokenSource === "refresh-token-preferred"
      ? (input.refreshToken ?? input.accessToken)
      : input.accessToken;
  const url = revocation.url.replaceAll("{clientId}", encodeURIComponent(input.clientId));
  const headers = new Headers({ accept: "application/json" });
  if (revocation.clientAuth === "basic") {
    if (!input.clientSecret) throw new Error("OAuth client secret is required for revocation");
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64")}`,
    );
  }
  let body: string;
  if (revocation.method === "delete-json") {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ [revocation.tokenField]: token });
  } else {
    headers.set("content-type", "application/x-www-form-urlencoded");
    const params = new URLSearchParams({ [revocation.tokenField]: token });
    if (revocation.clientAuth === "body") {
      if (!input.clientSecret) throw new Error("OAuth client secret is required for revocation");
      params.set("client_id", input.clientId);
      params.set("client_secret", input.clientSecret);
    }
    body = params.toString();
  }
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    body,
    headers,
    method: revocation.method === "delete-json" ? "DELETE" : "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    payload = undefined;
  }
  const error = pathValue(payload, revocation.errorPath);
  if (typeof error === "string" && revocation.ignoredErrors?.includes(error)) return;
  const success = pathValue(payload, revocation.successPath);
  if (!response.ok || (revocation.successPath && success !== true)) {
    throw new Error(
      typeof error === "string"
        ? `OAuth revocation failed: ${error}`
        : `OAuth revocation returned HTTP ${response.status}`,
    );
  }
}
