import { createHash, createHmac, randomBytes } from "node:crypto";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import {
  AuthSessionIdSchema,
  AuthAdmissionIdSchema,
  AuthenticatedSessionSchema,
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  IdentityPasswordSchema,
  IdentityConfigSchema,
  InvitationPreviewSchema,
  NativeOAuthClientSetSchema,
  NativeOAuthRegistrationMetadataSchema,
  OpensteerError,
  PendingNativeAuthorizationSchema,
  pendingNativeAuthorizationMarker,
  PersonalRemoteSessionCredentialSchema,
  UserIdSchema,
  createId,
  normalizeIdentityEmail,
  sameStringSet,
  type AuthSessionSummary,
  type AuthSessionId,
  type AuthAdmissionId,
  type AuthenticatedSession,
  type IdentityConfig,
  type InvitationPreview,
  type NativeOAuthApplication,
  type NativeOAuthRegistrationMetadata,
  type PersonalRemoteSessionCredential,
  type PersonalRemoteSessionDelivery,
  type UserId,
  LocalPasswordRecoveryTokenSchema,
  identityPasswordMaxLength,
  identityPasswordMinLength,
} from "@opensteer/core";
import { OpensteerStore, type DatabaseSchema } from "@opensteer/database";
import { describeSessionDevice } from "./session-device.js";
import { sso } from "@better-auth/sso";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { APIError, betterAuth, type BetterAuthOptions } from "better-auth";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import { compactVerify, createLocalJWKSet, decodeJwt, type JWTPayload } from "jose";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  AccountAdoptionAccount,
  AccountAdoptionAuthority,
  ConsumedAccountAdoptionProof,
  IdentityServiceOptions,
  IssuedAccountAdoptionProof,
  VerifiedAccountAdoptionGrant,
} from "./types.js";

const internalAuthPath = "/internal/better-auth";
const publicNativeAuthPath = "/v1/auth/native";
const idleSessionSeconds = 7 * 24 * 60 * 60;
const absoluteSessionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const hostedAdmissionLifetimeMilliseconds = 10 * 60 * 1_000;
// A local Host's setup admission only unlocks a loopback listener, and whoever
// holds it could read the Host's own configuration anyway. Expiring it in
// minutes protects nothing and turns any mistake mid-setup into a restart loop,
// so a local admission lives as long as a working day.
const localAdmissionLifetimeMilliseconds = 24 * 60 * 60 * 1_000;
const admissionCookieName = "opensteer.admission";
const personalRemoteCookieName = "__Host-opensteer.session";
const localSessionCookieName = "opensteer.session";
/**
 * The reference every managed native registration carries. Rows written before
 * the Host registered more than one application still carry the bare prefix,
 * so both spellings are read and only the qualified one is written.
 */
const legacyNativeOAuthReference = "opensteer-native-client";
const nativeOAuthReference = (clientId: string) => `${legacyNativeOAuthReference}:${clientId}`;
const nativeOAuthScopes = ["openid", "profile", "email", "offline_access", "host:access"] as const;
const maxPendingAdmissions = 1_024;
const maxPendingAdmissionsPerSubject = 1;
const accountAdoptionProofLifetimeMilliseconds = 5 * 60 * 1_000;
const maxPendingAccountAdoptionProofs = 64;
const accountAdoptionProofIdPattern =
  /^hap_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const accountAdoptionCredentialPattern = /^oap_[A-Za-z0-9_-]{43}$/u;
const controlPlaneAccountSubjectPattern =
  /^acct_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type OpensteerAuth = ReturnType<typeof createOpensteerAuth>;

export interface TokenFreeAuthResponse<T> {
  readonly data: T;
  readonly headers: Headers;
  readonly status: number;
}

export type IssuedPersonalRemoteSession =
  | { readonly delivery: "cookie"; readonly session: AuthenticatedSession }
  | {
      readonly credential: {
        readonly absoluteExpiresAt: string;
        readonly expiresAt: string;
        readonly token: PersonalRemoteSessionCredential;
      };
      readonly delivery: "header";
      readonly session: AuthenticatedSession;
    };

export interface PasswordCredentials {
  readonly email: string;
  readonly password: string;
}

export interface PasswordSignup extends PasswordCredentials {
  /** Optional. Defaults to the email local part, editable later in account settings. */
  readonly displayName?: string;
}

interface NativeOAuthAccessTokenClaims {
  readonly absoluteExpiresAt: Date;
  /** The Opensteer application the trusted registration names, never a token claim. */
  readonly application: NativeOAuthApplication;
  readonly clientId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly sessionId: AuthSessionId;
  readonly subject: UserId;
}

/**
 * The first-owner code for a Host reachable only from its own machine.
 *
 * Deriving it from the Host's own signing secret means there is nothing extra to
 * generate, persist, rotate, or hand to an operator: the Host can hand the code
 * to itself on every start and the value stays stable across restarts. It is
 * only ever exchanged over loopback, and it stops working the moment an
 * administrator exists.
 */
export function deriveLocalSetupToken(secret: string): string {
  return createHmac("sha256", secret).update("opensteer-local-setup-token-v1").digest("base64url");
}

/**
 * Asking a new account to invent a display name adds a required field that
 * carries no information the email address does not already carry. Derive one
 * and let the person change it if they care.
 */
function displayNameFromEmail(email: string): string {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  const cleaned = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\d+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return email.slice(0, 120);
  return cleaned
    .split(" ")
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 120);
}

export class IdentityService {
  readonly #admissionLifetimeMilliseconds: number;
  readonly #auth: OpensteerAuth;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #options: IdentityServiceOptions;
  readonly #store: OpensteerStore;

