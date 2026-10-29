import {
  AuthenticatedSessionSchema,
  OpensteerError,
  personalRemoteAuthorizationScheme,
  type AuthenticatedSession,
  type UserId,
} from "@opensteer/core";
import type { IntegrationAuthorizationSurface } from "@opensteer/integration-core";
import { IdentityService } from "@opensteer/identity";

export interface RequestHeaders {
  readonly [name: string]: string | readonly string[] | number | undefined;
  readonly authorization?: string | readonly string[] | undefined;
  readonly cookie?: string | readonly string[] | undefined;
  readonly host?: string | readonly string[] | undefined;
  readonly origin?: string | readonly string[] | undefined;
}

export type HostSessionSurface = IntegrationAuthorizationSurface;

/**
 * Which credential the Host actually authenticated, as opposed to who it
 * names. Two Host-rooted families reach the same session row from outside this
 * computer — a native OAuth bearer token and a Personal remote session — and
 * neither is evidence that the owner is at the keyboard, so every check that
 * means "at the keyboard" reads this rather than the surface or an Origin.
 */
export type HostCredentialKind =
  "browser-cookie" | "native-oauth" | "personal-remote-cookie" | "personal-remote-header";

export interface AuthenticatedHostSession {
  readonly credentialKind: HostCredentialKind;
  readonly session: AuthenticatedSession;
  readonly surface: HostSessionSurface;
}

export interface PersonalRemoteSessionAuthenticator {
  authenticateRemoteCredential(credential: string): Promise<AuthenticatedSession | null>;
  authenticateRemoteSession(
    headers: RequestHeaders,
    options?: { readonly mutation?: boolean },
  ): Promise<AuthenticatedSession | null>;
}

/**
 * The slice of Identity the authenticator itself calls. The whole service is
 * still what a Host hands it — `identity` re-exposes exactly what was passed,
 * which is why the routes reach the rest of it — but naming the authentication
 * surface lets a test stand one up against the real signatures.
 */
export type HostAuthenticatingIdentity = Pick<
  IdentityService,
  "authenticateNativeAccessToken" | "requireSession" | "userSessionProfile"
>;

export class HostAuthenticator<Identity extends HostAuthenticatingIdentity = IdentityService> {
  readonly #identity: Identity;
  readonly #personalRemote: PersonalRemoteSessionAuthenticator | undefined;
  readonly #publicOrigin: string;

  constructor(options: {
    readonly identity: Identity;
    readonly personalRemote?: PersonalRemoteSessionAuthenticator | undefined;
    readonly publicUrl: URL;
  }) {
    this.#identity = options.identity;
    this.#personalRemote = options.personalRemote;
    this.#publicOrigin = options.publicUrl.origin;
  }

  get identity(): Identity {
    return this.#identity;
  }

  get publicOrigin(): string {
    return this.#publicOrigin;
  }

  async authenticateUser(
    headers: RequestHeaders,
    options: { readonly mutation?: boolean } = {},
  ): Promise<UserId> {
    return (await this.authenticateSession(headers, options)).user.id;
  }

  async authenticateSession(
    headers: RequestHeaders,
    options: { readonly mutation?: boolean } = {},
  ): Promise<AuthenticatedSession> {
    return (await this.authenticateSessionContext(headers, options)).session;
  }

  async authenticateSessionContext(
    headers: RequestHeaders,
    options: { readonly mutation?: boolean } = {},
  ): Promise<AuthenticatedHostSession> {
    // One parse, one decision: a request that presents an Authorization header
    // is answered from that credential's own family or refused. Falling
    // through to cookies would let an unusable or unknown authorization be
    // answered by whatever the user agent attached to the request.
    const authorization = parseAuthorization(headers.authorization);
    if (authorization?.scheme === "Bearer") {
      const claims = await this.#identity.authenticateNativeAccessToken(authorization.credential);
      const user = await this.#identity.userSessionProfile(claims.subject);
      return {
        credentialKind: "native-oauth",
        session: AuthenticatedSessionSchema.parse({
          absoluteExpiresAt: claims.absoluteExpiresAt.toISOString(),
          createdAt: claims.createdAt.toISOString(),
          expiresAt: claims.expiresAt.toISOString(),
          id: claims.sessionId,
          user,
        }),
        surface: "canonical",
      };
    }
    if (authorization) {
      const presented = await this.#personalRemote?.authenticateRemoteCredential(
        authorization.credential,
      );
      if (!presented) {
        throw new OpensteerError({
          code: "unauthorized",
          message: "Personal remote session credential is invalid",
        });
      }
      return {
        credentialKind: "personal-remote-header",
        session: presented,
        surface: "personal-remote",
      };
    }
    const remote = await this.#personalRemote?.authenticateRemoteSession(headers, {
      mutation: options.mutation ?? false,
    });
    if (remote) {
      return {
        credentialKind: "personal-remote-cookie",
        session: remote,
        surface: "personal-remote",
      };
    }
    if (options.mutation && firstHeader(headers.origin) !== this.#publicOrigin) {
      throw new OpensteerError({ code: "forbidden", message: "Request origin is not allowed" });
    }
    return {
      credentialKind: "browser-cookie",
      session: await this.#identity.requireSession(toWebHeaders(headers)),
      surface: "canonical",
    };
  }

  requireExactOrigin(headers: RequestHeaders): void {
    if (firstHeader(headers.origin) !== this.#publicOrigin) {
      throw new OpensteerError({ code: "forbidden", message: "Request origin is not allowed" });
    }
  }

  requireCanonicalSurface(headers: RequestHeaders): void {
    if (
      firstHeader(headers.host)?.toLowerCase() !== new URL(this.#publicOrigin).host.toLowerCase()
    ) {
      throw canonicalAuthorizationRequired();
    }
  }
}

// Hosted OAuth launches from the canonical surface too, so there is no remote alternative to offer.
export const canonicalAuthorizationRepair = "Authorize from the owner computer.";

export function canonicalAuthorizationRequired(): OpensteerError {
  return new OpensteerError({
    code: "canonical_surface_required",
    message: canonicalAuthorizationRepair,
  });
}

/**
 * The two authorization schemes this Host answers, parsed once. A repeated
 * header, an unknown scheme, a missing credential and an oversized one are all
 * failures rather than an absent authorization: an authorization the Host
 * cannot read is never the same thing as no authorization at all.
 */
function parseAuthorization(
  value: string | readonly string[] | undefined,
): { readonly credential: string; readonly scheme: "Bearer" | "PersonalRemote" } | undefined {
  if (value === undefined) return undefined;
  const header = typeof value === "string" ? value : value.length === 1 ? value[0] : undefined;
  if (header === undefined) throw invalidAuthorization();
  const separator = header.indexOf(" ");
  const scheme = separator < 0 ? header : header.slice(0, separator);
  if (scheme !== "Bearer" && scheme !== personalRemoteAuthorizationScheme) {
    throw invalidAuthorization();
  }
  const credential = separator < 0 ? "" : header.slice(separator + 1);
  if (!credential || credential.includes(" ") || credential.length > 16_384) {
    throw invalidAuthorization();
  }
  return { credential, scheme };
}

function invalidAuthorization(): OpensteerError {
  return new OpensteerError({ code: "unauthorized", message: "Authorization header is invalid" });
}

export function toWebHeaders(input: RequestHeaders): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else {
      headers.set(name, String(raw));
    }
  }
  return headers;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
