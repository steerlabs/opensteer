import { z } from "zod";
import {
  AuthSessionIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkspaceInvitationIdSchema,
  WorkspaceMembershipIdSchema,
} from "./ids.js";

export const IdentityEmailSchema = z.email().trim().min(3).max(320);
export type IdentityEmail = z.infer<typeof IdentityEmailSchema>;

// Length is the only rule. Composition requirements push people toward
// predictable substitutions without adding real entropy, so Opensteer does not
// impose them.
export const identityPasswordMinLength = 8;
export const identityPasswordMaxLength = 128;
export const IdentityPasswordSchema = z
  .string()
  .min(identityPasswordMinLength)
  .max(identityPasswordMaxLength);

// The operator-issued recovery capability: an "olpr_" prefix and the 43
// URL-safe characters a 32-byte random draw encodes to. It lives here because
// both the identity service that mints it and the wire contract that carries it
// must agree on the shape, and drifting copies would reject valid links.
export const LocalPasswordRecoveryTokenSchema = z.string().regex(/^olpr_[A-Za-z0-9_-]{43}$/u);

export function normalizeIdentityEmail(value: string): IdentityEmail {
  return IdentityEmailSchema.parse(value.normalize("NFKC").trim().toLowerCase());
}

export const InstanceRoleSchema = z.enum(["administrator", "user"]);

export const WorkspaceMembershipRoleSchema = z.enum(["owner", "collaborator"]);

export const WorkspaceMembershipStateSchema = z.enum(["active", "revoked"]);

export const WorkspaceMembershipSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  id: WorkspaceMembershipIdSchema,
  invitedBy: UserIdSchema.nullable(),
  joinedAt: z.iso.datetime({ offset: true }),
  role: WorkspaceMembershipRoleSchema,
  state: WorkspaceMembershipStateSchema,
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
});

export const WorkspaceInvitationTypeSchema = z.enum(["email", "link"]);

export const WorkspaceInvitationSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }).nullable(),
  acceptedBy: UserIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: UserIdSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  id: WorkspaceInvitationIdSchema,
  intendedEmail: IdentityEmailSchema.nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  role: WorkspaceMembershipRoleSchema,
  selector: z.string().regex(/^[A-Za-z0-9_-]{24,96}$/),
  type: WorkspaceInvitationTypeSchema,
  workspaceId: WorkspaceIdSchema,
});

export const InvitationPreviewSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }),
  invitationType: WorkspaceInvitationTypeSchema,
  inviterName: z.string().trim().min(1).max(120),
  requiresVerifiedEmail: z.boolean(),
  role: WorkspaceMembershipRoleSchema,
  workspaceName: z.string().trim().min(1).max(160),
});
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

/** The shape of the device behind a session, for the picture a person recognises it by. */
export const SessionDeviceFormSchema = z.enum(["computer", "mobile"]);
export type SessionDeviceForm = z.infer<typeof SessionDeviceFormSchema>;

export const AuthSessionSummarySchema = z.strictObject({
  absoluteExpiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  current: z.boolean(),
  /** A readable name such as "Chrome on Mac", never the raw user agent. */
  deviceLabel: z.string().trim().min(1).max(120),
  expiresAt: z.iso.datetime({ offset: true }),
  /** Null when the device could not be told apart; older Hosts send nothing. */
  form: SessionDeviceFormSchema.nullable().default(null),
  id: AuthSessionIdSchema,
  lastSeenAt: z.iso.datetime({ offset: true }),
  /**
   * Opened by the Opensteer app on the computer this Deployment runs on. That
   * computer always has access, so clients show it once, as that computer,
   * rather than as one session per launch.
   */
  machineLocal: z.boolean().default(false),
});
export type AuthSessionSummary = z.infer<typeof AuthSessionSummarySchema>;

export const IdentityProviderSummarySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  type: z.literal("oidc"),
});

export const HostExposureSchema = z.enum(["loopback", "networked"]);
export type HostExposure = z.infer<typeof HostExposureSchema>;