  constructor(database: Kysely<DatabaseSchema>, options: IdentityServiceOptions) {
    if (options.secret.length < 32) {
      throw new Error("Opensteer identity secret must contain at least 32 characters");
    }
    if (
      options.localMachineOwner &&
      (options.exposure !== "loopback" || options.managedOwner !== undefined)
    ) {
      throw new Error("A local machine owner is allowed only on an unmanaged loopback Host");
    }
    this.#admissionLifetimeMilliseconds =
      options.exposure === "loopback"
        ? localAdmissionLifetimeMilliseconds
        : hostedAdmissionLifetimeMilliseconds;
    this.#database = database;
    this.#options = options;
    this.#store = new OpensteerStore(database);
    this.#auth = createOpensteerAuth(database, options, async (request, email) => {
      await this.#requireSignupAdmission(request, email);
    });
  }

  async initialize(): Promise<void> {
    await this.#ensureManagedOwner();
    await this.#ensureInitialOwnerEnrollment();
    await this.#ensureNativeOAuthClients();
  }

  async #ensureManagedOwner(): Promise<void> {
    const owner = this.#options.managedOwner;
    if (!owner) return;
    if (this.#options.initialOwnerEnrollment) {
      throw new Error("Managed owner bootstrap cannot be combined with an owner enrollment code");
    }
    const email = normalizeIdentityEmail(owner.email);
    const displayName = owner.displayName.trim();
    const providerId = owner.providerId.trim();
    const accountId = owner.accountId.trim();
    if (displayName.length < 1 || displayName.length > 120) {
      throw new Error("Managed owner display name is invalid");
    }
    if (!providerId || providerId.length > 512 || !accountId || accountId.length > 512) {
      throw new Error("Managed owner account identity is invalid");
    }

    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "managed-owner-bootstrap");
      await transaction
        .selectFrom("users")
        .select("id")
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      const existingAccount = await transaction
        .selectFrom("authAccounts")
        .innerJoin("users", "users.id", "authAccounts.userId")
        .select([
          "authAccounts.accountId",
          "authAccounts.providerId",
          "users.disabledAt",
          "users.id",
          "users.instanceRole",
        ])
        .where("authAccounts.providerId", "=", providerId)
        .where("authAccounts.accountId", "=", accountId)
        .forNoKeyUpdate("authAccounts")
        .executeTakeFirst();
      if (existingAccount) {
        if (existingAccount.instanceRole !== "administrator" || existingAccount.disabledAt) {
          throw new Error("Managed owner account does not match durable Host authority");
        }
        return;
      }

      const existingUser = await transaction
        .selectFrom("users")
        .select("id")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (existingUser) {
        throw new Error("Managed owner account does not match durable Host authority");
      }

      const userId = createId("user");
      const now = new Date();
      await transaction
        .insertInto("users")
        .values({
          createdAt: now,
          disabledAt: null,
          displayName,
          email,
          emailVerified: true,
          id: userId,
          image: null,
          instanceRole: "administrator",
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("authAccounts")
        .values({
          accessToken: null,
          accessTokenExpiresAt: null,
          accountId,
          createdAt: now,
          id: createId("authAccount"),
          idToken: null,
          password: null,
          providerId,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scope: null,
          updatedAt: now,
          userId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.managed-owner-provisioned",
          actorSessionId: null,
          actorUserId: null,
          id: createId("securityAudit"),
          metadata: sqlJson({ providerId }),
          requestId: null,
          targetId: userId,
          targetType: "user",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * Reconciles the configured native client allowlist against the managed rows
   * this Host already owns.
   *
   * Configuration is the authority over the applications and their callbacks,
   * so growing the set — adding the phone next to the desktop — adds a row and
   * leaves every other registration, its grants, and its sessions alone. A
   * changed callback set is an administrative update, not evidence of a
   * corrupted Host: the rows are derived configuration, not user data.
   */
  async #ensureNativeOAuthClients(): Promise<void> {
    const native = this.#options.nativeOAuth;
    if (!native) return;
    const configured = NativeOAuthClientSetSchema.parse(native.clients);
    const configuredIds = configured.map((client) => client.clientId);
    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "native-oauth-client");
      const managedClients = await transaction
        .selectFrom("hostOAuthClients")
        .select(["clientId", "id", "metadata", "redirectUris", "referenceId"])
        .where((expression) =>
          expression.or([
            expression("referenceId", "=", legacyNativeOAuthReference),
            expression("referenceId", "like", `${legacyNativeOAuthReference}:%`),
          ]),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      const managedRowIds = new Set(managedClients.map((candidate) => candidate.id));
      // A client ID an operator registered by hand is somebody else's
      // credential. Reconciliation rewrites whatever it touches, so it must
      // refuse to touch a registration it does not manage.
      const occupied = await transaction
        .selectFrom("hostOAuthClients")
        .select(["clientId", "id"])
        .where("clientId", "in", configuredIds)
        .execute();
      for (const candidate of occupied) {
        if (!managedRowIds.has(candidate.id)) {
          throw new Error(
            `Native OAuth client ID ${candidate.clientId} is already owned by another registration`,
          );
        }
      }
      const now = new Date();
      for (const client of configured) {
        const existing = managedClients.find((candidate) => candidate.clientId === client.clientId);
        if (existing) {
          const durable = nativeOAuthRegistration(existing.metadata);
          // The application a client ID was registered as is a binding, not a
          // label. Letting configuration move it would relabel every token the
          // old application is still holding.
          if (durable.application !== client.application) {
            throw new Error(
              `Native OAuth client ID ${client.clientId} is registered to the ${durable.application} application`,
            );
          }
          await transaction
            .updateTable("hostOAuthClients")
            .set({
              disabled: false,
              metadata: sqlJson(durable),
              name: client.displayName,
              redirectUris: sqlJson(client.redirectUris),
              referenceId: nativeOAuthReference(client.clientId),
              scopes: sqlJson([...nativeOAuthScopes]),
              skipConsent: false,
              softwareId: client.softwareId,
              updatedAt: now,
            })
            .where("id", "=", existing.id)
            .executeTakeFirstOrThrow();
          // A code was issued against the callbacks the client had when it was
          // minted, so a changed set must not leave one redeemable. Reordering
          // the same set changes nothing a code could be delivered to.
          if (!sameStringSet(existing.redirectUris, client.redirectUris)) {
            await invalidateNativeAuthorizations(transaction, client.clientId, now);
          }
        } else {
          await transaction
            .insertInto("hostOAuthClients")
            .values({
              clientId: client.clientId,
              clientSecret: null,
              contacts: null,
              createdAt: now,
              disabled: false,
              enableEndSession: true,
              grantTypes: sqlJson(["authorization_code", "refresh_token"]),
              icon: null,
              id: `hoc_${crypto.randomUUID()}`,
              metadata: sqlJson({ application: client.application }),
              name: client.displayName,
              policy: null,
              postLogoutRedirectUris: null,
              applicationType: "native",
              redirectUris: sqlJson(client.redirectUris),
              referenceId: nativeOAuthReference(client.clientId),
              requirePkce: true,
              responseTypes: sqlJson(["code"]),
              scopes: sqlJson([...nativeOAuthScopes]),
              skipConsent: false,
              softwareId: client.softwareId,
              softwareStatement: null,
              softwareVersion: null,
              subjectType: "public",
              tokenEndpointAuthMethod: "none",
              tos: null,
              updatedAt: now,
              uri: null,
              userId: null,
            })
            .executeTakeFirstOrThrow();
        }
      }
      const stale = managedClients.filter(
        (candidate) => !configuredIds.includes(candidate.clientId),
      );
      if (stale.length === 0) return;
      // Disabling the registration stops new authorizations; the credentials
      // it already issued outlive it unless they are revoked here. A JWT access
      // token has no row to delete, so the revocation line on the registration
      // is what retires it — and it survives re-registering the same client ID,
      // which would otherwise resurrect every token inside the JWT lifetime.
      // The browser sessions those tokens reference are deliberately untouched:
      // the person is still signed in, the retired application is not.
      for (const candidate of stale) {
        await transaction
          .updateTable("hostOAuthClients")
          .set({
            disabled: true,
            metadata: sqlJson({
              ...nativeOAuthRegistration(candidate.metadata),
              credentialsNotBefore: now.toISOString(),
            }),
            updatedAt: now,
          })
          .where("id", "=", candidate.id)
          .executeTakeFirstOrThrow();
        await invalidateNativeAuthorizations(transaction, candidate.clientId, now);
      }
      const staleClientIds = stale.map((candidate) => candidate.clientId);
      await transaction
        .deleteFrom("hostOAuthAccessTokens")
        .where("clientId", "in", staleClientIds)
        .execute();
      await transaction
        .updateTable("hostOAuthRefreshTokens")
        .set({ revoked: now })
        .where("clientId", "in", staleClientIds)
        .where("revoked", "is", null)
        .execute();
      await transaction
        .deleteFrom("hostOAuthConsents")
        .where("clientId", "in", staleClientIds)
        .execute();
    });
  }

  async authenticateNativeAccessToken(token: string): Promise<NativeOAuthAccessTokenClaims> {
    if (!this.#options.nativeOAuth) {
      throw new OpensteerError({
        code: "unauthorized",
        message: "Native authentication is disabled",
      });
    }
    let payload: JWTPayload;
    try {
      payload = await verifyJwsAccessToken(token, {
        jwksCacheKey: this,
        jwksFetch: () => this.#auth.api.getJwks(),
        verifyOptions: {
          algorithms: ["EdDSA"],
          audience: this.#options.publicOrigin.origin,
          issuer: this.#options.publicOrigin.origin,
        },
      });
    } catch (error) {
      throw new OpensteerError({
        cause: error,
        code: "unauthorized",
        message: "Native access token is invalid",
      });
    }
    if (
      !new Set(typeof payload.scope === "string" ? payload.scope.split(" ") : []).has("host:access")
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Native access token scope is invalid",
      });
    }
    const subject = UserIdSchema.safeParse(payload.sub);
    const sessionId = AuthSessionIdSchema.safeParse(payload.sid);
    // `azp` only selects which registration is claimed; configuration decides
    // whether that registration is one this Host still serves.
    const client =
      typeof payload.azp === "string"
        ? this.#options.nativeOAuth.clients.find((candidate) => candidate.clientId === payload.azp)
        : undefined;
    const expiresAt =
      typeof payload.exp === "number" && Number.isSafeInteger(payload.exp) && payload.exp > 0
        ? new Date(payload.exp * 1_000)
        : null;
    const issuedAt =
      typeof payload.iat === "number" && Number.isSafeInteger(payload.iat) && payload.iat > 0
        ? payload.iat
        : null;
    if (!subject.success || !sessionId.success || !client || !expiresAt || !issuedAt) {
      throw new OpensteerError({ code: "unauthorized", message: "Native access token is invalid" });
    }
    // The managed registration is joined in so a client an operator disabled
    // out from under the configuration stops authenticating immediately,
    // rather than at the next Host restart.
    const session = await this.#database
      .selectFrom("authSessions")
      .innerJoin("users", "users.id", "authSessions.userId")
      .innerJoin("hostOAuthClients", (join) =>
        join
          .on("hostOAuthClients.clientId", "=", client.clientId)
          .on("hostOAuthClients.referenceId", "=", nativeOAuthReference(client.clientId))
          .on("hostOAuthClients.disabled", "=", false),
      )
      .select([
        "authSessions.absoluteExpiresAt",
        "authSessions.createdAt",
        "authSessions.expiresAt",
        "hostOAuthClients.metadata as registration",
        "users.disabledAt",
      ])
      .where("authSessions.id", "=", sessionId.data)
      .where("authSessions.userId", "=", subject.data)
      .executeTakeFirst();
    const now = new Date();
    if (
      !session ||
      session.disabledAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      throw new OpensteerError({ code: "unauthorized", message: "Native access token is invalid" });
    }
    // The registration row, not the configuration, is the trusted statement of
    // which application holds this credential and of when the credentials it
    // issued stopped counting. A JWT access token has no row to delete, so
    // retiring a client — even one later re-registered under the same ID —
    // shows up here as a token issued before the line.
    const registration = NativeOAuthRegistrationMetadataSchema.safeParse(session.registration);
    if (!registration.success) {
      throw new OpensteerError({ code: "unauthorized", message: "Native access token is invalid" });
    }
    // `iat` is second-granular, so a token minted in the same second as the
    // retirement cannot be placed on either side of the line. It is refused:
    // the only cost is that a re-registered client's first login waits for the
    // second to tick over, and the alternative is honouring a revoked token.
    const notBefore = registration.data.credentialsNotBefore;
    if (notBefore && issuedAt <= Math.floor(new Date(notBefore).getTime() / 1_000)) {
      throw new OpensteerError({ code: "unauthorized", message: "Native access token is revoked" });
    }
    return {
      absoluteExpiresAt: session.absoluteExpiresAt,
      application: registration.data.application,
      clientId: client.clientId,
      createdAt: session.createdAt,
      expiresAt: new Date(Math.min(expiresAt.getTime(), session.expiresAt.getTime())),
      sessionId: sessionId.data,
      subject: subject.data,
    };
  }

  nativeOpenIdConfiguration(): ((request: Request) => Promise<Response>) | null {
    return this.#options.nativeOAuth
      ? publicNativeOAuthMetadata(
          oauthProviderOpenIdConfigMetadata(this.#auth),
          this.#options.publicOrigin,
        )
      : null;
  }

  nativeOAuthAuthorizationServerMetadata(): ((request: Request) => Promise<Response>) | null {
    return this.#options.nativeOAuth
      ? publicNativeOAuthMetadata(
          oauthProviderAuthServerMetadata(this.#auth),
          this.#options.publicOrigin,
        )
      : null;
  }

  async handleNativeOAuthRequest(request: Request): Promise<Response> {
    if (!this.#options.nativeOAuth) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    }
    const url = new URL(request.url);
    const publicPath = url.pathname.slice(publicNativeAuthPath.length);
    if (request.method === "GET" && publicPath === "/oauth2/authorize") {
      forceInteractiveConsent(url);
    }
    if (publicPath === "/oauth2/end-session") {
      if (request.method === "GET") return this.#endNativeAuthorization(url.searchParams);
      if (request.method === "POST") {
        const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (mediaType !== "application/x-www-form-urlencoded") {
          return nativeOAuthError(415, "invalid_request", "end-session requires a form body");
        }
        return this.#endNativeAuthorization(new URLSearchParams(await request.text()));
      }
    }
    url.pathname = `${internalAuthPath}${publicPath}`;
    if (request.method === "POST" && publicPath === "/oauth2/revoke") {
      return this.#revokeNativeAuthorization(url, request);
    }
    return this.#auth.handler(new Request(url, request));
  }

  async #endNativeAuthorization(parameters: URLSearchParams): Promise<Response> {
    // Managed native registrations declare no post-logout callbacks. Refuse a
    // redirect before ending anything instead of accepting an unregistered URL.
    if (parameters.has("post_logout_redirect_uri")) {
      return nativeOAuthError(400, "invalid_request", "post_logout_redirect_uri is unsupported");
    }
    const token = parameters.get("id_token_hint");
    if (!token) return nativeOAuthError(400, "invalid_request", "id_token_hint is required");
    let unverified: JWTPayload;
    try {
      // This decode selects the audience needed for verification; no claim is
      // trusted until the signature, issuer, and selected audience pass below.
      unverified = decodeJwt(token);
    } catch {
      return nativeOAuthError(401, "invalid_token", "id token is invalid");
    }
    const audience = typeof unverified.aud === "string" ? unverified.aud : unverified.aud?.[0];
    const clientId = parameters.get("client_id") ?? audience;
    const client = this.#options.nativeOAuth?.clients.find(
      (candidate) => candidate.clientId === clientId,
    );
    if (!client) return nativeOAuthError(400, "invalid_client", "client is invalid");
    let payload: JWTPayload;
    try {
      // The internal JWKS route is intentionally not exposed by Host.
      // Verify against its in-process key set. Logout deliberately accepts an
      // expired ID token: its signed sid remains the session being ended after
      // the ten-minute ID-token lifetime, while refresh sessions last 30 days.
      await compactVerify(token, createLocalJWKSet(await this.#auth.api.getJwks()), {
        algorithms: ["EdDSA"],
      });
      payload = decodeJwt(token);
      const audiences = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
      if (
        payload.iss !== this.#options.publicOrigin.origin ||
        !audiences.includes(client.clientId)
      ) {
        throw new Error("ID token issuer or audience is invalid");
      }
    } catch {
      return nativeOAuthError(401, "invalid_token", "id token is invalid");
    }
    const sessionId = AuthSessionIdSchema.safeParse(payload.sid);
    const userId = UserIdSchema.safeParse(payload.sub);
    if (!sessionId.success || !userId.success) {
      return nativeOAuthError(400, "invalid_request", "id token is missing its session");
    }
    await this.#database
      .deleteFrom("authSessions")
      .where("id", "=", sessionId.data)
      .where("userId", "=", userId.data)
      .execute();
    this.#options.onSessionEnded?.(sessionId.data);
    return new Response(null, { status: 200 });
  }

  /**
   * Revocation ends the Host session the revoked token family is anchored to.
   *
   * The authorization server revokes the refresh token and deletes the access
   * tokens minted from it, but a JWT access token has no row to delete and
   * stays valid for its whole ten minutes — so a phone that signed out would
   * keep reading the Deployment until then. `authenticateNativeAccessToken`
   * requires the session row on every call, so ending that row is what stops
   * the token at once, and every access and refresh row cascades away with it.
   *
   * Only the session the presented token names is ended. A desktop and a phone
   * authorize from different browsers and therefore hold different sessions,
   * so one application signing out never signs the other out.
   */
  async #revokeNativeAuthorization(url: URL, request: Request): Promise<Response> {
    const body = await request.text();
    const anchor = await this.#nativeTokenAnchor(new URLSearchParams(body));
    const response = await this.#auth.handler(
      new Request(url, { body, headers: request.headers, method: "POST" }),
    );
    // A token the authorization server refused is evidence of nothing, and a
    // session is never ended on it.
    if (!response.ok || !anchor) return response;
    await this.#database
      .deleteFrom("authSessions")
      .where("id", "=", anchor.sessionId)
      .where("userId", "=", anchor.userId)
      .execute();
    this.#options.onSessionEnded?.(anchor.sessionId);
    return response;
  }

  /** Whose session the token in a revocation request belongs to, if any. */
  async #nativeTokenAnchor(form: URLSearchParams): Promise<NativeTokenAnchor | null> {
    const clientId = form.get("client_id");
    const presented = form.get("token");
    if (!clientId || !presented) return null;
    const token = presented.startsWith("Bearer ") ? presented.slice("Bearer ".length) : presented;
    const refresh = await this.#database
      .selectFrom("hostOAuthRefreshTokens")
      .select(["sessionId", "userId"])
      .where("token", "=", storedNativeTokenDigest(token))
      .where("clientId", "=", clientId)
      .executeTakeFirst();
    if (refresh) return { sessionId: refresh.sessionId, userId: refresh.userId };
    // RFC 7009 lets a client present either half of the pair, and a token this
    // Host cannot authenticate names no session to end.
    try {
      const claims = await this.authenticateNativeAccessToken(token);
      return claims.clientId === clientId
        ? { sessionId: claims.sessionId, userId: claims.subject }
        : null;
    } catch {
      return null;
    }
  }

  async #ensureInitialOwnerEnrollment(): Promise<void> {
    const enrollment = this.#options.initialOwnerEnrollment;
    if (!enrollment) return;
    const tokenHash = digestSecret(enrollment.token);
    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "initial-owner-enrollment");
      const existingAdministrator = await transaction
        .selectFrom("users")
        .select("id")
        .where("instanceRole", "=", "administrator")
        .executeTakeFirst();
      if (existingAdministrator) {
        // The durable administrator and consumed enrollment are authoritative. A stale deployment
        // secret must be removed by the operator, but it must never make an otherwise healthy Host
        // fail to restart. Exchange also checks both durable conditions before admitting signup.
        return;
      }
      const existingEnrollment = await transaction
        .selectFrom("ownerEnrollments")
        .selectAll()
        .where("kind", "=", "initial")
        .where("idempotencyKey", "=", "initial-owner-bootstrap")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!existingEnrollment) {
        await transaction
          .insertInto("ownerEnrollments")
          .values({
            consumedAt: null,
            consumedBy: null,
            expiresAt: enrollment.expiresAt,
            id: createId("ownerEnrollment"),
            idempotencyKey: "initial-owner-bootstrap",
            kind: "initial",
            requestFingerprint: tokenHash,
            tokenHash,
          })
          .executeTakeFirstOrThrow();
        return;
      }
      if (
        existingEnrollment.requestFingerprint === tokenHash &&
        existingEnrollment.tokenHash === tokenHash
      ) {
        // Same code, so this is a restart rather than a rotation. A renewable
        // code moves its deadline forward, because a local Host that sat idle
        // past the original window must not become permanently unclaimable. An
        // operator-configured code keeps its fixed deadline.
        if (enrollment.renewable && existingEnrollment.expiresAt < enrollment.expiresAt) {
          await transaction
            .updateTable("ownerEnrollments")
            .set({ expiresAt: enrollment.expiresAt })
            .where("id", "=", existingEnrollment.id)
            .where("consumedAt", "is", null)
            .execute();
        }
        return;
      }
      if (existingEnrollment.consumedAt || existingEnrollment.expiresAt > new Date()) {
        throw new Error("Initial owner enrollment secret does not match durable Host state");
      }
      await transaction
        .updateTable("ownerEnrollments")
        .set({
          consumedAt: null,
          consumedBy: null,
          expiresAt: enrollment.expiresAt,
          requestFingerprint: tokenHash,
          tokenHash,
        })
        .where("id", "=", existingEnrollment.id)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.initial-owner-enrollment-rotated",
          actorSessionId: null,
          actorUserId: null,
          id: createId("securityAudit"),
          metadata: sqlJson({}),
          requestId: null,
          targetId: existingEnrollment.id,
          targetType: "owner-enrollment",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async configuration(): Promise<IdentityConfig> {
    const administrator = await this.#database
      .selectFrom("users")
      .select("id")
      .where("instanceRole", "=", "administrator")
      .executeTakeFirst();
    return IdentityConfigSchema.parse({
      deployment: this.#options.deployment,
      emailDeliveryAvailable: this.#options.emailDeliveryAvailable ?? false,
      localPasswordEnabled: this.#options.localPasswordEnabled,
      // The seeded local owner is an identity only in the database. It becomes
      // a person's identity the moment password sign-in is on, because then
      // somebody can actually sign in as it.
      machineOwner:
        this.#options.localMachineOwner !== undefined && !this.#options.localPasswordEnabled,
      oidcProviders: this.#options.oidcProviders.map((provider) => ({
        id: provider.providerId,
        label: provider.label,
        type: "oidc",
      })),
      passkeysEnabled: false,
      exposure: this.#options.exposure,
      portalOrigin: this.#options.portalOrigin?.origin ?? null,
      publicOrigin: this.#options.publicOrigin.origin,
      setupState: administrator ? "complete" : "required",
      signupPolicy: this.#options.signupPolicy,
    });
  }

  /**
   * Canonical browser-cookie authentication: this Deployment's own session, at
   * its own origin.
   *
   * A Personal remote session is deliberately not one. Its credential is a
   * Better Auth session token like any other, so presenting it under the
   * canonical cookie name would otherwise authenticate it here — with
   * `surface: "canonical"`, past the mutation origin check, and past
   * `canonicalAuthorizationRequired`. Excluding every session that has a
   * `personalRemoteSessions` row is the positive fence, and it lives in the
   * one lookup every canonical caller goes through rather than in any single
   * route's chain.
   */
  async authenticate(headers: Headers): Promise<AuthenticatedSession | null> {
    const session = await this.#authenticateSessionCookie(headers);
    if (!session) return null;
    const remote = await this.#database
      .selectFrom("personalRemoteSessions")
      .select("authSessionId")
      .where("authSessionId", "=", session.id)
      .executeTakeFirst();
    // A refusal, not a fence violation: this is a live remote session offered
    // in the wrong presentation, and its own arm still has to honour it.
    return remote ? null : session;
  }

  async #authenticateSessionCookie(headers: Headers): Promise<AuthenticatedSession | null> {
    const raw = await this.#auth.api.getSession({ headers });
    if (!raw) return null;
    const sessionId = AuthSessionIdSchema.safeParse(raw.session.id);
    const userId = UserIdSchema.safeParse(raw.user.id);
    if (!sessionId.success || !userId.success) return null;
    const row = await this.#database
      .selectFrom("authSessions")
      .innerJoin("users", "users.id", "authSessions.userId")
      .select([
        "authSessions.absoluteExpiresAt",
        "authSessions.createdAt",
        "authSessions.expiresAt",
        "authSessions.id",
        "authSessions.lastSeenAt",
        "users.disabledAt",
        "users.displayName",
        "users.email",
        "users.emailVerified",
        "users.id as userId",
        "users.image",
        "users.instanceRole",
      ])
      .where("authSessions.id", "=", sessionId.data)
      .where("users.id", "=", userId.data)
      .executeTakeFirst();
    const now = new Date();
    if (!row || row.disabledAt || row.expiresAt <= now || row.absoluteExpiresAt <= now) {
      if (row) {
        await this.#database.deleteFrom("authSessions").where("id", "=", row.id).execute();
      }
      return null;
    }
    if (now.getTime() - row.lastSeenAt.getTime() >= 5 * 60 * 1_000) {
      await this.#database
        .updateTable("authSessions")
        .set({ lastSeenAt: now })
        .where("id", "=", row.id)
        .where("lastSeenAt", "=", row.lastSeenAt)
        .execute();
    }
    return AuthenticatedSessionSchema.parse({
      absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      id: row.id,
      user: {
        disabledAt: null,
        displayName: row.displayName,
        email: row.email,
        emailVerified: row.emailVerified,
        id: row.userId,
        image: row.image,
        instanceRole: row.instanceRole,
      },
    });
  }

  /**
   * Trusted-proof boundary used only after the Personal Host atomically
   * consumes a pairing code or Account session grant. Session lifetime,
   * cookie signing, owner lookup, and the route-generation fence remain owned
   * by Identity rather than being recreated by a Host route handler.
   */
  async issuePersonalRemoteSession(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly delivery: PersonalRemoteSessionDelivery;
      readonly now: Date;
      readonly routeGeneration: number | string;
      readonly routeKind: "connect" | "private";
      readonly routeOrigin: string;
      /** The exchanging client's own header, so the device list can name it. */
      readonly userAgent: string | null;
    },
  ): Promise<TokenFreeAuthResponse<IssuedPersonalRemoteSession>> {
    if (!this.#options.localMachineOwner || this.#options.exposure !== "loopback") {
      throw new OpensteerError({
        code: "not_found",
        message: "Personal remote access is unavailable",
      });
    }
    const owner = await transaction
      .selectFrom("users")
      .selectAll()
      .where("instanceRole", "=", "administrator")
      .where("disabledAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!owner) {
      throw new OpensteerError({ code: "conflict", message: "Personal owner is unavailable" });
    }
    const now = new Date(input.now);
    const id = createId("authSession");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + idleSessionSeconds * 1_000);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteSessionMilliseconds);
    await transaction
      .insertInto("authSessions")
      .values({
        absoluteExpiresAt,
        createdAt: now,
        deviceLabel: describeSessionDevice(input.userAgent).label,
        expiresAt,
        id,
        ipAddress: null,
        lastSeenAt: now,
        token,
        updatedAt: now,
        userAgent: input.userAgent,
        userId: owner.id,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("personalRemoteSessions")
      .values({
        authSessionId: id,
        createdAt: now,
        delivery: input.delivery,
        routeGeneration: input.routeGeneration,
        routeKind: input.routeKind,
        routeOrigin: input.routeOrigin,
      })
      .executeTakeFirstOrThrow();
    const session = AuthenticatedSessionSchema.parse({
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      id,
      user: {
        disabledAt: null,
        displayName: owner.displayName,
        email: owner.email,
        emailVerified: owner.emailVerified,
        id: owner.id,
        image: owner.image,
        instanceRole: owner.instanceRole,
      },
    });
    const credential = `${token}.${createHmac("sha256", this.#options.secret).update(token).digest("base64")}`;
    const responseHeaders = new Headers();
    responseHeaders.set("cache-control", "no-store");
    if (input.delivery === "cookie") {
      responseHeaders.append(
        "set-cookie",
        `${personalRemoteCookieName}=${encodeURIComponent(credential)}; Path=/; Max-Age=${idleSessionSeconds}; HttpOnly; Secure; SameSite=Lax`,
      );
      return { data: { delivery: "cookie", session }, headers: responseHeaders, status: 200 };
    }
    // A native client has no cookie jar the Host can write to, so the same
    // signed pair travels in the body and comes back in an Authorization
    // header. Nothing about the session's authority changes with it.
    return {
      data: {
        credential: {
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          token: credential,
        },
        delivery: "header",
        session,
      },
      headers: responseHeaders,
      status: 200,
    };
  }

  /** Authenticate only a current, generation-fenced Personal HTTPS cookie. */
  async authenticatePersonalRemoteSession(
    headers: Headers,
    options: { readonly mutation?: boolean } = {},
  ): Promise<AuthenticatedSession | null> {
    const remoteCookie = readCookie(headers.get("cookie"), personalRemoteCookieName);
    if (!remoteCookie) return null;
    const identityHeaders = new Headers(headers);
    identityHeaders.set("cookie", `${localSessionCookieName}=${remoteCookie}`);
    return this.#authenticatePersonalRemoteCredential(identityHeaders, {
      delivery: "cookie",
      // An ambient cookie is attached by the user agent whatever caused the
      // request, so a mutation still has to prove it came from the signed
      // route itself.
      ...(options.mutation ? { requiredOrigin: headers.get("origin") } : {}),
    });
  }

  /**
   * Authenticate a header-delivered Personal remote session. There is no
   * ambient credential to forge a request with, so — exactly as the `mutation`
   * scope already treats a Bearer caller — no Origin is demanded; every other
   * user, expiry, delivery and route fence is the cookie arm's.
   */
  async authenticatePersonalRemoteCredential(
    credential: string,
  ): Promise<AuthenticatedSession | null> {
    if (!PersonalRemoteSessionCredentialSchema.safeParse(credential).success) return null;
    // Only the credential: nothing else the request carried — another
    // Deployment's cookie above all — may reach the session lookup.
    const identityHeaders = new Headers({
      cookie: `${localSessionCookieName}=${encodeURIComponent(credential)}`,
    });
    return this.#authenticatePersonalRemoteCredential(identityHeaders, { delivery: "header" });
  }

  async #authenticatePersonalRemoteCredential(
    identityHeaders: Headers,
    fence: {
      readonly delivery: PersonalRemoteSessionDelivery;
      readonly requiredOrigin?: string | null;
    },
  ): Promise<AuthenticatedSession | null> {
    // The unfenced lookup on purpose: `authenticate` refuses exactly the
    // sessions this method exists to honour.
    const session = await this.#authenticateSessionCookie(identityHeaders);
    if (!session) return null;
    const [remote, state] = await Promise.all([
      this.#database
        .selectFrom("personalRemoteSessions")
        .selectAll()
        .where("authSessionId", "=", session.id)
        .executeTakeFirst(),
      this.#database
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .executeTakeFirst(),
    ]);
    // Route facts only. A session whose signed route is gone or has rotated is
    // dead for good, so it is deleted here rather than left to be retried.
    const routeIntact =
      remote !== undefined &&
      state !== undefined &&
      state.mode !== "off" &&
      remote.routeKind === state.mode &&
      Number(remote.routeGeneration) === Number(state.generation) &&
      remote.routeOrigin === state.routeOrigin;
    if (!routeIntact) {
      await this.#database.deleteFrom("authSessions").where("id", "=", session.id).execute();
      return null;
    }
    // Presentation, not the fence: a credential minted for one family says
    // nothing about the route when it turns up in the other, and an Origin a
    // request did not send is a refusal rather than a reason to end a session
    // the legitimate client still holds.
    if (remote.delivery !== fence.delivery) return null;
    if (fence.requiredOrigin !== undefined && fence.requiredOrigin !== state.routeOrigin) {
      return null;
    }
    return session;
  }

  async requireSession(headers: Headers) {
    const session = await this.authenticate(headers);
    if (!session) {
      throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
    }
    return session;
  }

  async userSessionProfile(userId: UserId): Promise<AuthenticatedSession["user"]> {
    const row = await this.#database
      .selectFrom("users")
      .selectAll()
      .where("id", "=", UserIdSchema.parse(userId))
      .executeTakeFirst();
    if (!row || row.disabledAt) {
      throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
    }
    return AuthenticatedSessionSchema.shape.user.parse({
      disabledAt: null,
      displayName: row.displayName,
      email: row.email,
      emailVerified: row.emailVerified,
      id: row.id,
      image: row.image,
      instanceRole: row.instanceRole,
    });
  }

  accountAdoptionCompletionEnabled(): boolean {
    return this.#options.accountAdoption !== undefined;
  }

  /**
   * Records an administrator's explicit approval and returns the raw
   * proof credential once, pinned to the Account identity the administrator
   * selected. The control plane will independently compare that identity with
   * its authenticated Account session.
   */
  async issueAccountAdoptionProof(
    session: AuthenticatedSession,
    requestedAccount: AccountAdoptionAccount,
  ): Promise<IssuedAccountAdoptionProof> {
    requireAdministrator(session);
    const account = parseAccountAdoptionAccount(requestedAccount);
    const proofId = `hap_${globalThis.crypto.randomUUID()}`;
    const proofCredential = `oap_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + accountAdoptionProofLifetimeMilliseconds);
    const deployment = await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "account-adoption-proof-issuance");
      const authority = await activeDeploymentAuthority(
        transaction,
        true,
        requiredHostKeyFingerprint(this.#options.hostKeyFingerprint),
      );
      await requireLiveAdministratorSession(transaction, session, now);

      const configuredAccount = await transaction
        .selectFrom("accountDirectoryProvider")
        .select("providerId")
        .executeTakeFirst();
      if (configuredAccount) {
        throw new OpensteerError({
          code: "conflict",
          message: "This Deployment is already attached to an Opensteer Account",
        });
      }

      await transaction
        .deleteFrom("hostAccountAdoptionProofs")
        .where("consumedAt", "is", null)
        .where((expression) =>
          expression.or([
            expression("expiresAt", "<=", now),
            expression("authorizedByUserId", "=", session.user.id),
          ]),
        )
        .execute();
      const pending = await transaction
        .selectFrom("hostAccountAdoptionProofs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .executeTakeFirstOrThrow();
      if (Number(pending.count) >= maxPendingAccountAdoptionProofs) {
        throw new OpensteerError({
          code: "timeout",
          message: "Too many pending Account attachment attempts; try again shortly",
          retryable: true,
        });
      }

      await transaction
        .insertInto("hostAccountAdoptionProofs")
        .values({
          authorizedBySessionId: session.id,
          authorizedByUserId: session.user.id,
          canonicalOrigin: authority.canonicalOrigin,
          completedAt: null,
          consumedAt: null,
          credentialHash: digestSecret(proofCredential),
          deploymentId: authority.deploymentId,
          expectedIssuer: account.issuer,
          expectedSubject: account.subject,
          expiresAt,
          hostInstanceId: authority.hostInstanceId,
          hostKeyFingerprint: authority.hostKeyFingerprint,
          id: proofId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.account-adoption-proof-issued",
          actorSessionId: session.id,
          actorUserId: session.user.id,
          id: createId("securityAudit"),
          metadata: sqlJson({
            deploymentId: authority.deploymentId,
            hostInstanceId: authority.hostInstanceId,
            hostKeyFingerprint: authority.hostKeyFingerprint,
          }),
          requestId: null,
          targetId: proofId,
          targetType: "account-adoption-proof",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return authority;
    });
    return { account, deployment, expiresAt, proofCredential, proofId };
  }

  /**
   * One public, credential-authenticated operation used by the control plane.
   * It proves local administrator approval but does not attach an Account or
   * grant a Host session.
   */
  async consumeAccountAdoptionProof(input: {
    readonly expectedAccount: AccountAdoptionAccount;
    readonly expectedDeployment: AccountAdoptionAuthority;
    readonly proofCredential: string;
    readonly proofId: string;
  }): Promise<ConsumedAccountAdoptionProof> {
    const proofId = parseAccountAdoptionProofId(input.proofId);
    const proofCredential = parseAccountAdoptionCredential(input.proofCredential);
    const expectedAccount = parseAccountAdoptionAccount(input.expectedAccount);
    const expectedDeployment = parseAccountAdoptionAuthority(input.expectedDeployment);
    const now = new Date();
    return this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, `account-adoption-proof:${proofId}`);
      // Every authority-changing operation locks the Deployment row first.
      // Keep that order here as well so a transfer and proof consumption
      // serialize without an inverted row-lock dependency.
      const liveDeployment = await activeDeploymentAuthority(
        transaction,
        true,
        requiredHostKeyFingerprint(this.#options.hostKeyFingerprint),
      );
      if (!sameAccountAdoptionAuthority(liveDeployment, expectedDeployment)) {
        throw invalidAccountAdoptionProof();
      }
      const observed = await transaction
        .selectFrom("hostAccountAdoptionProofs")
        .select(["authorizedByUserId", "authorizedBySessionId"])
        .where("id", "=", proofId)
        .executeTakeFirst();
      if (!observed) throw invalidAccountAdoptionProof();
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", observed.authorizedByUserId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", observed.authorizedBySessionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const proof = await transaction
        .selectFrom("hostAccountAdoptionProofs")
        .selectAll()
        .where("id", "=", proofId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !proof ||
        proof.completedAt ||
        proof.expectedIssuer !== expectedAccount.issuer ||
        proof.expectedSubject !== expectedAccount.subject ||
        !equalSecretDigests(proof.credentialHash, digestSecret(proofCredential))
      ) {
        throw invalidAccountAdoptionProof();
      }
      const proofDeployment = accountAdoptionAuthorityFromRow(proof);
      if (!sameAccountAdoptionAuthority(proofDeployment, expectedDeployment)) {
        throw invalidAccountAdoptionProof();
      }
      // A consume request may have succeeded even though its response never
      // reached the control plane. Return the original receipt only for the
      // exact credential, Account, and authority tuple. Any changed member is
      // rejected above, and completion remains one-use.
      if (proof.consumedAt) {
        return {
          account: expectedAccount,
          authorizedBy: {
            sessionId: proof.authorizedBySessionId,
            userId: proof.authorizedByUserId,
          },
          consumedAt: proof.consumedAt,
          deployment: proofDeployment,
          proofId,
        };
      }
      if (proof.expiresAt <= now) throw invalidAccountAdoptionProof();
      await requireLiveAdministratorSession(
        transaction,
        {
          id: proof.authorizedBySessionId,
          user: { id: proof.authorizedByUserId, instanceRole: "administrator" },
        },
        now,
      );

      const consumed = await transaction
        .updateTable("hostAccountAdoptionProofs")
        .set({
          consumedAt: now,
          expectedIssuer: expectedAccount.issuer,
          expectedSubject: expectedAccount.subject,
        })
        .where("id", "=", proofId)
        .where("consumedAt", "is", null)
        .executeTakeFirst();
      if (consumed.numUpdatedRows !== 1n) throw invalidAccountAdoptionProof();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.account-adoption-proof-consumed",
          actorSessionId: proof.authorizedBySessionId,
          actorUserId: proof.authorizedByUserId,
          id: createId("securityAudit"),
          metadata: sqlJson({
            deploymentId: liveDeployment.deploymentId,
            issuer: expectedAccount.issuer,
          }),
          requestId: null,
          targetId: proofId,
          targetType: "account-adoption-proof",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return {
        account: expectedAccount,
        authorizedBy: {
          sessionId: proof.authorizedBySessionId,
          userId: proof.authorizedByUserId,
        },
        consumedAt: now,
        deployment: liveDeployment,
        proofId,
      };
    });
  }

  /**
   * Binds the verified Account subject to the existing local administrator.
   * The verifier must authenticate the control-plane grant before this method
   * starts its database transaction.
   */
  async completeAccountAdoption(
    grant: unknown,
    session: AuthenticatedSession,
  ): Promise<{
    readonly account: AccountAdoptionAccount;
    readonly proofId: string;
    readonly providerId: string;
    readonly userId: UserId;
  }> {
    requireAdministrator(session);
    const adoption = this.#options.accountAdoption;
    if (!adoption) {
      throw new OpensteerError({
        code: "not_found",
        message: "Account attachment completion is not configured",
      });
    }
    const verified = parseVerifiedAccountAdoptionGrant(await adoption.grantVerifier.verify(grant));
    const logicalProviderId = parseLogicalProviderId(adoption.logicalProviderId);
    const providerId = oidcIdentityProviderIdForIssuer(logicalProviderId, verified.account.issuer);
    const now = new Date();
    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "account-adoption-completion");
      const liveDeployment = await activeDeploymentAuthority(
        transaction,
        true,
        requiredHostKeyFingerprint(this.#options.hostKeyFingerprint),
      );
      if (!sameAccountAdoptionAuthority(liveDeployment, verified.deployment)) {
        throw invalidAccountAdoptionGrant();
      }
      await requireLiveAdministratorSession(transaction, session, now);
      if (
        verified.authorizedBy.userId !== session.user.id ||
        verified.authorizedBy.sessionId !== session.id
      ) {
        throw invalidAccountAdoptionGrant();
      }
      const proof = await transaction
        .selectFrom("hostAccountAdoptionProofs")
        .selectAll()
        .where("id", "=", verified.proofId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !proof?.consumedAt ||
        proof.consumedAt.getTime() !== verified.consumedAt.getTime() ||
        proof.expectedIssuer !== verified.account.issuer ||
        proof.expectedSubject !== verified.account.subject ||
        proof.authorizedByUserId !== session.user.id ||
        proof.authorizedBySessionId !== session.id ||
        !sameAccountAdoptionAuthority(accountAdoptionAuthorityFromRow(proof), liveDeployment)
      ) {
        throw invalidAccountAdoptionGrant();
      }

      const configuredProvider = await transaction
        .selectFrom("accountDirectoryProvider")
        .select(["issuer", "providerId"])
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        configuredProvider &&
        (configuredProvider.issuer !== verified.account.issuer ||
          configuredProvider.providerId !== providerId)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "This Deployment is attached to a different Opensteer Account issuer",
        });
      }
      const accountBindings = await transaction
        .selectFrom("authAccounts")
        .select(["accountId", "providerId", "userId"])
        .where("providerId", "like", `oidc.${logicalProviderId}.%`)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      if (proof.completedAt) {
        if (
          configuredProvider?.issuer === verified.account.issuer &&
          configuredProvider.providerId === providerId &&
          accountBindings.length === 1 &&
          accountBindings[0]?.accountId === verified.account.subject &&
          accountBindings[0].providerId === providerId &&
          accountBindings[0].userId === session.user.id
        ) {
          return;
        }
        throw invalidAccountAdoptionGrant();
      }
      if (accountBindings.length > 0) {
        throw new OpensteerError({
          code: "conflict",
          message: "This Deployment already has an Opensteer Account binding",
        });
      }

      if (!configuredProvider) {
        await transaction
          .insertInto("accountDirectoryProvider")
          .values({
            issuer: verified.account.issuer,
            providerId,
            singletonKey: "opensteer-account",
          })
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto("authAccounts")
        .values({
          accessToken: null,
          accessTokenExpiresAt: null,
          accountId: verified.account.subject,
          id: createId("authAccount"),
          idToken: null,
          password: null,
          providerId,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scope: null,
          userId: session.user.id,
        })
        .executeTakeFirstOrThrow();
      const completion = await transaction
        .updateTable("hostAccountAdoptionProofs")
        .set({ completedAt: now })
        .where("id", "=", verified.proofId)
        .where("completedAt", "is", null)
        .executeTakeFirst();
      if (completion.numUpdatedRows !== 1n) throw invalidAccountAdoptionGrant();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.account-adopted",
          actorSessionId: session.id,
          actorUserId: session.user.id,
          id: createId("securityAudit"),
          metadata: sqlJson({
            grantId: verified.grantId,
            issuer: verified.account.issuer,
            proofId: verified.proofId,
            providerId,
          }),
          requestId: null,
          targetId: liveDeployment.deploymentId,
          targetType: "deployment",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
    return {
      account: verified.account,
      proofId: verified.proofId,
      providerId,
      userId: session.user.id,
    };
  }

  async signInPassword(
    credentials: PasswordCredentials,
    headers: Headers,
    oauthQuery?: string,
  ): Promise<
    TokenFreeAuthResponse<{
      readonly redirectUrl: string | null;
      readonly session: AuthenticatedSession;
    }>
  > {
    if (!this.#options.localPasswordEnabled) {
      throw new OpensteerError({ code: "not_found", message: "Password login is disabled" });
    }
    return this.#signInPassword(credentials, headers, oauthQuery);
  }

  async #signInPassword(
    credentials: PasswordCredentials,
    headers: Headers,
    oauthQuery?: string,
  ): Promise<
    TokenFreeAuthResponse<{
      readonly redirectUrl: string | null;
      readonly session: AuthenticatedSession;
    }>
  > {
    const response = await this.#auth.handler(
      new Request(new URL(`${internalAuthPath}/sign-in/email`, this.#options.publicOrigin), {
        body: JSON.stringify({
          email: normalizeIdentityEmail(credentials.email),
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          password: credentials.password,
          rememberMe: true,
        }),
        headers: forwardedAuthHeaders(headers, true),
        method: "POST",
      }),
    );
    if (response.status === 429) {
      throw new OpensteerError({
        code: "timeout",
        message: "Too many sign-in attempts; try again later",
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new OpensteerError({
        code: "unauthorized",
        message: "Email or password is incorrect",
      });
    }
    const session = await authenticateFromResponseCookie(this, headers, response.headers);
    const redirectUrl = oauthQuery
      ? await oauthRedirectUrl(response.clone(), this.#options.publicOrigin)
      : null;
    return { data: { redirectUrl, session }, headers: response.headers, status: response.status };
  }

  async resetPasswordWithOperatorRecovery(
    tokenValue: string,
    passwordValue: string,
  ): Promise<void> {
    if (!this.#options.localPasswordEnabled) {
      throw new OpensteerError({ code: "not_found", message: "Password login is disabled" });
    }
    const token = LocalPasswordRecoveryTokenSchema.parse(tokenValue);
    const newPassword = IdentityPasswordSchema.parse(passwordValue);
    const passwordHash = await (await this.#auth.$context).password.hash(newPassword);
    const now = new Date();
    // Better Auth's reset deletes every session in one unordered statement
    // inside its own transaction, so the Host consumes its own capability here
    // and fences the sessions in id order first.
    const { recovery, sessions } = await this.#database
      .transaction()
      .execute(async (transaction) => {
        const verification = await transaction
          .deleteFrom("authVerifications")
          .where("identifier", "=", `reset-password:${token}`)
          .where("expiresAt", ">", now)
          .returning("value")
          .executeTakeFirst();
        const userId = UserIdSchema.safeParse(verification?.value);
        const recovery = userId.success
          ? await transaction
              .selectFrom("users")
              .select(["id as userId", "disabledAt", "instanceRole"])
              .where("id", "=", userId.data)
              .forNoKeyUpdate()
              .executeTakeFirst()
          : undefined;
        if (
          !recovery ||
          recovery.instanceRole !== "administrator" ||
          recovery.disabledAt !== null
        ) {
          throw invalidOperatorRecoveryLink();
        }
        const sessions = await transaction
          .selectFrom("authSessions")
          .select("id")
          .where("userId", "=", recovery.userId)
          .orderBy("id", "asc")
          // FOR UPDATE: fence the exact ordered deletion set.
          .forUpdate()
          .execute();
        await transaction
          .deleteFrom("authSessions")
          .where("userId", "=", recovery.userId)
          .execute();
        const updated = await transaction
          .updateTable("authAccounts")
          .set({ password: passwordHash, updatedAt: now })
          .where("userId", "=", recovery.userId)
          .where("providerId", "=", "credential")
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) throw invalidOperatorRecoveryLink();
        return { recovery, sessions };
      });
    for (const session of sessions) this.#options.onSessionEnded?.(session.id);

    await this.#database
      .insertInto("securityAudit")
      .values({
        action: "auth.password-reset-by-local-operator",
        actorSessionId: null,
        actorUserId: null,
        id: createId("securityAudit"),
        metadata: sqlJson({ revokedSessionCount: sessions.length }),
        requestId: null,
        targetId: recovery.userId,
        targetType: "user",
        workspaceId: null,
      })
      .executeTakeFirstOrThrow();
  }

  async signUpPassword(
    input: PasswordSignup,
    headers: Headers,
  ): Promise<TokenFreeAuthResponse<{ readonly session: AuthenticatedSession }>> {
    if (!this.#options.localPasswordEnabled) {
      throw new OpensteerError({ code: "not_found", message: "Password signup is disabled" });
    }
    return this.#signUpPassword(input, headers);
  }

  async #signUpPassword(
    input: PasswordSignup,
    headers: Headers,
  ): Promise<TokenFreeAuthResponse<{ readonly session: AuthenticatedSession }>> {
    if (!IdentityPasswordSchema.safeParse(input.password).success) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Password must contain between ${identityPasswordMinLength} and ${identityPasswordMaxLength} characters`,
      });
    }
    const email = normalizeIdentityEmail(input.email);
    if (this.#options.signupPolicy !== "open") {
      await this.#reserveSignupAdmission(headers, email);
    }
    const displayName = input.displayName?.trim() || displayNameFromEmail(email);
    const response = await this.#auth.handler(
      new Request(new URL(`${internalAuthPath}/sign-up/email`, this.#options.publicOrigin), {
        body: JSON.stringify({ email, name: displayName, password: input.password }),
        headers: forwardedAuthHeaders(headers, true),
        method: "POST",
      }),
    );
    await assertSuccessfulBetterAuthResponse(response);
    const session = await authenticateFromResponseCookie(this, headers, response.headers);
    return { data: { session }, headers: response.headers, status: response.status };
  }

  /**
   * Claims an unclaimed Host in one call: establish the owner's identity and
   * promote them to administrator, holding a valid setup admission throughout.
   *
   * This is deliberately one operation rather than the sign-up and promote pair
   * a caller could chain. Chaining leaves a window in which the user row exists
   * but the Host is still unclaimed, and the only route out of that window is
   * the setup screen, which cannot sign an existing user in. Collapsing the two
   * removes the window instead of recovering from it.
   */
  async claimInitialOwner(
    credentials: PasswordCredentials,
    headers: Headers,
  ): Promise<TokenFreeAuthResponse<{ readonly session: AuthenticatedSession }>> {
    if (!this.#options.localPasswordEnabled) {
      throw new OpensteerError({ code: "not_found", message: "Password setup is disabled" });
    }
    return this.#claimInitialOwner(credentials, headers);
  }

  async #claimInitialOwner(
    credentials: PasswordSignup,
    headers: Headers,
  ): Promise<TokenFreeAuthResponse<{ readonly session: AuthenticatedSession }>> {
    const admission = await this.#admissionFromHeaders(headers);
    if (!admission || admission.purpose !== "setup") {
      throw new OpensteerError({ code: "forbidden", message: "Setup admission required" });
    }
    const email = normalizeIdentityEmail(credentials.email);
    const existing = await this.#database
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();

    // Re-running setup against an account that already exists is the normal
    // recovery path, not an error: an earlier attempt may have created the user
    // before the Host was claimed.
    const authenticated = existing
      ? await this.#signInPassword({ email, password: credentials.password }, headers)
      : await this.#signUpPassword(
          {
            email,
            password: credentials.password,
            ...(credentials.displayName ? { displayName: credentials.displayName } : {}),
          },
          headers,
        );

    const authenticatedHeaders = headersWithResponseCookies(headers, authenticated.headers);
    const completion = await this.completeInitialOwnerSetup(authenticatedHeaders);
    const session = await this.requireSession(authenticatedHeaders);
    const merged = new Headers();
    for (const cookie of authenticated.headers.getSetCookie()) merged.append("set-cookie", cookie);
    for (const cookie of completion.headers.getSetCookie()) merged.append("set-cookie", cookie);
    return { data: { session }, headers: merged, status: 200 };
  }

  /**
   * Establishes the Desktop's Host-local owner session without asking the
   * person to create an Opensteer password. This is deliberately available
   * only when the composition root selected the loopback machine-owner mode.
   * Repeated calls sign the same durable owner back in; they never create a
   * second user or replace another administrator.
   */
  async claimLocalMachineOwner(
    enrollmentToken: string,
    headers: Headers = new Headers(),
  ): Promise<TokenFreeAuthResponse<{ readonly session: AuthenticatedSession }>> {
    const configuredEnrollmentToken = this.#options.initialOwnerEnrollment?.token;
    if (
      !configuredEnrollmentToken ||
      !equalSecretDigests(digestSecret(configuredEnrollmentToken), digestSecret(enrollmentToken))
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Local owner proof is invalid" });
    }
    const owner = this.#options.localMachineOwner;
    if (!owner || this.#options.exposure !== "loopback") {
      throw new OpensteerError({ code: "not_found", message: "Local owner setup is unavailable" });
    }
    const email = normalizeIdentityEmail(owner.email);
    const administrator = await this.#database
      .selectFrom("users")
      .select(["disabledAt", "email", "id"])
      .where("instanceRole", "=", "administrator")
      .executeTakeFirst();
    if (administrator && (administrator.disabledAt || administrator.email !== email)) {
      throw new OpensteerError({
        code: "conflict",
        message: "This Host is already owned by another identity",
      });
    }
    const password = createHmac("sha256", this.#options.secret)
      .update("opensteer-local-machine-owner-password-v1")
      .digest("base64url");
    if (administrator) {
      const signedIn = await this.#signInPassword({ email, password }, headers);
      await this.#markMachineLocalSession(signedIn.data.session.id);
      return {
        data: { session: signedIn.data.session },
        headers: signedIn.headers,
        status: signedIn.status,
      };
    }

    const admission = await this.exchangeInitialOwnerEnrollment(enrollmentToken, headers);
    const admittedHeaders = headersWithResponseCookies(headers, admission.headers);
    const claimed = await this.#claimInitialOwner(
      { displayName: owner.displayName, email, password },
      admittedHeaders,
    );
    await this.#markMachineLocalSession(claimed.data.session.id);
    return claimed;
  }

  /**
   * Records that this session was established by spending the process-launch
   * capability only the application running on this computer holds. Better
   * Auth owns the transaction that creates the session, so the marker is
   * written immediately afterwards and before the session is handed back — a
   * marker that fails to land leaves a session that simply is not
   * machine-local, which is the safe direction.
   */
  async #markMachineLocalSession(sessionId: AuthSessionId): Promise<void> {
    await this.#database
      .insertInto("machineLocalSessions")
      .values({ authSessionId: sessionId, establishedAt: new Date() })
      .onConflict((conflict) => conflict.column("authSessionId").doNothing())
      .execute();
  }

  async signOut(headers: Headers): Promise<TokenFreeAuthResponse<{ readonly signedOut: true }>> {
    const session = await this.#authenticateSessionCookie(headers);
    const response = await this.#auth.api.signOut({ asResponse: true, headers });
    await assertSuccessfulBetterAuthResponse(response);
    if (session) this.#options.onSessionEnded?.(session.id);
    return { data: { signedOut: true }, headers: response.headers, status: response.status };
  }

  async beginOidcSignIn(input: {
    readonly headers: Headers;
    readonly oauthQuery?: string;
    readonly providerId: string;
    readonly returnPath: string;
  }): Promise<TokenFreeAuthResponse<{ readonly redirectUrl: string }>> {
    const provider = this.#options.oidcProviders.find(
      (candidate) => candidate.providerId === input.providerId,
    );
    if (!provider) {
      throw new OpensteerError({ code: "not_found", message: "Identity provider not found" });
    }
    const callbackUrl = new URL(input.returnPath, this.#options.publicOrigin);
    if (callbackUrl.origin !== this.#options.publicOrigin.origin) {
      throw new OpensteerError({ code: "bad_request", message: "OIDC return path is invalid" });
    }
    if (input.oauthQuery) {
      if (callbackUrl.pathname !== "/" || callbackUrl.search || callbackUrl.hash) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Native authorization must return to the Host root",
        });
      }
      // The OAuth provider signs this complete query before login. Carry that
      // opaque continuation in the SSO callback URL as well as in the provider
      // hook so the browser returns to consent even when a different Better
      // Auth sign-in plugin creates the Host session.
      callbackUrl.search = input.oauthQuery;
    }
    const request = new Request(
      new URL(`${internalAuthPath}/sign-in/sso`, this.#options.publicOrigin),
      {
        body: JSON.stringify({
          callbackURL: callbackUrl.toString(),
          ...(input.oauthQuery ? { oauth_query: input.oauthQuery } : {}),
          providerId: oidcIdentityProviderId(provider),
          requestSignUp: true,
        }),
        headers: forwardedAuthHeaders(input.headers, true),
        method: "POST",
      },
    );
    const response = await this.#auth.handler(request);
    await assertSuccessfulBetterAuthResponse(response);
    const body = (await response.json()) as { url?: unknown };
    if (typeof body.url !== "string") {
      throw new OpensteerError({ code: "internal", message: "OIDC provider returned no redirect" });
    }
    return {
      data: { redirectUrl: body.url },
      headers: response.headers,
      status: response.status,
    };
  }

  async handleOidcCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = `${internalAuthPath}/sso/callback`;
    const response = await this.#auth.handler(
      new Request(url, { headers: forwardedAuthHeaders(request.headers), method: "GET" }),
    );
    if (response.status < 300 || response.status >= 400) return response;
    const admission = await this.#admissionFromHeaders(request.headers);
    if (!admission) return response;

    const authenticatedHeaders = headersWithResponseCookies(request.headers, response.headers);
    const completionHeaders =
      admission.purpose === "setup"
        ? (await this.completeInitialOwnerSetup(authenticatedHeaders)).headers
        : admission.purpose === "invitation"
          ? (await this.acceptInvitation(authenticatedHeaders)).headers
          : undefined;
    if (!completionHeaders) return response;
    const headers = new Headers(response.headers);
    for (const cookie of completionHeaders.getSetCookie()) headers.append("set-cookie", cookie);
    headers.set("location", this.#options.publicOrigin.origin);
    return new Response(response.body, { headers, status: response.status });
  }

  async listSessions(current: AuthenticatedSession): Promise<readonly AuthSessionSummary[]> {
    const authenticated = AuthenticatedSessionSchema.parse(current);
    const rows = await this.#database
      .selectFrom("authSessions")
      .leftJoin("machineLocalSessions", "machineLocalSessions.authSessionId", "authSessions.id")
      .select([
        "authSessions.absoluteExpiresAt",
        "authSessions.createdAt",
        "authSessions.deviceLabel",
        "authSessions.expiresAt",
        "authSessions.id",
        "authSessions.lastSeenAt",
        "authSessions.userAgent",
        "machineLocalSessions.authSessionId as machineLocalSessionId",
      ])
      .where("authSessions.userId", "=", authenticated.user.id)
      .where("authSessions.expiresAt", ">", new Date())
      .where("authSessions.absoluteExpiresAt", ">", new Date())
      .orderBy("authSessions.lastSeenAt", "desc")
      .limit(101)
      .execute();
    if (rows.length > 100) {
      throw new OpensteerError({ code: "conflict", message: "Session inventory limit exceeded" });
    }
    return rows.map((row) => {
      // Described from the header on every read, so sessions stored before
      // labels were readable are named like new ones. A session with no header
      // keeps the label it was given when it was issued.
      const device = row.userAgent === null ? null : describeSessionDevice(row.userAgent);
      return {
        absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        current: row.id === authenticated.id,
        deviceLabel: device?.label ?? row.deviceLabel,
        expiresAt: row.expiresAt.toISOString(),
        form: device?.form ?? null,
        id: row.id,
        lastSeenAt: row.lastSeenAt.toISOString(),
        machineLocal: row.machineLocalSessionId !== null,
      };
    });
  }

  /**
   * Logins another owner of the session table deleted in its own transaction.
   * Their live connections end exactly as a sign-out's do.
   */
  announceSessionsEnded(sessionIds: readonly AuthSessionId[]): void {
    for (const sessionId of sessionIds) this.#options.onSessionEnded?.(sessionId);
  }

  async revokeSession(current: AuthenticatedSession, sessionId: string): Promise<void> {
    const authenticated = AuthenticatedSessionSchema.parse(current);
    const parsedId = AuthSessionIdSchema.parse(sessionId);
    const result = await this.#database
      .deleteFrom("authSessions")
      .where("id", "=", parsedId)
      .where("userId", "=", authenticated.user.id)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n) {
      throw new OpensteerError({ code: "not_found", message: "Session not found" });
    }
    this.#options.onSessionEnded?.(parsedId);
  }

  async exchangeInvitation(
    selector: string,
    verifier: string,
    headers: Headers = new Headers(),
  ): Promise<TokenFreeAuthResponse<{ readonly preview: InvitationPreview }>> {
    const record = await this.#store.invitationForExchange(selector);
    if (
      !record ||
      record.invitation.acceptedAt ||
      record.invitation.revokedAt ||
      record.invitation.expiresAt <= new Date() ||
      record.tokenHash !== digestSecret(verifier)
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Invitation is invalid" });
    }
    const admission = await this.#createOrReuseAdmission(
      {
        purpose: "invitation",
        reservedEmail: record.invitation.intendedEmail,
        subjectSelector: selector,
      },
      headers,
    );
    return {
      data: {
        preview: InvitationPreviewSchema.parse({
          expiresAt: record.invitation.expiresAt.toISOString(),
          invitationType: record.invitation.type,
          inviterName: record.inviterName,
          requiresVerifiedEmail: record.invitation.type === "email",
          role: record.invitation.role,
          workspaceName: record.workspaceName,
        }),
      },
      headers: admission.headers,
      status: 200,
    };
  }

  async createWorkspaceInvitation(input: {
    readonly createdBy: UserId;
    readonly idempotencyKey: string;
    readonly intendedEmail?: string;
    readonly lifetimeSeconds: number;
    readonly role: "owner" | "collaborator";
    readonly type: "email" | "link";
    readonly workspaceId: import("@opensteer/core").WorkspaceId;
  }) {
    if (input.type === "email" && !this.#options.emailDeliveryAvailable) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Email invitations are unavailable on this Host",
      });
    }
    if (
      !Number.isSafeInteger(input.lifetimeSeconds) ||
      input.lifetimeSeconds < 5 * 60 ||
      input.lifetimeSeconds > 30 * 24 * 60 * 60
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Invitation lifetime must be between five minutes and 30 days",
      });
    }
    if (!/^[\x21-\x7e]{1,255}$/u.test(input.idempotencyKey)) {
      throw new OpensteerError({ code: "bad_request", message: "Idempotency key is invalid" });
    }
    const intendedEmail = input.intendedEmail ? normalizeIdentityEmail(input.intendedEmail) : null;
    if ((input.type === "email") !== (intendedEmail !== null)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Email invitations require exactly one intended email address",
      });
    }
    const transcript = JSON.stringify([
      "opensteer-workspace-invitation-v1",
      input.createdBy,
      input.workspaceId,
      input.idempotencyKey,
      input.type,
      input.role,
      intendedEmail,
      input.lifetimeSeconds,
    ]);
    const selector = createHmac("sha256", this.#options.secret)
      .update(`selector\0${transcript}`)
      .digest("base64url");
    const verifier = createHmac("sha256", this.#options.secret)
      .update(`verifier\0${transcript}`)
      .digest("base64url");
    const invitation = await this.#store.createWorkspaceInvitation({
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + input.lifetimeSeconds * 1_000),
      idempotencyKey: input.idempotencyKey,
      intendedEmail,
      requestFingerprint: digestSecret(transcript),
      role: input.role,
      selector,
      tokenHash: digestSecret(verifier),
      type: input.type,
      workspaceId: input.workspaceId,
    });
    return { invitation, verifier };
  }

  async acceptInvitation(headers: Headers) {
    const session = await this.requireSession(headers);
    const admission = await this.#admissionFromHeaders(headers);
    if (!admission || admission.purpose !== "invitation") {
      throw new OpensteerError({ code: "forbidden", message: "Invitation admission required" });
    }
    const record = await this.#store.invitationForExchange(admission.subjectSelector);
    if (!record) {
      throw new OpensteerError({ code: "not_found", message: "Invitation not found" });
    }
    const membership = await this.#store.acceptWorkspaceInvitation({
      selector: admission.subjectSelector,
      tokenHash: record.tokenHash,
      userEmail: session.user.email,
      userEmailVerified: session.user.emailVerified,
      userId: session.user.id,
    });
    await this.#consumeAdmission(admission.id, session.user.id);
    return { headers: clearAdmissionCookie(this.#options.publicOrigin), membership };
  }

  async exchangeInitialOwnerEnrollment(
    token: string,
    headers: Headers = new Headers(),
  ): Promise<TokenFreeAuthResponse<{ readonly admitted: true }>> {
    await this.#ensureInitialOwnerEnrollment();
    const tokenHash = digestSecret(token.trim());
    const [enrollment, administrator] = await Promise.all([
      this.#database
        .selectFrom("ownerEnrollments")
        .select(["consumedAt", "expiresAt", "id"])
        .where("tokenHash", "=", tokenHash)
        .where("kind", "=", "initial")
        .executeTakeFirst(),
      this.#database
        .selectFrom("users")
        .select("id")
        .where("instanceRole", "=", "administrator")
        .executeTakeFirst(),
    ]);
    if (
      administrator ||
      !enrollment ||
      enrollment.consumedAt ||
      enrollment.expiresAt <= new Date()
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message:
          "That setup code is incorrect or expired. Use the current one-time code generated for this Host.",
      });
    }
    const admission = await this.#createOrReuseAdmission(
      {
        purpose: "setup",
        reservedEmail: null,
        subjectSelector: enrollment.id,
      },
      headers,
    );
    return { data: { admitted: true }, headers: admission.headers, status: 200 };
  }

  async completeInitialOwnerSetup(headers: Headers): Promise<{
    readonly headers: Headers;
    readonly userId: UserId;
  }> {
    const session = await this.requireSession(headers);
    const admission = await this.#admissionFromHeaders(headers);
    if (!admission || admission.purpose !== "setup") {
      throw new OpensteerError({ code: "forbidden", message: "Setup admission required" });
    }
    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "initial-owner-setup");
      const enrollment = await transaction
        .selectFrom("ownerEnrollments")
        .selectAll()
        .where("id", "=", admission.subjectSelector)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!enrollment || enrollment.expiresAt <= new Date()) {
        throw new OpensteerError({ code: "forbidden", message: "Setup enrollment is invalid" });
      }
      if (enrollment.consumedAt) {
        if (enrollment.consumedBy !== session.user.id) {
          throw new OpensteerError({ code: "conflict", message: "Setup is already complete" });
        }
        return;
      }
      const historicalAdministrator = await transaction
        .selectFrom("users")
        .select("id")
        .where("instanceRole", "=", "administrator")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (historicalAdministrator && historicalAdministrator.id !== session.user.id) {
        throw new OpensteerError({ code: "conflict", message: "Setup is already complete" });
      }
      const now = new Date();
      await transaction
        .updateTable("users")
        .set({ instanceRole: "administrator", updatedAt: now })
        .where("id", "=", session.user.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("ownerEnrollments")
        .set({ consumedAt: now, consumedBy: session.user.id })
        .where("id", "=", enrollment.id)
        .where("consumedAt", "is", null)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "instance.initial-owner-claimed",
          actorSessionId: session.id,
          actorUserId: session.user.id,
          id: createId("securityAudit"),
          metadata: sqlJson({}),
          requestId: null,
          targetId: session.user.id,
          targetType: "user",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
    await this.#consumeAdmission(admission.id, session.user.id);
    return { headers: clearAdmissionCookie(this.#options.publicOrigin), userId: session.user.id };
  }

  async #createAdmission(input: {
    readonly purpose: "setup" | "recovery" | "invitation";
    readonly reservedEmail: string | null;
    readonly subjectSelector: string;
  }): Promise<{ readonly headers: Headers }> {
    const id = createId("authAdmission");
    const nonce = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.#database.transaction().execute(async (transaction) => {
      await sqlAdvisoryLock(transaction, "auth-admission-capacity");
      await transaction.deleteFrom("authAdmissions").where("expiresAt", "<=", now).execute();

      // The initial setup secret is an operator-held, one-time capability. If a browser loses
      // its admission cookie or signup fails after reserving the admission, requiring the
      // operator to wait for expiry creates a needless ten-minute lockout. Rotate that one
      // unfinished admission while holding the global capacity lock. Invitation admissions
      // remain non-replaceable because shared invitation links must not let one browser evict
      // another browser's in-progress acceptance.
      if (input.purpose === "setup") {
        await transaction
          .deleteFrom("authAdmissions")
          .where("purpose", "=", "setup")
          .where("subjectSelector", "=", input.subjectSelector)
          .where("consumedAt", "is", null)
          .execute();
      }

      const total = await transaction
        .selectFrom("authAdmissions")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("consumedAt", "is", null)
        .executeTakeFirstOrThrow();
      const subjectCount =
        input.purpose === "setup"
          ? 0
          : Number(
              (
                await transaction
                  .selectFrom("authAdmissions")
                  .select((expression) => expression.fn.countAll<string>().as("count"))
                  .where("consumedAt", "is", null)
                  .where("subjectSelector", "=", input.subjectSelector)
                  .executeTakeFirstOrThrow()
              ).count,
            );
      if (
        Number(total.count) >= maxPendingAdmissions ||
        subjectCount >= maxPendingAdmissionsPerSubject
      ) {
        throw new OpensteerError({
          code: "timeout",
          message: "Too many pending authentication attempts; try again later",
          retryable: true,
        });
      }
      await transaction
        .insertInto("authAdmissions")
        .values({
          browserNonceHash: digestSecret(nonce),
          consumedAt: null,
          consumedBy: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.#admissionLifetimeMilliseconds),
          id,
          purpose: input.purpose,
          reservedAt: input.reservedEmail ? now : null,
          reservedEmail: input.reservedEmail,
          subjectSelector: input.subjectSelector,
        })
        .executeTakeFirstOrThrow();
    });
    const headers = new Headers();
    headers.append(
      "set-cookie",
      admissionCookie(
        `${id}.${nonce}`,
        this.#options.publicOrigin,
        this.#admissionLifetimeMilliseconds,
      ),
    );
    return { headers };
  }

  async #createOrReuseAdmission(
    input: {
      readonly purpose: "setup" | "recovery" | "invitation";
      readonly reservedEmail: string | null;
      readonly subjectSelector: string;
    },
    headers: Headers,
  ): Promise<{ readonly headers: Headers }> {
    const existing = await this.#admissionFromHeaders(headers);
    if (
      existing &&
      !existing.consumedBy &&
      existing.purpose === input.purpose &&
      existing.subjectSelector === input.subjectSelector &&
      existing.reservedEmail === input.reservedEmail
    ) {
      return { headers: new Headers() };
    }
    return this.#createAdmission(input);
  }

  async #admissionFromHeaders(headers: Headers): Promise<{
    readonly consumedBy: UserId | null;
    readonly id: AuthAdmissionId;
    readonly purpose: "setup" | "recovery" | "invitation";
    readonly reservedEmail: string | null;
    readonly subjectSelector: string;
  } | null> {
    const value = readCookie(headers.get("cookie"), admissionCookieName);
    if (!value) return null;
    const separator = value.indexOf(".");
    if (separator < 1) return null;
    const id = AuthAdmissionIdSchema.safeParse(value.slice(0, separator));
    if (!id.success) return null;
    const nonce = value.slice(separator + 1);
    const row = await this.#database
      .selectFrom("authAdmissions")
      .select([
        "browserNonceHash",
        "consumedBy",
        "expiresAt",
        "id",
        "purpose",
        "reservedEmail",
        "subjectSelector",
      ])
      .where("id", "=", id.data)
      .executeTakeFirst();
    if (!row || row.expiresAt <= new Date() || row.browserNonceHash !== digestSecret(nonce)) {
      return null;
    }
    return row;
  }

  async #reserveSignupAdmission(headers: Headers, email: string): Promise<void> {
    const admission = await this.#admissionFromHeaders(headers);
    if (!admission || admission.consumedBy) {
      throw new OpensteerError({ code: "forbidden", message: "Signup admission required" });
    }
    const now = new Date();
    let update = this.#database
      .updateTable("authAdmissions")
      .set({ reservedAt: now, reservedEmail: email })
      .where("id", "=", admission.id)
      .where("consumedAt", "is", null);
    if (admission.purpose !== "setup") {
      // An invitation names the address it was issued for, so its admission
      // pins that address. A setup admission proves possession of the Host's
      // own credential and says nothing about which address should own it, so
      // correcting a mistyped email must not require waiting out the admission.
      update = update.where((expression) =>
        expression.or([
          expression("reservedEmail", "is", null),
          expression("reservedEmail", "=", email),
        ]),
      );
    }
    const result = await update.executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "forbidden", message: "Signup admission is unavailable" });
    }
  }

  async #requireSignupAdmission(request: Request | undefined, email: string): Promise<void> {
    if (this.#options.signupPolicy === "open") return;
    if (!request) throw new APIError("FORBIDDEN", { message: "Signup admission required" });
    const admission = await this.#admissionFromHeaders(request.headers);
    if (
      !admission ||
      admission.consumedBy ||
      (admission.reservedEmail !== null && admission.reservedEmail !== email)
    ) {
      throw new APIError("FORBIDDEN", { message: "Signup admission required" });
    }
    if (admission.purpose === "invitation") {
      const invitation = await this.#store.invitationForExchange(admission.subjectSelector);
      if (
        !invitation ||
        invitation.invitation.acceptedAt ||
        invitation.invitation.revokedAt ||
        invitation.invitation.expiresAt <= new Date()
      ) {
        throw new APIError("FORBIDDEN", { message: "Signup admission required" });
      }
    }
    if (admission.purpose === "setup") {
      const enrollment = await this.#database
        .selectFrom("ownerEnrollments")
        .select(["consumedAt", "expiresAt"])
        .where("id", "=", admission.subjectSelector)
        .where("kind", "=", "initial")
        .executeTakeFirst();
      if (!enrollment || enrollment.consumedAt || enrollment.expiresAt <= new Date()) {
        throw new APIError("FORBIDDEN", { message: "Signup admission required" });
      }
    }
  }

  async #consumeAdmission(id: AuthAdmissionId, userId: UserId): Promise<void> {
    const now = new Date();
    const result = await this.#database
      .updateTable("authAdmissions")
      .set({ consumedAt: now, consumedBy: userId })
      .where("id", "=", id)
      .where((expression) =>
        expression.or([
          expression("consumedAt", "is", null),
          expression("consumedBy", "=", userId),
        ]),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "conflict", message: "Admission was already consumed" });
    }
  }
}

