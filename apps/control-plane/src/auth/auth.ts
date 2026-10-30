import { oauthProvider } from "@better-auth/oauth-provider";
import {
  ControlPlaneAccountIdSchema,
  controlPlaneOAuthScopes,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  NativeOAuthRegistrationMetadataSchema,
  normalizeIdentityEmail,
  type NativeOAuthApplication,
} from "@opensteer/core";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { JWTPayload } from "jose";
import type { Kysely } from "kysely";
import { ControlPlaneError } from "../server/errors.js";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { isOfficialNativeReference } from "../database/store.js";

export const controlPlaneAuthPath = "/api/auth";
/**
 * Freshness window for the one route that still requires a recent Account
 * authentication: full Account deletion, the single unrecoverable
 * identity-destroying mutation. Every other Account mutation authenticates
 * without a freshness requirement.
 */
export const freshAccountSessionMilliseconds = 15 * 60 * 1_000;
const maximumAuthenticationClockSkewMilliseconds = 60 * 1_000;

interface ControlPlaneAuthConfig {
  readonly authSecret: string;
  readonly publicOrigin: URL;
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
}

// Better Auth prefixes this configured name with __Secure- on HTTPS. Keep the
// configured name stable so existing browser sessions remain readable.
function accountSessionCookieName(publicOrigin: URL): string {
  return publicOrigin.protocol === "https:" ? "__Host-opensteer.account" : "opensteer.account";
}

export function createControlPlaneAuth(
  database: Kysely<ControlPlaneDatabaseSchema>,
  config: ControlPlaneAuthConfig,
) {
  if (Boolean(config.googleClientId) !== Boolean(config.googleClientSecret)) {
    throw new Error("Google Account authentication requires both OAuth credentials");
  }
  const secure = config.publicOrigin.protocol === "https:";
  const databaseOption = {
    db: database,
    transaction: true,
    type: "postgres",
  } as unknown as BetterAuthOptions["database"];
  return betterAuth({
    account: {
      // Account records can predate their first Google sign-in, so the trusted
      // provider must link its verified email to the existing record.
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: true,
        trustedProviders: ["google"],
      },
      encryptOAuthTokens: true,
      modelName: "authAccounts",
      storeAccountCookie: false,
    },
    advanced: {
      cookies: {
        session_token: {
          attributes: { httpOnly: true, path: "/", sameSite: "lax", secure },
          name: accountSessionCookieName(config.publicOrigin),
        },
      },
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, path: "/", sameSite: "lax", secure },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      database: {
        generateId: ({ model }) => {
          if (model === "user") return `acct_${crypto.randomUUID()}`;
          if (model === "session") return internalAuthId("acs");
          if (model === "account") return internalAuthId("aca");
          if (model === "verification") return internalAuthId("acv");
          if (model === "jwks") return internalAuthId("jwk");
          if (model === "oauthClient") return internalAuthId("oac");
          if (model === "oauthRefreshToken") return internalAuthId("ort");
          if (model === "oauthAccessToken") return internalAuthId("oat");
          if (model === "oauthConsent") return internalAuthId("ocn");
          return internalAuthId("bat");
        },
      },
      useSecureCookies: secure,
    },
    appName: "Opensteer",
    basePath: controlPlaneAuthPath,
    baseURL: config.publicOrigin.origin,
    database: databaseOption,
    databaseHooks: {
      session: {
        delete: {
          before: async (session) => {
            // The provider preserves offline_access tokens on logout; Account sign-out
            // revokes all credentials issued to this session.
            await database
              .deleteFrom("oauthAccessTokens")
              .where("sessionId", "=", session.id)
              .execute();
            await database
              .deleteFrom("oauthRefreshToken")
              .where("sessionId", "=", session.id)
              .execute();
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const email = normalizeIdentityEmail(user.email);
            return {
              data: {
                ...user,
                email,
                name: normalizedAccountDisplayName(user.name, email),
              },
            };
          },
        },
      },
    },
    disabledPaths: [
      "/change-email",
      "/change-password",
      "/delete-user",
      "/link-social",
      "/reset-password",
      "/request-password-reset",
      "/set-password",
      "/sign-in/email",
      "/sign-up/email",
      "/unlink-account",
    ],
    emailAndPassword: { enabled: false },
    plugins: [
      // The provider uses the JWT issuer; pin it across both public hostnames.
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          audience: config.publicOrigin.origin,
          issuer: config.publicOrigin.origin,
        },
        jwks: {
          gracePeriod: 30 * 24 * 60 * 60,
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          rotationInterval: 90 * 24 * 60 * 60,
        },
        schema: { jwks: { modelName: "authJwks" } },
      }),
      oauthProvider({
        accessTokenExpiresIn: 5 * 60,
        allowDynamicClientRegistration: false,
        allowPublicClientPrelogin: false,
        allowUnauthenticatedClientRegistration: false,
        codeExpiresIn: 5 * 60,
        consentPage: "/consent",
        clientPrivileges: async () => false,
        grantTypes: ["authorization_code", "refresh_token"],
        idTokenExpiresIn: 10 * 60,
        loginPage: "/sign-in",
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        schema: {
          oauthAccessToken: { modelName: "oauthAccessTokens" },
          oauthClient: {
            fields: { requirePKCE: "requirePkce" },
            modelName: "oauthClients",
          },
          oauthConsent: { modelName: "oauthConsents" },
        },
        scopes: [...controlPlaneOAuthScopes],
        storeClientSecret: "hashed",
        storeTokens: "hashed",
        resources: [config.publicOrigin.origin],
        // Existing clients have no resource links, and all use the Account API.
        enforcePerClientResources: false,
        customIdTokenClaims: ({ user, scopes }) => {
          const name = user.name.split(" ").filter(Boolean);
          return {
            ...(scopes.includes("email")
              ? { email: user.email, email_verified: user.emailVerified }
              : {}),
            ...(scopes.includes("profile")
              ? {
                  name: user.name,
                  picture: user.image ?? undefined,
                  given_name: name.length > 1 ? name.slice(0, -1).join(" ") : undefined,
                  family_name: name.length > 1 ? name.at(-1) : undefined,
                }
              : {}),
          };
        },
      }),
    ],
    rateLimit: {
      customRules: {
        "/callback/google": { max: 30, window: 60 },
        "/oauth2/authorize": { max: 60, window: 60 },
        "/oauth2/token": { max: 30, window: 60 },
        "/sign-in/social": { max: 30, window: 60 },
      },
      enabled: true,
      max: 300,
      modelName: "authRateLimits",
      storage: "database",
      window: 60,
    },
    secret: config.authSecret,
    session: {
      cookieCache: { enabled: false },
      expiresIn: 30 * 24 * 60 * 60,
      freshAge: freshAccountSessionMilliseconds / 1_000,
      modelName: "authSessions",
      updateAge: 24 * 60 * 60,
    },
    socialProviders:
      config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
              // Account selection preserves explicit interaction;
              // the Opensteer authorization server remains the freshness
              // authority for prompt=login.
              prompt: "select_account",
            },
          }
        : {},
    trustedOrigins: [config.publicOrigin.origin],
    user: {
      deleteUser: { enabled: false },
      fields: { name: "displayName" },
      modelName: "users",
    },
    verification: { modelName: "authVerifications" },
  });
}