export const DeploymentDisplayKindSchema = z.enum(["development", "personal", "self-hosted"]);
export type DeploymentDisplayKind = z.infer<typeof DeploymentDisplayKindSchema>;

/**
 * How this Deployment presents itself at its Door — the pre-auth access screen
 * every deployment web origin renders. The kind is derived from the Host's
 * deployment facts at the display edge. The name is the place's display name:
 * the Desktop manifest name for a Personal Host, an operator-configured name
 * for a self-hosted server, and null when nobody has named it yet.
 */
export const DeploymentPresentationSchema = z.strictObject({
  /**
   * Opensteer Cloud runs this Deployment. It is a server like any other to
   * every rule; only what people are told about where it lives differs.
   */
  cloud: z.boolean(),
  kind: DeploymentDisplayKindSchema,
  name: z.string().trim().min(1).max(120).nullable(),
});
export type DeploymentPresentation = z.infer<typeof DeploymentPresentationSchema>;

export const IdentityConfigSchema = z.strictObject({
  deployment: DeploymentPresentationSchema,
  emailDeliveryAvailable: z.boolean(),
  localPasswordEnabled: z.boolean(),
  /**
   * Whether this Deployment's only identity is the implicit local machine
   * owner — the seeded owner of a Personal Host with no way to sign in as
   * anybody else. There is no person to name, so clients render no email, no
   * display name, and no avatar: showing the placeholder the seeding uses
   * would be a lie about who is signed in.
   */
  machineOwner: z.boolean(),
  oidcProviders: z.array(IdentityProviderSummarySchema).max(16),
  passkeysEnabled: z.boolean(),
  exposure: HostExposureSchema,
  /** Apex portal this Deployment belongs to, or null when it is self-hosted. */
  portalOrigin: z.url().nullable(),
  publicOrigin: z.url(),
  setupState: z.enum(["complete", "required"]),
  signupPolicy: z.enum(["closed", "invite-only", "open"]),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

export const AuthenticatedUserSchema = z.strictObject({
  disabledAt: z.iso.datetime({ offset: true }).nullable(),
  displayName: z.string().trim().min(1).max(120),
  email: IdentityEmailSchema,
  emailVerified: z.boolean(),
  id: UserIdSchema,
  image: z.url().nullable(),
  instanceRole: InstanceRoleSchema,
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

/**
 * How a Personal remote session's credential is presented. A browser and an
 * Electron partition own a cookie jar the Host can write to; a native client
 * owns none, so its credential travels in the exchange body and comes back in
 * an Authorization header.
 *
 * It lives here because the identity service that mints the credential, the
 * durable session row that fences it, and the wire contract that carries it
 * must all agree, and a credential minted for one family must never
 * authenticate in the other.
 */
export const PersonalRemoteSessionDeliverySchema = z.enum(["cookie", "header"]);
export type PersonalRemoteSessionDelivery = z.infer<typeof PersonalRemoteSessionDeliverySchema>;

/**
 * The opaque header-delivered Personal remote session credential: the Host
 * session token and the Host's HMAC over it, exactly the pair the cookie arm
 * carries. Pinning the shape keeps a truncated or re-encoded copy from
 * reaching the signature check at all.
 */
export const PersonalRemoteSessionCredentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9+/]{43}=$/u);
export type PersonalRemoteSessionCredential = z.infer<typeof PersonalRemoteSessionCredentialSchema>;

/**
 * The authorization scheme a header-delivered Personal remote session is
 * presented under. It is deliberately not `Bearer`: that scheme belongs to the
 * Host's own OAuth server, and one parser must never admit a credential of the
 * other family.
 */
export const personalRemoteAuthorizationScheme = "PersonalRemote" as const;

export const AuthenticatedSessionSchema = z.strictObject({
  absoluteExpiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  id: AuthSessionIdSchema,
  user: AuthenticatedUserSchema,
});
export type AuthenticatedSession = z.infer<typeof AuthenticatedSessionSchema>;

/**
 * The same session as a client reads it. The strict model above is what this
 * tree persists and parses as input; every contract that hands a session to an
 * independently updated client — the rpc group and the session exchange —
 * projects it through this instead, so a field added by a newer Host does not
 * stop an installed app.
 */
export const AuthenticatedSessionViewSchema = z.object({
  ...AuthenticatedSessionSchema.shape,
  user: z.object(AuthenticatedUserSchema.shape),
});

/** Fingerprint of the Deployment Host's Ed25519 signing key. */
export const HostKeyFingerprintSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u);
export type HostKeyFingerprint = z.infer<typeof HostKeyFingerprintSchema>;

/** One signed Opensteer build with its public OAuth identity. */
export interface OpensteerNativeClient {
  readonly accountCallback: string;
  readonly accountDisplayName: string;
  readonly accountSoftwareId: string;
  readonly application: "desktop" | "mobile";
  readonly applicationId: string;
  readonly clientId: string;
  readonly hostCallback: string;
  readonly hostDisplayName: string;
  readonly hostSoftwareId: string;
  /** Product name pinned by the signed desktop release manifest. */
  readonly name: string;
}

function nativeClient(input: {
  readonly accountDisplayName: string;
  readonly accountSoftwareId: string;
  readonly application: OpensteerNativeClient["application"];
  readonly applicationId: string;
  readonly clientId: string;
  readonly hostDisplayName: string;
  readonly hostSoftwareId: string;
  readonly name: string;
}): OpensteerNativeClient {
  return {
    ...input,
    accountCallback: `${input.applicationId}:/oauth/account-callback`,
    hostCallback: `${input.applicationId}:/oauth/host-callback`,
  };
}

/**
 * The closed set of signed first-party native builds.
 *
 * This is a product constant rather than deployment configuration. Every
 * Account and every Host registers the complete set, so installing a new Host
 * never retires credentials held by another supported release channel.
 */
export const opensteerNativeClients = [
  nativeClient({
    accountDisplayName: "Opensteer",
    accountSoftwareId: "opensteer-native",
    application: "desktop",
    applicationId: "com.opensteer.opensteer",
    clientId: "opensteer-desktop",
    hostDisplayName: "Opensteer Desktop",
    hostSoftwareId: "opensteer-desktop",
    name: "Opensteer",
  }),
  nativeClient({
    // Beta Accounts historically used the same consent-screen presentation as
    // stable while client ID and callback kept the credentials independent.
    accountDisplayName: "Opensteer",
    accountSoftwareId: "opensteer-native",
    application: "desktop",
    applicationId: "com.steerlabs.opensteer.beta",
    clientId: "opensteer-desktop-beta",
    hostDisplayName: "Opensteer Beta",
    hostSoftwareId: "opensteer-desktop-beta",
    name: "Opensteer Beta",
  }),
  nativeClient({
    accountDisplayName: "Opensteer Mobile",
    accountSoftwareId: "opensteer-native-mobile",
    application: "mobile",
    applicationId: "com.opensteer.mobile",
    clientId: "opensteer-mobile",
    hostDisplayName: "Opensteer Mobile",
    hostSoftwareId: "opensteer-mobile",
    name: "Opensteer Mobile",
  }),
] as const satisfies readonly [OpensteerNativeClient, ...OpensteerNativeClient[]];

export const opensteerDesktopClient = opensteerNativeClients[0];
export const opensteerBetaDesktopClient = opensteerNativeClients[1];
export const opensteerMobileClient = opensteerNativeClients[2];

export const opensteerDesktopOAuthClientId = opensteerDesktopClient.clientId;
export const opensteerDesktopApplicationId = opensteerDesktopClient.applicationId;
export const opensteerDesktopAccountOAuthCallback = opensteerDesktopClient.accountCallback;
export const opensteerDesktopHostOAuthCallback = opensteerDesktopClient.hostCallback;
export const opensteerMobileOAuthClientId = opensteerMobileClient.clientId;
export const opensteerMobileApplicationId = opensteerMobileClient.applicationId;
export const opensteerMobileAccountOAuthCallback = opensteerMobileClient.accountCallback;
export const opensteerMobileHostOAuthCallback = opensteerMobileClient.hostCallback;

/**
 * What a native Opensteer client asks each authorization server for. The sets
 * are application-neutral: a Host registers the same scopes for every native
 * client it admits, and the Account the same for every application holding an
 * Account credential. Which application is asking is the registration's own
 * fact, so a phone and a desktop differ in identity and revocation, never in
 * what they may do once authorized.
 */
export const opensteerAccountOAuthScopes = [
  "openid",
  "email",
  "offline_access",
  "deployments:read",
  "deployments:write",
] as const;
/** Requested only for the fresh, explicit Account deletion authorization. */
export const opensteerAccountDeleteOAuthScopes = [
  ...opensteerAccountOAuthScopes,
  "account:delete",
] as const;
export const opensteerHostOAuthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "host:access",
] as const;

