// Derived from github.com/UsefulSoftwareCo/executor packages/core/sdk/src/oauth-helpers.ts (MIT).
import { isLoopbackHostname } from "@opensteer/core";
import type {
  OAuthIdTokenValidation,
  OAuthTokenResponseProfile,
} from "@opensteer/integration-core";
import * as oauth from "oauth4webapi";

const OAUTH2_REFRESH_SKEW_MS = 60_000;
export const OAUTH2_DEFAULT_TIMEOUT_MS = 20_000;

export interface OAuthEndpointUrlPolicy {
  readonly allowHttp?: boolean;
}

export class OAuth2Error extends Error {
  readonly error: string | undefined;
  readonly failureKind: OAuthTokenEndpointFailureKind;

  constructor(
    message: string,
    options: {
      error?: string;
      failureKind?: OAuthTokenEndpointFailureKind;
    } = {},
  ) {
    super(message);
    this.name = "OAuth2Error";
    this.error = options.error;
    this.failureKind = options.failureKind ?? "invalid-response";
  }
}

export type OAuthFailureKind = "grant-rejected" | "client-rejected" | "unknown";
export type OAuthTokenEndpointFailureKind = "invalid-response" | "provider-error" | "transport";
export type OAuthAuthorizationFailureCode =
  "client-rejected" | "grant-rejected" | "invalid-provider-response" | "provider-exchange-failed";

/**
 * Separates the RFC 6749 section 5.2 token error codes by the recovery each one demands: the
 * user's grant is dead and only reauthorization revives it, the OAuth client itself is refused
 * and only the operator can fix it, or the refusal names neither and must not be acted on.
 */
export function oauthFailureKind(errorCode: string | undefined): OAuthFailureKind {
  if (
    errorCode === "invalid_grant" ||
    errorCode === "bad_refresh_token" ||
    errorCode === "bad_verification_code"
  )
    return "grant-rejected";
  if (
    errorCode === "invalid_client" ||
    errorCode === "unauthorized_client" ||
    errorCode === "incorrect_client_credentials"
  ) {
    return "client-rejected";
  }
  return "unknown";
}

export function oauthAuthorizationFailure(error: unknown): {
  readonly failureCode: OAuthAuthorizationFailureCode;
  readonly providerError: string | null;
} {
  if (!(error instanceof OAuth2Error)) {
    return { failureCode: "provider-exchange-failed", providerError: null };
  }
  const providerError = safeProviderError(error.error);
  const recovery = oauthFailureKind(providerError);
  if (recovery !== "unknown") {
    return { failureCode: recovery, providerError: providerError ?? null };
  }
  return {
    failureCode:
      error.failureKind === "invalid-response"
        ? "invalid-provider-response"
        : "provider-exchange-failed",
    providerError: providerError ?? null,
  };
}

export interface OAuth2TokenResponse {
  readonly [key: string]: unknown;
  readonly access_token: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly token_type?: string;
}

export const isLoopbackHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:") return false;
  // A client that connects to the wildcard address reaches this same computer,
  // so an MCP server advertised on 0.0.0.0 is still same-computer traffic even
  // though 0.0.0.0 is not a loopback address to bind to.
  return url.hostname === "0.0.0.0" || isLoopbackHostname(url.hostname);
};

const isSupportedOAuthEndpointUrl = (
  value: string,
  policy: OAuthEndpointUrlPolicy = {},
): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    isLoopbackHttpUrl(value) ||
    (url.protocol === "http:" && policy.allowHttp === true)
  );
};

export const assertSupportedOAuthEndpointUrl = (
  value: string,
  label = "OAuth endpoint URL",
  policy: OAuthEndpointUrlPolicy = {},
): string => {
  if (isSupportedOAuthEndpointUrl(value, policy)) return value;
  throw new TypeError(`${label} must use https: or loopback http:`);
};

export const createPkceCodeVerifier = (): string => oauth.generateRandomCodeVerifier();
export const createPkceCodeChallenge = (verifier: string): Promise<string> =>
  oauth.calculatePKCECodeChallenge(verifier);
export const createOAuthState = (): string => oauth.generateRandomState();

const oauthStatePattern = /^[A-Za-z0-9_-]{43}$/u;

type OAuthAuthorizationResponse =
  | {
      readonly code: string;
      readonly kind: "success";
      readonly state: string;
    }
  | {
      readonly error: string;
      readonly errorDescription?: string;
      readonly kind: "error";
      readonly state: string;
    };

/**
 * Reads the one opaque state value needed to locate an authorization session.
 * Provider-owned extension parameters remain untouched for the later protocol validation step.
 */