function createOpensteerAuth(
  database: Kysely<DatabaseSchema>,
  options: IdentityServiceOptions,
  requireSignupAdmission: (request: Request | undefined, email: string) => Promise<void>,
) {
  const secure = options.publicOrigin.protocol === "https:";
  const providerOrigins = options.oidcProviders.flatMap((provider) => [
    // A configured provider's issuer is the party this Host already trusts to
    // authenticate its users, so its origin is always trusted — the SSO
    // plugin's discovery validator refuses to fetch endpoint documents from
    // an untrusted origin. The extra per-provider origins remain a private-
    // network affordance for local development.
    new URL(provider.issuer).origin,
    ...(provider.allowPrivateNetwork
      ? provider.trustedOrigins.map((origin) => new URL(origin).origin)
      : []),
  ]);
  const databaseOption = {
    db: database,
    transaction: true,
    type: "postgres",
  } as unknown as BetterAuthOptions["database"];
  return betterAuth({
    account: {
      accountLinking: { disableImplicitLinking: true, enabled: false },
      encryptOAuthTokens: true,
      modelName: "authAccounts",
      storeAccountCookie: false,
    },
    advanced: {
      cookies: {
        session_token: {
          attributes: { httpOnly: true, path: "/", sameSite: "lax", secure },
          name: secure ? "__Host-opensteer.session" : "opensteer.session",
        },
      },
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, path: "/", sameSite: "lax", secure },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      database: {
        generateId: ({ model }) => {
          if (model === "user") return createId("user");
          if (model === "session") return createId("authSession");
          if (model === "account") return createId("authAccount");
          if (model === "verification") return createId("authVerification");
          return `bat_${globalThis.crypto.randomUUID()}`;
        },
      },
      useSecureCookies: false,
    },
    appName: "Opensteer",
    basePath: internalAuthPath,
    baseURL: options.publicOrigin.origin,
    database: databaseOption,
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const now = new Date();
            // Better Auth assigns createdAt before this hook. Anchor the hard
            // lifetime to that durable timestamp instead of sampling the clock
            // again, which can otherwise extend the policy by a few milliseconds.
            const createdAt = new Date(session.createdAt);
            return {
              data: {
                ...session,
                absoluteExpiresAt: new Date(createdAt.getTime() + absoluteSessionMilliseconds),
                deviceLabel: describeSessionDevice(
                  context?.request?.headers.get("user-agent") ?? null,
                ).label,
                lastSeenAt: now,
              },
            };
          },
        },
      },
      user: {
        create: {
          before: async (user, context) => {
            const email = normalizeIdentityEmail(user.email);
            await requireSignupAdmission(context?.request, email);
            return { data: { ...user, email } };
          },
        },
      },
    },
    disabledPaths: [
      "/change-email",
      "/delete-user",
      "/link-social",
      "/request-password-reset",
      "/reset-password",
      "/sso/delete-provider",
      "/sso/get-provider",
      "/sso/providers",
      "/sso/register",
      "/sso/request-domain-verification",
      "/sso/saml2/callback/:providerId",
      "/sso/saml2/logout/:providerId",
      "/sso/saml2/sp/acs/:providerId",
      "/sso/saml2/sp/metadata",
      "/sso/update-provider",
      "/sso/verify-domain",
      "/unlink-account",
    ],
    emailAndPassword: {
      disableSignUp: !options.localPasswordEnabled && !options.localMachineOwner,
      enabled: options.localPasswordEnabled || options.localMachineOwner !== undefined,
      maxPasswordLength: identityPasswordMaxLength,
      minPasswordLength: identityPasswordMinLength,
      requireEmailVerification: false,
    },
    plugins: [
      ...(options.oidcProviders.length === 0
        ? []
        : [
            sso({
              redirectURI: new URL("/v1/auth/oidc/callback", options.publicOrigin).toString(),
              defaultSSO: options.oidcProviders.map((provider) => ({
                domain: new URL(provider.issuer).hostname,
                oidcConfig: {
                  clientId: provider.clientId,
                  clientSecret: provider.clientSecret,
                  discoveryEndpoint:
                    provider.discoveryEndpoint ??
                    `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                  issuer: provider.issuer,
                  pkce: true,
                  scopes: ["openid", "email", "profile"],
                },
                providerId: oidcIdentityProviderId(provider),
              })),
              disableImplicitSignUp: options.signupPolicy !== "open",
              domainVerification: { enabled: false },
              modelName: "authSsoProviders",
              organizationProvisioning: { disabled: true },
              providersLimit: 0,
            }),
          ]),
      ...(options.nativeOAuth
        ? [
            jwt({
              disableSettingJwtHeader: true,
              jwt: {
                audience: options.publicOrigin.origin,
                issuer: options.publicOrigin.origin,
              },
              schema: { jwks: { modelName: "authJwks" } },
            }),
            oauthProvider({
              accessTokenExpiresIn: 10 * 60,
              allowDynamicClientRegistration: false,
              allowPublicClientPrelogin: false,
              allowUnauthenticatedClientRegistration: false,
              codeExpiresIn: 5 * 60,
              consentPage: "/",
              grantTypes: ["authorization_code", "refresh_token"],
              idTokenExpiresIn: 10 * 60,
              loginPage: "/",
              refreshTokenExpiresIn: 30 * 24 * 60 * 60,
              schema: {
                oauthAccessToken: { modelName: "hostOAuthAccessTokens" },
                oauthClient: {
                  fields: { requirePKCE: "requirePkce" },
                  modelName: "hostOAuthClients",
                },
                oauthConsent: { modelName: "hostOAuthConsents" },
                oauthResource: { modelName: "hostOAuthResources" },
                oauthClientResource: { modelName: "hostOAuthClientResources" },
                oauthClientAssertion: { modelName: "hostOAuthClientAssertions" },
                oauthRefreshToken: { modelName: "hostOAuthRefreshTokens" },
              },
              scopes: [...nativeOAuthScopes],
              storeClientSecret: "hashed",
              storeTokens: "hashed",
              resources: [options.publicOrigin.origin],
              enforcePerClientResources: false,
            }),
          ]
        : []),
    ],
    // These limits exist to blunt credential stuffing, not to police an operator
    // setting up their own Host. A `hosted` Host already gates signup behind an
    // invitation admission that is separately rate limited, so a tight limit
    // here is a redundant second layer whose only reliable effect is locking out
    // the legitimate user mid-setup. One set of values, generous enough that
    // normal use never reaches them.
    rateLimit: {
      customRules: {
        "/sign-in/email": { max: 30, window: 60 },
        "/sign-in/sso": { max: 30, window: 60 },
        "/sign-up/email": { max: 30, window: 300 },
        "/verify-password": { max: 20, window: 300 },
      },
      enabled: true,
      max: 300,
      modelName: "authRateLimits",
      storage: "database",
      window: 60,
    },
    secret: options.secret,
    session: {
      additionalFields: {
        absoluteExpiresAt: { input: false, returned: false, type: "date" },
        deviceLabel: { input: false, returned: false, type: "string" },
        lastSeenAt: { input: false, returned: false, type: "date" },
      },
      cookieCache: { enabled: false },
      expiresIn: idleSessionSeconds,
      modelName: "authSessions",
      updateAge: 24 * 60 * 60,
    },
    trustedOrigins: [options.publicOrigin.origin, ...providerOrigins],
    user: {
      additionalFields: {
        disabledAt: { input: false, required: false, returned: false, type: "date" },
        instanceRole: {
          defaultValue: "user",
          input: false,
          returned: false,
          type: ["administrator", "user"],
        },
      },
      deleteUser: { enabled: false },
      fields: { name: "displayName" },
      modelName: "users",
    },
    verification: { modelName: "authVerifications" },
  });
}

export function oidcIdentityProviderId(
  provider: IdentityServiceOptions["oidcProviders"][number],
): string {
  return oidcIdentityProviderIdForIssuer(provider.providerId, provider.issuer);
}

export function oidcIdentityProviderIdForIssuer(providerId: string, issuerValue: string): string {
  const parsedProviderId = parseLogicalProviderId(providerId);
  const issuer = new URL(issuerValue).toString().replace(/\/$/u, "");
  const issuerDigest = createHash("sha256").update(issuer).digest("base64url").slice(0, 22);
  return `oidc.${parsedProviderId}.${issuerDigest}`;
}

function parseLogicalProviderId(value: string): string {
  const providerId = value.trim();
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(providerId)) {
    throw new Error("Account identity provider ID is invalid");
  }
  return providerId;
}

function parseAccountAdoptionProofId(value: string): string {
  if (!accountAdoptionProofIdPattern.test(value)) throw invalidAccountAdoptionProof();
  return value;
}

function parseAccountAdoptionCredential(value: string): string {
  if (!accountAdoptionCredentialPattern.test(value)) throw invalidAccountAdoptionProof();
  return value;
}

function parseAccountAdoptionAccount(input: AccountAdoptionAccount): AccountAdoptionAccount {
  const issuer = CanonicalOriginSchema.safeParse(input?.issuer);
  const issuerUrl = issuer.success ? new URL(issuer.data) : null;
  const httpLoopback =
    issuerUrl?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(issuerUrl.hostname);
  if (
    !issuer.success ||
    (issuerUrl?.protocol !== "https:" && !httpLoopback) ||
    !controlPlaneAccountSubjectPattern.test(input?.subject ?? "")
  ) {
    throw invalidAccountAdoptionProof();
  }
  return { issuer: issuer.data, subject: input.subject };
}

function parseAccountAdoptionAuthority(input: AccountAdoptionAuthority): AccountAdoptionAuthority {
  const deploymentId = DeploymentIdSchema.safeParse(input?.deploymentId);
  const hostInstanceId = HostInstanceIdSchema.safeParse(input?.hostInstanceId);
  const canonicalOrigin = CanonicalOriginSchema.safeParse(input?.canonicalOrigin);
  const hostKeyFingerprint = HostKeyFingerprintSchema.safeParse(input?.hostKeyFingerprint);
  if (
    !deploymentId.success ||
    !hostInstanceId.success ||
    !canonicalOrigin.success ||
    !hostKeyFingerprint.success
  ) {
    throw invalidAccountAdoptionProof();
  }
  return {
    canonicalOrigin: canonicalOrigin.data,
    deploymentId: deploymentId.data,
    hostInstanceId: hostInstanceId.data,
    hostKeyFingerprint: hostKeyFingerprint.data,
  };
}

function parseVerifiedAccountAdoptionGrant(
  input: VerifiedAccountAdoptionGrant,
): VerifiedAccountAdoptionGrant {
  const proofId = parseAccountAdoptionProofId(input?.proofId);
  const account = parseAccountAdoptionAccount(input?.account);
  const deployment = parseAccountAdoptionAuthority(input?.deployment);
  const userId = UserIdSchema.safeParse(input?.authorizedBy?.userId);
  const sessionId = AuthSessionIdSchema.safeParse(input?.authorizedBy?.sessionId);
  const consumedAt = input?.consumedAt instanceof Date ? input.consumedAt : null;
  const issuedAt = input?.issuedAt instanceof Date ? input.issuedAt : null;
  const expiresAt = input?.expiresAt instanceof Date ? input.expiresAt : null;
  const grantId =
    typeof input?.grantId === "string" &&
    /^hag_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.grantId,
    )
      ? input.grantId
      : null;
  if (
    !userId.success ||
    !sessionId.success ||
    !consumedAt ||
    !Number.isFinite(consumedAt.getTime()) ||
    !issuedAt ||
    !Number.isFinite(issuedAt.getTime()) ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= issuedAt ||
    expiresAt <= new Date() ||
    !grantId
  ) {
    throw invalidAccountAdoptionGrant();
  }
  return {
    account,
    authorizedBy: { sessionId: sessionId.data, userId: userId.data },
    consumedAt,
    deployment,
    expiresAt,
    grantId,
    issuedAt,
    proofId,
  };
}

function accountAdoptionAuthorityFromRow(input: {
  readonly canonicalOrigin: string;
  readonly deploymentId: string;
  readonly hostInstanceId: string;
  readonly hostKeyFingerprint: string;
}): AccountAdoptionAuthority {
  return parseAccountAdoptionAuthority({
    canonicalOrigin: input.canonicalOrigin,
    deploymentId: DeploymentIdSchema.parse(input.deploymentId),
    hostInstanceId: HostInstanceIdSchema.parse(input.hostInstanceId),
    hostKeyFingerprint: HostKeyFingerprintSchema.parse(input.hostKeyFingerprint),
  });
}

async function activeDeploymentAuthority(
  transaction: Transaction<DatabaseSchema>,
  lock: boolean,
  hostKeyFingerprint: ReturnType<typeof HostKeyFingerprintSchema.parse>,
): Promise<AccountAdoptionAuthority> {
  let query = transaction
    .selectFrom("deployments")
    .select(["activeHostInstanceId", "canonicalOrigin", "id", "lifecycle"])
    .where("singletonKey", "=", "primary");
  if (lock) query = query.forNoKeyUpdate();
  const deployment = await query.executeTakeFirst();
  if (!deployment || deployment.lifecycle !== "active") {
    throw new OpensteerError({
      code: "conflict",
      message: "Deployment authority is not active",
    });
  }
  return accountAdoptionAuthorityFromRow({
    canonicalOrigin: deployment.canonicalOrigin,
    deploymentId: deployment.id,
    hostInstanceId: deployment.activeHostInstanceId,
    hostKeyFingerprint,
  });
}

async function requireLiveAdministratorSession(
  transaction: Transaction<DatabaseSchema>,
  session: {
    readonly id: AuthSessionId;
    readonly user: { readonly id: UserId; readonly instanceRole: string };
  },
  now: Date,
): Promise<void> {
  await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "=", session.user.id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  const row = await transaction
    .selectFrom("authSessions")
    .innerJoin("users", "users.id", "authSessions.userId")
    .select([
      "authSessions.absoluteExpiresAt",
      "authSessions.expiresAt",
      "users.disabledAt",
      "users.instanceRole",
    ])
    .where("authSessions.id", "=", session.id)
    .where("authSessions.userId", "=", session.user.id)
    .forNoKeyUpdate("authSessions")
    .executeTakeFirst();
  if (
    session.user.instanceRole !== "administrator" ||
    !row ||
    row.instanceRole !== "administrator" ||
    row.disabledAt ||
    row.expiresAt <= now ||
    row.absoluteExpiresAt <= now
  ) {
    throw new OpensteerError({
      code: "unauthorized",
      message: "Administrator session is no longer live",
    });
  }
}

function requireAdministrator(session: AuthenticatedSession): void {
  if (session.user.instanceRole !== "administrator") {
    throw new OpensteerError({ code: "forbidden", message: "Administrator access required" });
  }
}

function sameAccountAdoptionAuthority(
  left: AccountAdoptionAuthority,
  right: AccountAdoptionAuthority,
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.hostInstanceId === right.hostInstanceId &&
    left.hostKeyFingerprint === right.hostKeyFingerprint &&
    left.canonicalOrigin === right.canonicalOrigin
  );
}

function requiredHostKeyFingerprint(
  value: ReturnType<typeof HostKeyFingerprintSchema.parse> | undefined,
): ReturnType<typeof HostKeyFingerprintSchema.parse> {
  const parsed = HostKeyFingerprintSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpensteerError({
      code: "not_found",
      message: "Account attachment is unavailable without a pinned Host key",
    });
  }
  return parsed.data;
}

function invalidAccountAdoptionProof(): OpensteerError {
  return new OpensteerError({
    code: "unauthorized",
    message: "Account attachment proof is invalid or expired",
  });
}

function invalidOperatorRecoveryLink(): OpensteerError {
  return new OpensteerError({
    code: "unauthorized",
    message: "This password recovery link is invalid, expired, or already used",
  });
}

function invalidAccountAdoptionGrant(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "Account attachment grant does not match this Deployment",
  });
}

async function authenticateFromResponseCookie(
  service: IdentityService,
  requestHeaders: Headers,
  responseHeaders: Headers,
): Promise<AuthenticatedSession> {
  const headers = headersWithResponseCookies(requestHeaders, responseHeaders);
  const session = await service.authenticate(headers);
  if (!session) {
    throw new OpensteerError({ code: "internal", message: "Session was not created" });
  }
  return session;
}

function headersWithResponseCookies(requestHeaders: Headers, responseHeaders: Headers): Headers {
  const headers = new Headers(requestHeaders);
  const jar = parseCookieHeader(requestHeaders.get("cookie"));
  for (const setCookie of responseHeaders.getSetCookie()) {
    const pair = decodeCookiePair(setCookie.split(";", 1)[0] ?? "");
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!name) continue;
    if (!value) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
  const serialized = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  if (serialized) {
    headers.set("cookie", serialized);
  } else {
    headers.delete("cookie");
  }
  return headers;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (name) jar.set(name, value);
  }
  return jar;
}

function decodeCookiePair(pair: string): string | null {
  const separator = pair.indexOf("=");
  if (separator === -1) return pair || null;
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  if (!name) return null;
  try {
    return `${name}=${decodeURIComponent(value)}`;
  } catch {
    return pair;
  }
}

async function oauthRedirectUrl(response: Response, publicOrigin: URL): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "internal",
      message: "Native sign-in did not return to the application",
    });
  }
  const url =
    typeof body === "object" && body !== null && "url" in body
      ? (body as { readonly url?: unknown }).url
      : undefined;
  if (typeof url !== "string") {
    throw new OpensteerError({
      code: "internal",
      message: "Native sign-in did not return to the application",
    });
  }
  const redirect = new URL(url, publicOrigin);
  if (redirect.origin !== publicOrigin.origin) {
    throw new OpensteerError({
      code: "internal",
      message: "Native sign-in did not return to the application",
    });
  }
  return redirect.toString();
}

/** The session one native token family hangs from. */
interface NativeTokenAnchor {
  readonly sessionId: AuthSessionId;
  readonly userId: UserId;
}

/**
 * How the authorization server stores a token under the `storeTokens: "hashed"`
 * configuration above: unpadded base64url of its SHA-256. The plugin owns that
 * format and the revocation integration test is what proves this still matches
 * it — a revocation that found no row would end no session and say nothing.
 */
function storedNativeTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function nativeOAuthError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function forceInteractiveConsent(url: URL): void {
  const prompts = new Set(
    (url.searchParams.get("prompt") ?? "")
      .split(/\s+/u)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  prompts.delete("none");
  prompts.add("consent");
  url.searchParams.set("prompt", [...prompts].join(" "));
}

function publicNativeOAuthMetadata(
  metadata: (request: Request) => Promise<Response>,
  publicOrigin: URL,
): (request: Request) => Promise<Response> {
  const internalPrefix = `${publicOrigin.origin}${internalAuthPath}`;
  const publicPrefix = `${publicOrigin.origin}${publicNativeAuthPath}`;
  return async (request) => {
    const response = await metadata(request);
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Native OAuth metadata is invalid");
    }
    const body = { ...(parsed as Record<string, unknown>) };
    for (const key of [
      "authorization_endpoint",
      "end_session_endpoint",
      "introspection_endpoint",
      "jwks_uri",
      "registration_endpoint",
      "revocation_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
    ]) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.startsWith(`${internalPrefix}/`)) {
        throw new Error(`Native OAuth metadata contains an unexpected ${key}`);
      }
      body[key] = `${publicPrefix}${value.slice(internalPrefix.length)}`;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

async function assertSuccessfulBetterAuthResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 429) {
    throw new OpensteerError({
      code: "timeout",
      message: "Too many attempts; try again shortly",
      retryable: true,
    });
  }
  let message = "Authentication request failed";
  try {
    const body = (await response.clone().json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length <= 240) message = body.message;
  } catch {
    // The public error intentionally stays bounded and token-free.
  }
  throw new OpensteerError({
    code:
      response.status === 401
        ? "unauthorized"
        : response.status === 403
          ? "forbidden"
          : "bad_request",
    message,
  });
}

function forwardedAuthHeaders(headers: Headers, json = false): Headers {
  const forwarded = new Headers();
  for (const name of ["cookie", "origin", "referer", "user-agent", "x-forwarded-for"]) {
    const value = headers.get(name);
    if (value) forwarded.set(name, value);
  }
  if (json) forwarded.set("content-type", "application/json");
  return forwarded;
}

function admissionCookie(value: string, origin: URL, lifetimeMilliseconds: number): string {
  const secure = origin.protocol === "https:";
  return `${admissionCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    lifetimeMilliseconds / 1_000,
  )}${secure ? "; Secure" : ""}`;
}

function clearAdmissionCookie(origin: URL): Headers {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `${admissionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
      origin.protocol === "https:" ? "; Secure" : ""
    }`,
  );
  return headers;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * Reads what a managed native registration durably remembers about itself.
 *
 * A row written before this Host distinguished applications carries no
 * binding, and there was exactly one native client then: the desktop. Seeding
 * it that way is the migration, which is why it happens here at reconciliation
 * and never where a token is authenticated.
 */
function nativeOAuthRegistration(metadata: unknown): NativeOAuthRegistrationMetadata {
  const parsed = NativeOAuthRegistrationMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : { application: "desktop" };
}

/**
 * Drops authorization codes a client has outstanding. A code was issued
 * against the callback set the client had at the time, so once that set
 * changes — or the registration is retired — redeeming it would complete a
 * flow nobody would authorize again.
 */
async function invalidateNativeAuthorizations(
  transaction: Transaction<DatabaseSchema>,
  clientId: string,
  now: Date,
): Promise<void> {
  const pending = await transaction
    .selectFrom("authVerifications")
    .select(["id", "value"])
    .where("expiresAt", ">", now)
    .where("value", "like", `%${pendingNativeAuthorizationMarker}%`)
    .execute();
  const stale = pending
    .filter((candidate) => {
      let value: unknown;
      try {
        value = JSON.parse(candidate.value);
      } catch {
        return false;
      }
      const parsed = PendingNativeAuthorizationSchema.safeParse(value);
      return parsed.success && parsed.data.query.client_id === clientId;
    })
    .map((candidate) => candidate.id);
  if (stale.length === 0) return;
  await transaction.deleteFrom("authVerifications").where("id", "in", stale).execute();
}

async function sqlAdvisoryLock(
  transaction: Transaction<DatabaseSchema>,
  key: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
}

function sqlJson<T>(value: T) {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}