/** The Opensteer applications that may hold a native OAuth client registration. */
export const NativeOAuthApplicationSchema = z.enum(["desktop", "mobile"]);
export type NativeOAuthApplication = z.infer<typeof NativeOAuthApplicationSchema>;

/**
 * A reverse-domain scheme is the only thing a native Opensteer client may
 * claim: the operating system hands it to exactly one installed application,
 * and requiring at least one dot keeps a squattable generic name like
 * `opensteer:` — or an operable one like `javascript:` — out of the allowlist.
 */
const nativeOAuthRedirectScheme = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/u;

/** The one spelling a callback path may take: at least one unreserved segment. */
const nativeOAuthRedirectPath = /^(?:\/[A-Za-z0-9._~-]+)+$/u;

/** The scheme of a callback this schema has already accepted. */
export function nativeOAuthRedirectSchemeOf(redirectUri: string): string {
  return redirectUri.slice(0, redirectUri.indexOf(":"));
}

/**
 * A native client's callback: an RFC 8252 private-use URI in exactly the
 * `<reverse-dns-scheme>:/<path>` form, and nothing else.
 *
 * Every relaxation here is a hijack. `http:`/`https:` would hand a native
 * authorization code to a web origin, and any other non-private-use scheme —
 * `javascript:` above all — is not a callback at all. An authority
 * (`scheme://host/path`) gives the callback a component the operating system
 * does not arbitrate, so two registrations could differ only in a host nobody
 * owns. A query, fragment, port or credential, or any non-canonical spelling,
 * would let two strings name one callback and disagree about which
 * registration it belongs to.
 */