export type ControlPlaneAuth = ReturnType<typeof createControlPlaneAuth>;

interface AccountPrincipal {
  readonly accountId: ControlPlaneAccountId;
  /**
   * Which signed Opensteer application this credential belongs to, read from
   * the registration rather than from the token, and `null` for a browser
   * session or the portal's own client. Routes that exist for one application
   * — push registration is the phone's alone — check it.
   */
  readonly application: NativeOAuthApplication | null;
  readonly kind: "bearer" | "session";
}

export class ControlPlaneAuthenticator {
  readonly #auth: ControlPlaneAuth;
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #issuer: string;

  constructor(
    auth: ControlPlaneAuth,
    database: Kysely<ControlPlaneDatabaseSchema>,
    publicOrigin: URL,
  ) {
    this.#auth = auth;
    this.#database = database;
    this.#issuer = publicOrigin.origin;
  }

  async authenticate(
    headers: Headers,
    options: {
      /** Only `DELETE /v1/account` requires a recent Account authentication. */
      readonly fresh?: boolean;
      readonly mutation?: boolean;
      readonly scope?: string;
    } = {},
  ): Promise<AccountPrincipal> {
    const authorization = headers.get("authorization");
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      if (token.startsWith("osc_") || token.startsWith("ost_")) {
        throw new ControlPlaneError("unauthorized", "An account token is required");
      }
      let payload: JWTPayload;
      try {
        const verified = await this.#auth.api.verifyJWT({
          body: { issuer: this.#issuer, token },
        });
        if (!verified.payload) throw new Error("JWT verification failed");
        payload = verified.payload;
      } catch (error) {
        throw new ControlPlaneError("unauthorized", "Account token is invalid", { cause: error });
      }
      const grantedScopes =
        typeof payload.scope === "string" ? new Set(payload.scope.split(" ")) : new Set<string>();
      if (options.scope && !grantedScopes.has(options.scope)) {
        throw new ControlPlaneError("forbidden", "Account token scope is insufficient");
      }
      const subject = ControlPlaneAccountIdSchema.safeParse(payload.sub);
      if (!subject.success) {
        throw new ControlPlaneError("unauthorized", "Account token subject is invalid");
      }
      if (typeof payload.sid !== "string") {
        throw new ControlPlaneError("unauthorized", "Account token session is invalid");
      }
      const session = await this.#database
        .selectFrom("authSessions")
        .select("expiresAt")
        .where("id", "=", payload.sid)
        .where("userId", "=", subject.data)
        .where("expiresAt", ">", new Date())
        .executeTakeFirst();
      if (!session) {
        throw new ControlPlaneError("unauthorized", "Account token session is invalid");
      }
      // A bearer credential is only as live as the registration that issued it.
      // A native application that left the Account's allowlist is disabled by
      // reconciliation, but its JWT carries no database row to delete, so
      // without this its tokens keep working for their full lifetime. The gate
      // speaks only for the managed native registrations: browser sessions and
      // the portal's own client reach this route unchanged.
      const issuedAt =
        typeof payload.iat === "number" && Number.isSafeInteger(payload.iat) ? payload.iat : null;
      const bearerClientId = typeof payload.azp === "string" ? payload.azp : null;
      const registration = bearerClientId
        ? await this.#database
            .selectFrom("oauthClients")
            .select(["disabled", "metadata", "referenceId"])
            .where("clientId", "=", bearerClientId)
            .executeTakeFirst()
        : undefined;
      let application: NativeOAuthApplication | null = null;
      if (registration && isOfficialNativeReference(registration.referenceId)) {
        const durable = NativeOAuthRegistrationMetadataSchema.safeParse(registration.metadata);
        const notBefore = durable.success ? durable.data.credentialsNotBefore : undefined;
        application = durable.success ? durable.data.application : null;
        if (
          registration.disabled ||
          issuedAt === null ||
          // `iat` is second-granular, so a token minted in the same second as
          // the retirement cannot be placed on either side of the line. It is
          // refused rather than honoured.
          (notBefore !== undefined && issuedAt <= Math.floor(new Date(notBefore).getTime() / 1_000))
        ) {
          throw new ControlPlaneError(
            "unauthorized",
            "Account token client is no longer registered",
          );
        }
      }
      if (options.fresh) {
        const clientId = typeof payload.azp === "string" ? payload.azp : null;
        const authentication = clientId
          ? await this.#database
              .selectFrom("oauthRefreshToken")
              .select("authTime")
              .where("clientId", "=", clientId)
              .where("sessionId", "=", payload.sid)
              .where("userId", "=", subject.data)
              .where("revoked", "is", null)
              .where("expiresAt", ">", new Date())
              .orderBy("createdAt", "desc")
              .executeTakeFirst()
          : undefined;
        if (!isRecentAccountAuthentication(authentication?.authTime)) {
          throw new ControlPlaneError(
            "recent_sign_in_required",
            "Recent Opensteer Account sign-in is required",
          );
        }
      }
      return { accountId: subject.data, application, kind: "bearer" };
    }

    if (options.mutation && headers.get("origin") !== this.#issuer) {
      throw new ControlPlaneError("forbidden", "Request origin is not allowed");
    }
    const session = await this.#auth.api.getSession({ headers });
    if (!session) throw new ControlPlaneError("unauthorized", "Sign in is required");
    if (options.fresh) {
      const createdAt = new Date(session.session.createdAt);
      if (!isRecentAccountAuthentication(createdAt)) {
        throw new ControlPlaneError(
          "recent_sign_in_required",
          "Recent Opensteer Account sign-in is required",
        );
      }
    }
    return {
      accountId: ControlPlaneAccountIdSchema.parse(session.user.id),
      application: null,
      kind: "session",
    };
  }
}

export function isRecentAccountAuthentication(value: Date | null | undefined, now = Date.now()) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return false;
  const authenticationTime = value.getTime();
  return (
    authenticationTime <= now + maximumAuthenticationClockSkewMilliseconds &&
    authenticationTime >= now - freshAccountSessionMilliseconds
  );
}

function internalAuthId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizedAccountDisplayName(value: string, normalizedEmail: string): string {
  const normalized = value.normalize("NFKC").trim();
  const bounded = [...normalized].slice(0, 120).join("");
  return bounded || normalizedEmail.slice(0, 120);
}