export function oauthAuthorizationResponseState(parameters: URLSearchParams): string {
  const states = parameters.getAll("state");
  if (states.length !== 1 || !oauthStatePattern.test(states[0]!)) {
    throw new OAuth2Error("OAuth authorization response state is invalid");
  }
  return states[0]!;
}

/**
 * The error codes that mean the human declined. Every other RFC 6749 section 4.1.2.1 code is a
 * protocol or server failure and must not be reported to the user as a decision they made.
 */
const oauthDenialErrors = new Set(["access_denied", "consent_required"]);

export function oauthUserDeniedAuthorization(error: string): boolean {
  return oauthDenialErrors.has(error);
}

/**
 * Validates the security-bearing fields of an OAuth authorization response while deliberately
 * ignoring extensions owned by the authorization server, as required by RFC 6749 section 4.1.2.
 *
 * The `state` here is only the opaque locator carried by the response. Binding it to one session
 * and spending it exactly once is the caller's job, done by claiming the stored auth attempt.
 * `issuer` is enforced only when the catalog configures it explicitly; deriving an issuer from an
 * authorization endpoint origin is an OIDC coincidence, not a protocol guarantee.
 */
export function validateOAuthAuthorizationResponse(input: {
  readonly authorizationResponseIssuerParameterSupported?: boolean;
  readonly clientId: string;
  readonly issuer: string | null;
  readonly parameters: URLSearchParams;
}): OAuthAuthorizationResponse {
  const state = oauthAuthorizationResponseState(input.parameters);
  const codes = input.parameters.getAll("code");
  const errors = input.parameters.getAll("error");
  if (
    codes.length > 1 ||
    errors.length > 1 ||
    (codes.length === 0) === (errors.length === 0) ||
    (codes.length === 1 && codes[0]!.length === 0) ||
    (errors.length === 1 && errors[0]!.length === 0)
  ) {
    throw new OAuth2Error("OAuth authorization response must contain exactly one result");
  }
  if (input.parameters.getAll("iss").length > 1) {
    throw new OAuth2Error("OAuth authorization response issuer is invalid");
  }
  // Without a configured issuer there is nothing to compare `iss` against, so drop it rather than
  // letting the shared validator compare it to a guessed value. The placeholder is never read.
  const parameters =
    input.issuer === null ? withoutParameter(input.parameters, "iss") : input.parameters;
  const server: oauth.AuthorizationServer = {
    authorization_response_iss_parameter_supported:
      input.issuer !== null && (input.authorizationResponseIssuerParameterSupported ?? false),
    issuer: input.issuer ?? "urn:opensteer:unverified-issuer",
  };
  const client: oauth.Client = { client_id: input.clientId };
  try {
    const validated = oauth.validateAuthResponse(server, client, parameters, state);
    const code = validated.get("code");
    if (!code) throw new OAuth2Error("OAuth authorization response code is missing");
    return { code, kind: "success", state };
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError) {
      return {
        error: error.error,
        ...(error.error_description ? { errorDescription: error.error_description } : {}),
        kind: "error",
        state,
      };
    }
    if (error instanceof OAuth2Error) throw error;
    throw new OAuth2Error("OAuth authorization response is invalid");
  }
}

function withoutParameter(parameters: URLSearchParams, name: string): URLSearchParams {
  const copy = new URLSearchParams(parameters);
  copy.delete(name);
  return copy;
}

interface PkcePair {
  readonly codeChallenge: string;
  readonly codeVerifier: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = createPkceCodeVerifier();
  return { codeVerifier, codeChallenge: await createPkceCodeChallenge(codeVerifier) };
}

interface BuildAuthorizationUrlInput {
  readonly authorizationUrl: string;
  readonly clientId: string;
  readonly codeChallenge?: string;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly extraParams?: Readonly<Record<string, string>>;
  readonly redirectUrl: string;
  readonly resource?: string;
  readonly scopeSeparator?: string;
  readonly scopes: readonly string[];
  readonly state: string;
}