export const NativeOAuthRedirectUriSchema = z.string().superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  const separator = value.indexOf(":");
  if (separator <= 0 || !nativeOAuthRedirectScheme.test(value.slice(0, separator))) {
    reject("Expected a reverse-domain private-use redirect scheme");
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    reject("Expected an absolute native redirect URI");
    return;
  }
  if (
    url.host ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !nativeOAuthRedirectPath.test(url.pathname) ||
    `${url.protocol}${url.pathname}` !== value
  ) {
    reject("Expected a canonical private-use redirect URI of the form scheme:/path");
  }
});

export const NativeOAuthClientIdSchema = z.string().regex(/^[A-Za-z0-9._~-]{1,255}$/u);

export const NativeOAuthClientSchema = z.strictObject({
  application: NativeOAuthApplicationSchema,
  clientId: NativeOAuthClientIdSchema,
  displayName: z.string().trim().min(1).max(80),
  redirectUris: z.array(NativeOAuthRedirectUriSchema).min(1).max(16).readonly(),
  softwareId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
});
export type NativeOAuthClient = z.infer<typeof NativeOAuthClientSchema>;

/**
 * The allowlist an authorization server registers. One signed build holds one
 * registration, so Beta and stable desktop credentials remain independently
 * revocable even though both are desktop applications.
 *
 * The scheme, not the whole URI, is what an application owns: the operating
 * system routes `com.opensteer.mobile:` to one installed build and says
 * nothing about the path. Two registrations sharing a scheme would therefore
 * be two registrations one application can complete, so a code minted for the
 * desktop could be delivered to — and redeemed by — the phone.
 */
