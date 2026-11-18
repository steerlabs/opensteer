import { type OAuthMethodConfig } from "./provider-oauth-config.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./provider-oauth.js";

export function normalizeGrantedScopes(
  config: OAuthMethodConfig,
  scopes: readonly string[],
): readonly string[] {
  const aliases = new Map<string, string>();
  for (const [canonical, values] of Object.entries(config.scopeAliases ?? {})) {
    aliases.set(canonical, canonical);
    for (const alias of values) aliases.set(alias, canonical);
  }
  return [
    ...new Set(
      scopes
        .map((scope) => scope.trim())
        .filter(Boolean)
        .map((scope) => aliases.get(scope) ?? scope),
    ),
  ];
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
  readonly redirectUrl: string;
}

export async function exchangeDeclarativeAuthorizationToken(
  input: ExchangeDeclarativeAuthorizationInput,
): Promise<OAuth2TokenResponse> {
  const clientAuth = clientAuthFor(input.config);
  return exchangeAuthorizationCode({
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
  // An omitted scope matches the refresh request, or its prior grant when no scope was sent.
  const scopes =
    typeof response.scope === "string"
      ? response.scope
          .split(input.config.scopeSeparator)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : input.config.scopes.length > 0
        ? input.config.scopes
        : input.grantedScopes;
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