export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const url = new URL(
    assertSupportedOAuthEndpointUrl(
      input.authorizationUrl,
      "Authorization URL",
      input.endpointUrlPolicy,
    ),
  );
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
  }
  url.searchParams.set("state", input.state);
  if (input.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", input.codeChallenge);
  }
  if (input.resource !== undefined) url.searchParams.set("resource", input.resource);
  for (const [name, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export type ClientAuthMethod = "basic" | "body";

interface TokenRequestBase {
  readonly clientAuth?: ClientAuthMethod;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer?: string;
  readonly idTokenValidation?: OAuthIdTokenValidation;
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly tokenUrl: string;
  readonly tokenResponseProfile?: OAuthTokenResponseProfile;
}

interface ExchangeAuthorizationCodeInput extends TokenRequestBase {
  readonly code: string;
  readonly codeVerifier?: string;
  readonly redirectUrl: string;
}

interface ExchangeClientCredentialsInput extends TokenRequestBase {
  readonly clientSecret: string;
  readonly scopeSeparator?: string;
  readonly scopes?: readonly string[];
}

interface RefreshAccessTokenInput extends TokenRequestBase {
  readonly refreshToken: string;
  readonly scopeSeparator?: string;
  readonly scopes?: readonly string[];
}

const authorizationServer = (
  tokenUrl: string,
  issuer: string | undefined,
  policy: OAuthEndpointUrlPolicy = {},
): oauth.AuthorizationServer => {
  assertSupportedOAuthEndpointUrl(tokenUrl, "Token URL", policy);
  const url = new URL(tokenUrl);
  return {
    issuer: issuer ? assertSupportedOAuthEndpointUrl(issuer, "OAuth issuer", policy) : url.origin,
    token_endpoint: tokenUrl,
  };
};

const clientAuthentication = (
  secret: string | null | undefined,
  method: ClientAuthMethod = "body",
): oauth.ClientAuth => {
  if (!secret) return oauth.None();
  return method === "basic" ? oauth.ClientSecretBasic(secret) : oauth.ClientSecretPost(secret);
};

const requestOptions = (input: TokenRequestBase): Record<PropertyKey, unknown> => {
  const options: Record<PropertyKey, unknown> = {
    signal: AbortSignal.timeout(input.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
  };
  if (input.fetch !== undefined) options[oauth.customFetch] = input.fetch;
  if (
    isLoopbackHttpUrl(input.tokenUrl) ||
    (new URL(input.tokenUrl).protocol === "http:" && input.endpointUrlPolicy?.allowHttp === true)
  ) {
    options[oauth.allowInsecureRequests] = true;
  }
  return options;
};

const normalizeTokenResponse = (response: oauth.TokenEndpointResponse): OAuth2TokenResponse => ({
  ...response,
  access_token: response.access_token,
  ...(typeof response.expires_in === "number" ? { expires_in: response.expires_in } : {}),
  ...(response.refresh_token !== undefined ? { refresh_token: response.refresh_token } : {}),
  ...(response.scope !== undefined ? { scope: response.scope } : {}),
  ...(response.token_type !== undefined ? { token_type: response.token_type } : {}),
});

const safeProviderError = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value) ? value : undefined;

const oauthError = (cause: unknown): OAuth2Error => {
  if (cause instanceof OAuth2Error) return cause;
  const record =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;
  const challengeError =
    cause instanceof oauth.WWWAuthenticateChallengeError &&
    cause.cause.length === 1 &&
    cause.cause[0]?.scheme === "basic" &&
    cause.cause[0].parameters.error === "invalid_client"
      ? "invalid_client"
      : undefined;
  const code = safeProviderError(record?.error) ?? challengeError;
  const failureKind =
    cause instanceof oauth.ResponseBodyError || challengeError
      ? "provider-error"
      : cause instanceof oauth.UnsupportedOperationError ||
          cause instanceof oauth.OperationProcessingError
        ? "invalid-response"
        : "transport";
  const message =
    failureKind === "invalid-response"
      ? "OAuth token endpoint returned an invalid response"
      : failureKind === "transport"
        ? "OAuth token request failed"
        : `OAuth token exchange failed${code ? `: ${code}` : ""}`;
  return new OAuth2Error(message, {
    ...(code ? { error: code } : {}),
    failureKind,
  });
};

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function explicitOAuthError(record: Record<string, unknown> | undefined): OAuth2Error | undefined {
  if (!record || !Object.hasOwn(record, "error")) return undefined;
  const error = safeProviderError(record.error);
  return error
    ? new OAuth2Error(`OAuth token exchange failed: ${error}`, {
        error,
        failureKind: "provider-error",
      })
    : new OAuth2Error("OAuth token endpoint returned an invalid error response", {
        failureKind: "invalid-response",
      });
}

async function clonedJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

async function processTokenEndpointResponse(
  server: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
  profile: OAuthTokenResponseProfile | undefined,
  idTokenValidation: OAuthIdTokenValidation | undefined,
  process: (
    server: oauth.AuthorizationServer,
    client: oauth.Client,
    response: Response,
    options?: oauth.ProcessTokenResponseOptions,
  ) => Promise<oauth.TokenEndpointResponse>,
): Promise<OAuth2TokenResponse> {
  if (profile !== "slack-bot") {
    if (response.status >= 500) {
      throw new OAuth2Error("OAuth token request failed", { failureKind: "transport" });
    }
    const envelope = jsonObject(await clonedJson(response));
    const providerError = explicitOAuthError(envelope);
    if (providerError) throw providerError;
    let processedResponse = response;
    if (idTokenValidation === "ignore" && envelope && Object.hasOwn(envelope, "id_token")) {
      const { id_token: _idToken, ...withoutIdToken } = envelope;
      processedResponse = new Response(JSON.stringify(withoutIdToken), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
    const processed = await process(server, client, processedResponse);
    if (processed.token_type !== "bearer") {
      throw new OAuth2Error("OAuth token endpoint returned an unsupported bound token", {
        failureKind: "invalid-response",
      });
    }
    return normalizeTokenResponse(processed);
  }

  const payload = await clonedJson(response);
  const record = jsonObject(payload);
  if (response.status >= 500) {
    throw new OAuth2Error("OAuth token request failed", { failureKind: "transport" });
  }
  if (payload === undefined) {
    throw new OAuth2Error(
      response.ok
        ? "OAuth token endpoint returned an invalid response"
        : "OAuth token request failed",
      { failureKind: response.ok ? "invalid-response" : "transport" },
    );
  }
  if (record?.ok !== true) {
    const providerError = explicitOAuthError(record);
    if (providerError) throw providerError;
    throw new OAuth2Error("OAuth token endpoint returned an invalid response", {
      failureKind: "invalid-response",
    });
  }
  const processed = await process(server, client, response, {
    recognizedTokenTypes: { bot: () => undefined },
  });
  if (processed.token_type !== "bot") {
    throw new OAuth2Error("Slack did not return the requested bot grant", {
      failureKind: "invalid-response",
    });
  }
  return normalizeTokenResponse({ ...processed, token_type: "bearer" });
}

export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<OAuth2TokenResponse> {
  try {
    const server = authorizationServer(input.tokenUrl, input.issuer, input.endpointUrlPolicy);
    const client: oauth.Client = { client_id: input.clientId };
    const parameters = new URLSearchParams({
      code: input.code,
      redirect_uri: input.redirectUrl,
    });
    if (input.codeVerifier !== undefined) parameters.set("code_verifier", input.codeVerifier);
    if (input.resource !== undefined) parameters.set("resource", input.resource);
    const response = await oauth.genericTokenEndpointRequest(
      server,
      client,
      clientAuthentication(input.clientSecret, input.clientAuth),
      "authorization_code",
      parameters,
      requestOptions(input),
    );
    return await processTokenEndpointResponse(
      server,
      client,
      response,
      input.tokenResponseProfile,
      input.idTokenValidation,
      oauth.processGenericTokenEndpointResponse,
    );
  } catch (cause) {
    throw oauthError(cause);
  }
}

export async function exchangeClientCredentials(
  input: ExchangeClientCredentialsInput,
): Promise<OAuth2TokenResponse> {
  try {
    const server = authorizationServer(input.tokenUrl, input.issuer, input.endpointUrlPolicy);
    const client: oauth.Client = { client_id: input.clientId };
    const parameters = new URLSearchParams();
    if (input.scopes && input.scopes.length > 0) {
      parameters.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
    }
    if (input.resource !== undefined) parameters.set("resource", input.resource);
    const response = await oauth.clientCredentialsGrantRequest(
      server,
      client,
      clientAuthentication(input.clientSecret, input.clientAuth),
      parameters,
      requestOptions(input),
    );
    return normalizeTokenResponse(
      await oauth.processClientCredentialsResponse(server, client, response),
    );
  } catch (cause) {
    throw oauthError(cause);
  }
}

export async function refreshAccessToken(
  input: RefreshAccessTokenInput,
): Promise<OAuth2TokenResponse> {
  try {
    const server = authorizationServer(input.tokenUrl, input.issuer, input.endpointUrlPolicy);
    const client: oauth.Client = { client_id: input.clientId };
    const additionalParameters = new URLSearchParams();
    if (input.scopes && input.scopes.length > 0) {
      additionalParameters.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
    }
    if (input.resource !== undefined) additionalParameters.set("resource", input.resource);
    const response = await oauth.refreshTokenGrantRequest(
      server,
      client,
      clientAuthentication(input.clientSecret, input.clientAuth),
      input.refreshToken,
      {
        ...requestOptions(input),
        ...(additionalParameters.size > 0 ? { additionalParameters } : {}),
      },
    );
    return await processTokenEndpointResponse(
      server,
      client,
      response,
      input.tokenResponseProfile,
      input.idTokenValidation,
      oauth.processRefreshTokenResponse,
    );
  } catch (cause) {
    throw oauthError(cause);
  }
}

export function shouldRefreshToken(input: {
  readonly expiresAt: number | null;
  readonly now?: number;
  readonly skewMs?: number;
}): boolean {
  if (input.expiresAt === null) return false;
  return input.expiresAt <= (input.now ?? Date.now()) + (input.skewMs ?? OAUTH2_REFRESH_SKEW_MS);
}