export const NativeOAuthClientSetSchema = z
  .array(NativeOAuthClientSchema)
  .min(1)
  .max(16)
  .superRefine((clients, context) => {
    const clientIds = new Set<string>();
    const schemes = new Map<string, string>();
    for (const client of clients) {
      if (clientIds.has(client.clientId)) {
        context.addIssue({
          code: "custom",
          message: `Native OAuth client ID ${client.clientId} is registered more than once`,
        });
      }
      clientIds.add(client.clientId);
      const clientSchemes = new Set(client.redirectUris.map(nativeOAuthRedirectSchemeOf));
      if (clientSchemes.size > 1) {
        context.addIssue({
          code: "custom",
          message: `Native OAuth client ${client.clientId} must use one application scheme`,
        });
      }
      if (new Set(client.redirectUris).size !== client.redirectUris.length) {
        context.addIssue({
          code: "custom",
          message: `Native OAuth client ${client.clientId} repeats a redirect URI`,
        });
      }
      for (const scheme of clientSchemes) {
        const owner = schemes.get(scheme);
        if (owner !== undefined && owner !== client.clientId) {
          context.addIssue({
            code: "custom",
            message: `Native OAuth redirect scheme ${scheme}: is claimed by more than one client`,
          });
        }
        schemes.set(scheme, client.clientId);
      }
    }
  });

/**
 * What a managed native registration remembers beyond the fields the OAuth
 * provider owns, kept in the registration row's metadata.
 *
 * `application` is a binding, not a label: it is fixed when the registration
 * is created and is where an authenticated token's application is read from,
 * so editing configuration can never relabel credentials an application
 * already holds. `credentialsNotBefore` is the durable revocation line — a JWT
 * access token has no row of its own to delete, so retiring a registration
 * records the instant after which the tokens it issued stop being honoured,
 * and re-registering the same client ID inherits that line.
 */
export const NativeOAuthRegistrationMetadataSchema = z.looseObject({
  application: NativeOAuthApplicationSchema,
  credentialsNotBefore: z.iso.datetime({ offset: true }).optional(),
});
export type NativeOAuthRegistrationMetadata = z.infer<typeof NativeOAuthRegistrationMetadataSchema>;

/**
 * The record the OAuth provider stores an in-flight authorization code under,
 * in the verification table it shares with every other short-lived token. Only
 * the client it belongs to matters to a reconciliation that has to drop codes
 * nobody would authorize again.
 */
export const PendingNativeAuthorizationSchema = z.object({
  query: z.looseObject({ client_id: z.string() }),
  type: z.literal("authorization_code"),
});

/** Narrows the verification table to authorization codes before parsing them. */
export const pendingNativeAuthorizationMarker = '"type":"authorization_code"';

/** The Host authorization server's built-in allowlist. */
export const opensteerHostNativeOAuthClients: readonly NativeOAuthClient[] =
  opensteerNativeClients.map((client) => ({
    application: client.application,
    clientId: client.clientId,
    displayName: client.hostDisplayName,
    redirectUris: [client.hostCallback],
    softwareId: client.hostSoftwareId,
  }));

/**
 * The Account authorization server's built-in allowlist. The desktop entry
 * keeps the presentation the existing registration already carries, because
 * reconciliation writes configuration over durable rows and a shape change
 * must not silently rename what people have already consented to.
 */
export const opensteerAccountNativeOAuthClients: readonly NativeOAuthClient[] =
  opensteerNativeClients.map((client) => ({
    application: client.application,
    clientId: client.clientId,
    displayName: client.accountDisplayName,
    redirectUris: [client.accountCallback],
    softwareId: client.accountSoftwareId,
  }));
