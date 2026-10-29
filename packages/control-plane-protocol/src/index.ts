import {
  AuthSessionIdSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  IdentityEmailSchema,
  UserIdSchema,
  isBareOrigin,
  isSecureOrLoopbackOrigin,
  opensteerAccountDeleteOAuthScopes,
} from "@opensteer/core";
import { z } from "zod";
// Subpath imports keep this schema surface loadable in sandboxed renderer and
// preload contexts: the deployment-authority barrel re-exports Ed25519
// verification, which requires node:crypto.
import {
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  sameDiscoveryDocument,
} from "@opensteer/deployment-authority/authority";
import { PersonalHostAccessRouteEnvelopeSchema } from "@opensteer/deployment-authority/personal-access-route";
import {
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
} from "./connect.js";
import { ControlPlaneAccountIdSchema, prefixedIdSchema } from "./account-id.js";
export * from "./account-id.js";
export * from "./connect.js";
export * from "./cloud.js";
export * from "./notifications.js";
export * from "./oauth-broker.js";

export const HostAccountAdoptionProofIdSchema =
  prefixedIdSchema("hap").brand<"HostAccountAdoptionProofId">();
export type HostAccountAdoptionProofId = z.infer<typeof HostAccountAdoptionProofIdSchema>;

export const HostAccountAdoptionGrantIdSchema =
  prefixedIdSchema("hag").brand<"HostAccountAdoptionGrantId">();

export const PersonalHostAccountLinkChallengeIdSchema =
  prefixedIdSchema("phc").brand<"PersonalHostAccountLinkChallengeId">();
export type PersonalHostAccountLinkChallengeId = z.infer<
  typeof PersonalHostAccountLinkChallengeIdSchema
>;

export const PersonalHostAccountLinkOperationIdSchema =
  prefixedIdSchema("plo").brand<"PersonalHostAccountLinkOperationId">();
export type PersonalHostAccountLinkOperationId = z.infer<
  typeof PersonalHostAccountLinkOperationIdSchema
>;

export const PersonalHostAccountLinkGrantIdSchema =
  prefixedIdSchema("phg").brand<"PersonalHostAccountLinkGrantId">();

export const AccountHostSessionGrantIdSchema =
  prefixedIdSchema("ahs").brand<"AccountHostSessionGrantId">();

export const HostAccountAdoptionProofCredentialSchema = z
  .string()
  .regex(/^oap_[A-Za-z0-9_-]{43}$/u)
  .brand<"HostAccountAdoptionProofCredential">();
export type HostAccountAdoptionProofCredential = z.infer<
  typeof HostAccountAdoptionProofCredentialSchema
>;

export const ProjectionGenerationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type ProjectionGeneration = z.infer<typeof ProjectionGenerationSchema>;
export const PublishedProjectionGenerationSchema = ProjectionGenerationSchema.min(1);
export const hostOidcCallbackPath = "/v1/auth/oidc/callback";

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * A Host or Connect origin, without a path, query, credentials, or fragment.
 * Production services should additionally require HTTPS; HTTP loopback exists
 * for a native app talking to a Host on the same computer.
 */
export const DeploymentOriginSchema = z
  .url()
  .superRefine((value, context) => {
    if (!isBareOrigin(value)) {
      context.addIssue({ code: "custom", message: "Expected a bare origin" });
    }
    if (!isSecureOrLoopbackOrigin(value)) {
      context.addIssue({ code: "custom", message: "Expected HTTPS or HTTP loopback" });
    }
  })
  .transform((value) => new URL(value).origin);

export const ConnectStateSchema = z.enum([
  "disabled",
  "provisioning",
  "ready",
  "offline",
  "revoked",
]);
export type ConnectState = z.infer<typeof ConnectStateSchema>;

export const AccountDeploymentAccessSchema = z.enum(["owner", "member"]);

export const AccountLinkGenerationSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .brand<"AccountLinkGeneration">();

export const HostOidcClientSchema = z
  .object({
    clientId: z.string().min(8).max(200),
    issuer: DeploymentOriginSchema,
    redirectUri: z.url().max(2_048),
    scopes: z.array(z.string().min(1).max(100)).min(3).max(16),
    tokenEndpointAuthMethod: z.literal("client_secret_basic"),
    requirePkce: z.literal(true),
  })
  .strict();
export type HostOidcClient = z.infer<typeof HostOidcClientSchema>;

/** Verified Account identity persisted by a managed Host as its first owner. */
export const VerifiedDeploymentOwnerProfileSchema = z
  .object({
    subject: ControlPlaneAccountIdSchema,
    email: IdentityEmailSchema.refine((value) => value === value.toLowerCase(), {
      message: "Owner email must be normalized",
    }),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();
export type VerifiedDeploymentOwnerProfile = z.infer<typeof VerifiedDeploymentOwnerProfileSchema>;

export const DeploymentConnectSchema = z
  .object({
    accessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable().optional().default(null),
    state: ConnectStateSchema,
    origin: DeploymentOriginSchema.nullable(),
    generation: ProjectionGenerationSchema,
    lastSeenAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const mustHaveOrigin = value.state === "ready" || value.state === "offline";
    if (mustHaveOrigin !== (value.origin !== null)) {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: mustHaveOrigin
          ? "A ready or offline Connect route requires an origin"
          : "This Connect state must not expose an origin",
      });
    }
    if (value.accessRoute) {
      if (!mustHaveOrigin) {
        context.addIssue({
          code: "custom",
          message: "Only a ready or offline Connect state can expose an access route",
          path: ["accessRoute"],
        });
      }
      if (
        value.accessRoute.document.route.kind !== "connect" ||
        value.accessRoute.document.route.origin !== value.origin ||
        value.accessRoute.document.route.generation !== value.generation
      ) {
        context.addIssue({
          code: "custom",
          message: "Connect state must match its exact signed Personal access route",
          path: ["accessRoute"],
        });
      }
    }
  });

// Every projection below is an Account answer, never something the Account
// parses as input, so each tolerates fields a newer Account adds.
const AccountDeploymentBaseSchema = z.object({
  access: AccountDeploymentAccessSchema,
  generation: PublishedProjectionGenerationSchema,
  id: DeploymentIdSchema,
  lifecycle: z.literal("active"),
  name: z.string().trim().min(1).max(120),
  updatedAt: IsoDateTimeSchema,
});

export const AccountDeploymentAccountLinkSchema = z.object({
  generation: AccountLinkGenerationSchema,
  issuer: DeploymentOriginSchema,
  subject: ControlPlaneAccountIdSchema,
});

export const AccountDeploymentConnectResourceStateSchema = z.enum([
  "disabled",
  "provisioning",
  "ready",
  "rotating",
  "revoking",
  "error",
]);

export const AccountDeploymentLivenessObservationSchema = z
  .object({
    expiresAt: IsoDateTimeSchema,
    observedAt: IsoDateTimeSchema,
  })
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.observedAt), {
    message: "A route liveness observation must expire after it was observed",
    path: ["expiresAt"],
  });

export const connectLivenessLifetimeMilliseconds = 2 * 60 * 1_000;
export const connectLivenessRefreshIntervalMilliseconds = connectLivenessLifetimeMilliseconds / 2;

const AccountDeploymentCanonicalSchema = AccountDeploymentBaseSchema.extend({
  authorityEnvelope: HostDiscoveryEnvelopeSchema,
  canonicalOrigin: DeploymentOriginSchema,
  reachability: z.literal("canonical"),
});

/** A Personal Host is the only deployment whose canonical origin is unreachable from other devices. */
const AccountDeploymentRoutedSchema = AccountDeploymentBaseSchema.extend({
  accountLink: AccountDeploymentAccountLinkSchema,
  authorityEnvelope: HostDiscoveryEnvelopeSchema,
  connectResourceState: AccountDeploymentConnectResourceStateSchema,
  connectRoute: PersonalHostAccessRouteEnvelopeSchema.nullable(),
  lastSeenAt: AccountDeploymentLivenessObservationSchema.nullable(),
  reachability: z.literal("routed"),
});

export const AccountDeploymentActiveSchema = z.discriminatedUnion("reachability", [
  AccountDeploymentCanonicalSchema,
  AccountDeploymentRoutedSchema,
]);

export const AccountDeploymentSchema = AccountDeploymentActiveSchema;
export type AccountDeployment = z.infer<typeof AccountDeploymentSchema>;

/**
 * Protocol-neutral identity pinned by the Account directory.
 *
 * The signed authority artifacts beside this tuple are discovery material, not
 * Account API wire authority. A client must parse and verify those artifacts
 * against its exact runtime protocol independently for each Deployment.
 */
export const AccountDeploymentDirectoryAuthoritySchema = z.object({
  canonicalOrigin: DeploymentOriginSchema,
  deploymentId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
});

const AccountDeploymentDirectoryCanonicalSchema = AccountDeploymentBaseSchema.extend({
  authority: AccountDeploymentDirectoryAuthoritySchema,
  // These are bounded JSON artifacts because their document versions belong
  // to the publishing Host. Exact schemas are applied per entry at the live
  // connection boundary, so one historical artifact cannot invalidate the
  // Account's otherwise usable directory.
  authorityEnvelope: z.json(),
  canonicalOrigin: DeploymentOriginSchema,
  reachability: z.literal("canonical"),
});

const AccountDeploymentDirectoryRoutedSchema = AccountDeploymentBaseSchema.extend({
  accountLink: AccountDeploymentAccountLinkSchema,
  authority: AccountDeploymentDirectoryAuthoritySchema,
  authorityEnvelope: z.json(),
  connectResourceState: AccountDeploymentConnectResourceStateSchema,
  connectRoute: z.json().nullable(),
  lastSeenAt: AccountDeploymentLivenessObservationSchema.nullable(),
  reachability: z.literal("routed"),
});

export const AccountDeploymentDirectoryActiveSchema = z.discriminatedUnion("reachability", [
  AccountDeploymentDirectoryCanonicalSchema,
  AccountDeploymentDirectoryRoutedSchema,
]);

export const AccountDeploymentDirectoryEntrySchema = AccountDeploymentDirectoryActiveSchema;
export type AccountDeploymentDirectoryEntry = z.infer<typeof AccountDeploymentDirectoryEntrySchema>;

/**
 * An Account directory record for a Personal Host, narrowed to the case where
 * the Account link is present. Whether such a record is reachable right now is
 * not decided here: that rule is `deploymentStatusFromPersonalConnect` in
 * `@opensteer/protocol/deployment-status`, which the Cloud portal and the
 * Desktop directory both answer with, so one computer is never ready in one
 * Directory and offline in the other.
 */

/** Maximum active owned and shared Deployments visible to one Account. */
export const maximumAccountDeployments = 100;

export const ListAccountDeploymentsResponseSchema = z.object({
  deployments: z.array(AccountDeploymentDirectoryEntrySchema).max(maximumAccountDeployments),
});

/**
 * The adoption authority is a flattened, unsigned fence rather than the full
 * signed Host authority tuple: it omits document/protocol/workspace fields and
 * stores the Host key fingerprint without the Ed25519 key wrapper.
 */
export const HostAccountAdoptionAuthoritySchema = z
  .object({
    deploymentId: DeploymentIdSchema,
    hostInstanceId: HostInstanceIdSchema,
    canonicalOrigin: DeploymentOriginSchema,
    hostKeyFingerprint: HostKeyFingerprintSchema,
  })
  .strict();
export type HostAccountAdoptionAuthority = z.infer<typeof HostAccountAdoptionAuthoritySchema>;

/** Account identity to which a Host administrator binds a one-use adoption proof. */
export const HostAccountIdentitySchema = z
  .object({
    issuer: DeploymentOriginSchema,
    subject: ControlPlaneAccountIdSchema,
  })
  .strict();
export type HostAccountIdentity = z.infer<typeof HostAccountIdentitySchema>;

/**
 * The identity as a client reads it. The strict model above also travels
 * inside the signed link proof, which must keep rejecting fields no key
 * attested, so a response projects it through this instead of loosening it.
 */
export const HostAccountIdentityViewSchema = z.object(HostAccountIdentitySchema.shape);

export const PersonalHostAccountLinkChallengeCredentialSchema = z
  .string()
  .regex(/^olc_[A-Za-z0-9_-]{43}$/u)
  .brand<"PersonalHostAccountLinkChallengeCredential">();
export type PersonalHostAccountLinkChallengeCredential = z.infer<
  typeof PersonalHostAccountLinkChallengeCredentialSchema
>;

export const IssuePersonalHostAccountLinkChallengeRequestSchema = z.strictObject({
  authorityEnvelope: HostDiscoveryEnvelopeSchema.refine(
    (envelope) => PersonalHostAccessAuthoritySchema.safeParse(envelope.document).success,
    { message: "Account linking requires a Personal Host discovery envelope" },
  ),
  name: z.string().trim().min(1).max(120),
  operationId: PersonalHostAccountLinkOperationIdSchema,
});
export type IssuePersonalHostAccountLinkChallengeRequest = z.infer<
  typeof IssuePersonalHostAccountLinkChallengeRequestSchema
>;

export const IssuePersonalHostAccountLinkChallengeResponseSchema = z.object({
  account: HostAccountIdentityViewSchema,
  authorityEnvelope: HostDiscoveryEnvelopeSchema,
  challengeCredential: PersonalHostAccountLinkChallengeCredentialSchema,
  challengeId: PersonalHostAccountLinkChallengeIdSchema,
  expiresAt: IsoDateTimeSchema,
});
export type IssuePersonalHostAccountLinkChallengeResponse = z.infer<
  typeof IssuePersonalHostAccountLinkChallengeResponseSchema
>;

export const PersonalHostAccountLinkProofDocumentSchema = z
  .strictObject({
    account: HostAccountIdentitySchema,
    authority: PersonalHostAccessAuthoritySchema,
    challenge: z.strictObject({
      credentialSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      id: PersonalHostAccountLinkChallengeIdSchema,
    }),
    documentVersion: z.literal(2),
    expiresAt: IsoDateTimeSchema,
    issuedAt: IsoDateTimeSchema,
    purpose: z.literal("opensteer-personal-host-account-link"),
  })
  .superRefine((document, context) => {
    const issuedAt = new Date(document.issuedAt).getTime();
    const expiresAt = new Date(document.expiresAt).getTime();
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: "Personal Host Account-link proofs may live for at most five minutes",
        path: ["expiresAt"],
      });
    }
  });
export type PersonalHostAccountLinkProofDocument = z.infer<
  typeof PersonalHostAccountLinkProofDocumentSchema
>;

export const PersonalHostAccountLinkProofEnvelopeSchema = z.strictObject({
  document: PersonalHostAccountLinkProofDocumentSchema,
  publicKey: z.strictObject({
    algorithm: z.literal("Ed25519"),
    spki: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type PersonalHostAccountLinkProofEnvelope = z.infer<
  typeof PersonalHostAccountLinkProofEnvelopeSchema
>;

const maximumPersonalHostAccountLinkProofSigningBytes = 8 * 1_024;

/** Exact bytes approved locally and signed by the Personal Host. */
export function personalHostAccountLinkProofSigningBytes(
  documentInput: PersonalHostAccountLinkProofDocument,
): Uint8Array {
  const document = PersonalHostAccountLinkProofDocumentSchema.parse(documentInput);
  const bytes = new TextEncoder().encode(
    `opensteer-personal-host-account-link-v4\0${JSON.stringify({
      account: {
        issuer: document.account.issuer,
        subject: document.account.subject,
      },
      authority: {
        canonicalOrigin: document.authority.canonicalOrigin,
        deploymentId: document.authority.deploymentId,
        hostInstanceId: document.authority.hostInstanceId,
        hostKey: {
          algorithm: document.authority.hostKey.algorithm,
        },
        deploymentShape: document.authority.deploymentShape,
      },
      challenge: {
        credentialSha256: document.challenge.credentialSha256,
        id: document.challenge.id,
      },
      documentVersion: document.documentVersion,
      expiresAt: document.expiresAt,
      issuedAt: document.issuedAt,
      purpose: document.purpose,
    })}`,
  );
  if (bytes.byteLength > maximumPersonalHostAccountLinkProofSigningBytes) {
    throw new TypeError("Personal Host Account-link proof signing payload is too large");
  }
  return bytes;
}

export const CompletePersonalHostAccountLinkRequestSchema = z.strictObject({
  challengeCredential: PersonalHostAccountLinkChallengeCredentialSchema,
  proof: PersonalHostAccountLinkProofEnvelopeSchema,
});
export type CompletePersonalHostAccountLinkRequest = z.infer<
  typeof CompletePersonalHostAccountLinkRequestSchema
>;

export const PersonalHostAccountLinkCompletionGrantSchema = z
  .string()
  .min(64)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export type PersonalHostAccountLinkCompletionGrant = z.infer<
  typeof PersonalHostAccountLinkCompletionGrantSchema
>;

export const PersonalHostAccountLinkCompletionGrantClaimsSchema = z
  .strictObject({
    account: HostAccountIdentitySchema,
    aud: DeploymentOriginSchema,
    authority: PersonalHostAccessAuthoritySchema,
    challengeId: PersonalHostAccountLinkChallengeIdSchema,
    exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    iss: DeploymentOriginSchema,
    jti: PersonalHostAccountLinkGrantIdSchema,
    linkGeneration: AccountLinkGenerationSchema,
    sub: ControlPlaneAccountIdSchema,
    tokenUse: z.literal("opensteer-personal-host-account-link"),
  })
  .superRefine((claims, context) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 5 * 60) {
      context.addIssue({
        code: "custom",
        message: "Personal Host Account-link grants may live for at most five minutes",
        path: ["exp"],
      });
    }
    if (claims.account.issuer !== claims.iss || claims.account.subject !== claims.sub) {
      context.addIssue({ code: "custom", message: "Signed Account identity does not match" });
    }
    if (claims.authority.canonicalOrigin !== claims.aud) {
      context.addIssue({
        code: "custom",
        message: "Grant audience must equal the Personal Host canonical origin",
        path: ["aud"],
      });
    }
  });
export type PersonalHostAccountLinkCompletionGrantClaims = z.infer<
  typeof PersonalHostAccountLinkCompletionGrantClaimsSchema
>;

/**
 * Account sign-in returns only the credential material the Host needs to
 * activate. The Host is the sole activation authority, so completion names no
 * Deployment: none exists until the Host calls activate.
 */
export const CompletePersonalHostAccountLinkResponseSchema = z.object({
  completionGrant: PersonalHostAccountLinkCompletionGrantSchema,
  hostCredential: z.string().regex(/^osc_[A-Za-z0-9_-]{43}$/u),
  linkGeneration: AccountLinkGenerationSchema,
  resultExpiresAt: IsoDateTimeSchema,
});
export type CompletePersonalHostAccountLinkResponse = z.infer<
  typeof CompletePersonalHostAccountLinkResponseSchema
>;

export const ActivatePersonalHostAccountLinkRequestSchema = z.strictObject({
  challengeId: PersonalHostAccountLinkChallengeIdSchema,
  linkGeneration: AccountLinkGenerationSchema,
});
export type ActivatePersonalHostAccountLinkRequest = z.infer<
  typeof ActivatePersonalHostAccountLinkRequestSchema
>;

export const ActivatePersonalHostAccountLinkResponseSchema = z.strictObject({
  activated: z.literal(true),
  deploymentId: DeploymentIdSchema,
  linkGeneration: AccountLinkGenerationSchema,
});
export type ActivatePersonalHostAccountLinkResponse = z.infer<
  typeof ActivatePersonalHostAccountLinkResponseSchema
>;

export const CancelPersonalHostAccountLinkOperationRequestSchema = z.strictObject({
  operationId: PersonalHostAccountLinkOperationIdSchema,
});
export type CancelPersonalHostAccountLinkOperationRequest = z.infer<
  typeof CancelPersonalHostAccountLinkOperationRequestSchema
>;
export const CancelPersonalHostAccountLinkOperationResponseSchema = z.object({
  cancelled: z.literal(true),
  operationId: PersonalHostAccountLinkOperationIdSchema,
});

export const UnlinkPersonalHostRequestSchema = z.strictObject({
  challengeId: PersonalHostAccountLinkChallengeIdSchema,
  linkGeneration: AccountLinkGenerationSchema,
});
export type UnlinkPersonalHostRequest = z.infer<typeof UnlinkPersonalHostRequestSchema>;

export const UnlinkPersonalHostResponseSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  unlinked: z.literal(true),
});

/**
 * A Host re-asserting its current signed discovery document. The Account keeps
 * one copy per Deployment and every Desktop verifies that copy before listing
 * the Deployment, so the Host that signs it is the only party allowed to
 * refresh it, and it does so on every start.
 */
export const PublishHostAuthorityRequestSchema = z.strictObject({
  authorityEnvelope: HostDiscoveryEnvelopeSchema,
});
export type PublishHostAuthorityRequest = z.infer<typeof PublishHostAuthorityRequestSchema>;

export const PublishHostAuthorityResponseSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  published: z.literal(true),
});
export type PublishHostAuthorityResponse = z.infer<typeof PublishHostAuthorityResponseSchema>;

export const UpdateAccountDeploymentNameRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});
export const UpdateAccountDeploymentNameResponseSchema = z.object({
  deployment: AccountDeploymentSchema,
});

export const RemoveAccountDeploymentResponseSchema = z.object({
  deploymentId: DeploymentIdSchema,
  removed: z.literal(true),
});

export const AccountHostSessionGrantSchema = z
  .string()
  .min(64)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export type AccountHostSessionGrant = z.infer<typeof AccountHostSessionGrantSchema>;

/** Hard ceiling on every Account-to-Host session capability, in seconds. */
export const accountHostSessionGrantLifetimeSeconds = 120;

/**
 * Which client the Account signed this grant for. The surface is the fence a
 * Host checks the exchange against: `browser` is the Account portal's own
 * redirect and must name the portal origin it came from, while `desktop` and
 * `native` are applications holding an Account credential of their own and
 * must not carry one. It is also where the Host's credential delivery comes
 * from, so a phone can never present a desktop's grant or the reverse.
 */
export const AccountHostSessionClientSurfaceSchema = z.enum(["desktop", "browser", "native"]);
export type AccountHostSessionClientSurface = z.infer<typeof AccountHostSessionClientSurfaceSchema>;

const AccountHostSessionGrantCommonShape = {
  account: HostAccountIdentitySchema,
  aud: DeploymentOriginSchema,
  authority: HostDiscoveryDocumentSchema,
  clientSurface: AccountHostSessionClientSurfaceSchema,
  deploymentId: DeploymentIdSchema,
  exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  iss: DeploymentOriginSchema,
  jti: AccountHostSessionGrantIdSchema,
  portalOrigin: DeploymentOriginSchema.optional(),
  sub: ControlPlaneAccountIdSchema,
  tokenUse: z.literal("opensteer-account-host-session"),
} as const;

const PersonalConnectAccountHostSessionGrantClaimsSchema = z.strictObject({
  ...AccountHostSessionGrantCommonShape,
  personalHostAccessRouteEnvelopeSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  route: PersonalHostAccessRouteDocumentSchema.refine(
    (document) => document.route.kind === "connect",
    { message: "Account session grants require a Connect route" },
  ),
  routeGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetKind: z.literal("personal-connect"),
});

export const AccountHostSessionGrantClaimsSchema = z
  .strictObject(PersonalConnectAccountHostSessionGrantClaimsSchema.shape)
  .superRefine((claims, context) => {
    if (
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > accountHostSessionGrantLifetimeSeconds
    ) {
      context.addIssue({
        code: "custom",
        message: "Account Host session grants may live for at most two minutes",
        path: ["exp"],
      });
    }
    if (claims.account.issuer !== claims.iss || claims.account.subject !== claims.sub) {
      context.addIssue({ code: "custom", message: "Signed Account identity does not match" });
    }
    if (
      claims.authority.canonicalOrigin !== claims.aud ||
      claims.authority.deploymentId !== claims.deploymentId
    ) {
      context.addIssue({
        code: "custom",
        message: "Grant audience and Deployment must equal the signed Host authority",
        path: ["authority"],
      });
    }
    if (claims.clientSurface === "browser" && claims.portalOrigin === undefined) {
      context.addIssue({
        code: "custom",
        message: "Browser grants require the exact portal origin",
        path: ["portalOrigin"],
      });
    }
    if (claims.clientSurface !== "browser" && claims.portalOrigin !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Application grants cannot carry a portal origin",
        path: ["portalOrigin"],
      });
    }
    if (
      !sameDiscoveryDocument(claims.authority, claims.route.authority) ||
      claims.routeGeneration !== claims.route.route.generation
    ) {
      context.addIssue({
        code: "custom",
        message: "Personal session route must equal the signed Host authority and generation",
        path: ["route"],
      });
    }
  });
export type AccountHostSessionGrantClaims = z.infer<typeof AccountHostSessionGrantClaimsSchema>;

export const IssuePersonalAccountHostSessionGrantRequestSchema = z
  .strictObject({
    clientSurface: AccountHostSessionClientSurfaceSchema,
    expectedAuthority: PersonalHostAccessAuthoritySchema,
    expectedRoute: PersonalHostAccessRouteEnvelopeSchema.refine(
      (envelope) => envelope.document.route.kind === "connect",
      { message: "Account session grants require a Connect route" },
    ),
    portalOrigin: DeploymentOriginSchema.optional(),
    targetKind: z.literal("personal-connect"),
  })
  .superRefine((request, context) => {
    if (request.clientSurface === "browser" && request.portalOrigin === undefined) {
      context.addIssue({
        code: "custom",
        message: "Browser grants require the exact portal origin",
        path: ["portalOrigin"],
      });
    }
    if (request.clientSurface !== "browser" && request.portalOrigin !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Application grants cannot carry a portal origin",
        path: ["portalOrigin"],
      });
    }
  });
export type IssuePersonalAccountHostSessionGrantRequest = z.infer<
  typeof IssuePersonalAccountHostSessionGrantRequestSchema
>;

export const IssueAccountHostSessionGrantResponseSchema = z.object({
  expiresAt: IsoDateTimeSchema,
  grant: AccountHostSessionGrantSchema,
});
export type IssueAccountHostSessionGrantResponse = z.infer<
  typeof IssueAccountHostSessionGrantResponseSchema
>;

export const IssueHostAccountAdoptionProofRequestSchema = z
  .object({
    account: HostAccountIdentitySchema,
  })
  .strict();

export const IssueHostAccountAdoptionProofResponseSchema = z
  .object({
    proofId: HostAccountAdoptionProofIdSchema,
    proofCredential: HostAccountAdoptionProofCredentialSchema,
    account: HostAccountIdentitySchema,
    authority: HostAccountAdoptionAuthoritySchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export const ConsumeHostAccountAdoptionProofRequestSchema = z
  .object({
    proofCredential: HostAccountAdoptionProofCredentialSchema,
    expectedAccount: HostAccountIdentitySchema,
    expectedAuthority: HostAccountAdoptionAuthoritySchema,
  })
  .strict();

export const ConsumeHostAccountAdoptionProofResponseSchema = z
  .object({
    proofId: HostAccountAdoptionProofIdSchema,
    consumedAt: IsoDateTimeSchema,
    account: HostAccountIdentitySchema,
    authority: HostAccountAdoptionAuthoritySchema,
    authorizedBy: z
      .object({
        userId: UserIdSchema,
        sessionId: AuthSessionIdSchema,
      })
      .strict(),
  })
  .strict();
export type ConsumeHostAccountAdoptionProofResponse = z.infer<
  typeof ConsumeHostAccountAdoptionProofResponseSchema
>;

export const HostAccountAdoptionCompletionGrantSchema = z
  .string()
  .min(64)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export type HostAccountAdoptionCompletionGrant = z.infer<
  typeof HostAccountAdoptionCompletionGrantSchema
>;

/**
 * Exact claims signed by the Opensteer Account Better Auth JWT key. The Host
 * verifies the signature, issuer, audience, lifetime, and every tuple member
 * before translating these claims into a local identity binding.
 */
export const HostAccountAdoptionCompletionGrantClaimsSchema = z
  .object({
    tokenUse: z.literal("opensteer-host-account-adoption"),
    iss: DeploymentOriginSchema,
    aud: DeploymentOriginSchema,
    sub: ControlPlaneAccountIdSchema,
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    jti: HostAccountAdoptionGrantIdSchema,
    proof: z
      .object({
        id: HostAccountAdoptionProofIdSchema,
        consumedAt: IsoDateTimeSchema,
        authorizedBy: z
          .object({
            userId: UserIdSchema,
            sessionId: AuthSessionIdSchema,
          })
          .strict(),
      })
      .strict(),
    account: HostAccountIdentitySchema,
    authority: HostAccountAdoptionAuthoritySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.exp <= value.iat || value.exp - value.iat > 5 * 60) {
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "Account adoption grants may live for at most five minutes",
      });
    }
    if (value.account.issuer !== value.iss || value.account.subject !== value.sub) {
      context.addIssue({
        code: "custom",
        path: ["account"],
        message: "Account identity must match the signed issuer and subject",
      });
    }
    if (value.authority.canonicalOrigin !== value.aud) {
      context.addIssue({
        code: "custom",
        path: ["aud"],
        message: "Grant audience must equal the proved Host origin",
      });
    }
  });

export const CompleteHostAccountAdoptionRequestSchema = z
  .object({
    completionGrant: HostAccountAdoptionCompletionGrantSchema,
  })
  .strict();

export const CompleteHostAccountAdoptionResponseSchema = z
  .object({
    account: HostAccountIdentitySchema,
    proofId: HostAccountAdoptionProofIdSchema,
    providerId: z.string().trim().min(1).max(512),
    userId: UserIdSchema,
  })
  .strict();

/**
 * Attaches an independently self-hosted Deployment to an Account. Initial
 * managed registration cannot stand in for this proof-bearing operation.
 */
export const AdoptExistingDeploymentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    reachability: z.literal("canonical"),
    authority: HostAccountAdoptionAuthoritySchema,
    proof: z
      .object({
        proofId: HostAccountAdoptionProofIdSchema,
        proofCredential: HostAccountAdoptionProofCredentialSchema,
      })
      .strict(),
  })
  .strict();
export type AdoptExistingDeploymentRequest = z.infer<typeof AdoptExistingDeploymentRequestSchema>;

/** Credentials and authority material written once while provisioning a Host. */
export const DeploymentProvisioningResultSchema = z
  .object({
    deployment: z.strictObject({
      id: DeploymentIdSchema,
      reachability: z.literal("canonical"),
    }),
    hostCredential: z.string().regex(/^osc_[A-Za-z0-9_-]{43}$/u),
    owner: VerifiedDeploymentOwnerProfileSchema,
    oidc: HostOidcClientSchema,
    oidcClientSecret: z.string().regex(/^ocs_[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
export type DeploymentProvisioningResult = z.infer<typeof DeploymentProvisioningResultSchema>;

export const DirectoryProjectionRequestSchema = z
  .object({
    hostInstanceId: HostInstanceIdSchema,
    generation: PublishedProjectionGenerationSchema,
    present: z.boolean(),
    observedAt: IsoDateTimeSchema,
  })
  .strict();
export type DirectoryProjectionRequest = z.infer<typeof DirectoryProjectionRequestSchema>;

export const DirectoryProjectionResponseSchema = z
  .object({
    accountId: ControlPlaneAccountIdSchema,
    generation: PublishedProjectionGenerationSchema,
    present: z.boolean(),
  })
  .strict();
export type DirectoryProjectionResponse = z.infer<typeof DirectoryProjectionResponseSchema>;

export const ConnectProjectionRequestSchema = z
  .object({
    accessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable().optional().default(null),
    hostInstanceId: HostInstanceIdSchema,
    generation: PublishedProjectionGenerationSchema,
    state: ConnectStateSchema,
    origin: DeploymentOriginSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const mustHaveOrigin = value.state === "ready" || value.state === "offline";
    if (mustHaveOrigin !== (value.origin !== null)) {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: mustHaveOrigin
          ? "A ready or offline Connect route requires an origin"
          : "This Connect state must not expose an origin",
      });
    }
  });
export type ConnectProjectionRequest = z.infer<typeof ConnectProjectionRequestSchema>;
export type ConnectProjectionInput = z.input<typeof ConnectProjectionRequestSchema>;

export const ConnectProjectionResponseSchema = DeploymentConnectSchema;

const ManagedHostProvisioningBundleBaseSchema = z
  .object({
    controlApiOrigin: DeploymentOriginSchema,
    deployment: z
      .object({
        deploymentId: DeploymentIdSchema,
        hostInstanceId: HostInstanceIdSchema,
        canonicalOrigin: DeploymentOriginSchema,
        hostKeyFingerprint: HostKeyFingerprintSchema,
        reachability: z.literal("canonical"),
      })
      .strict(),
    hostCredential: z.string().regex(/^osc_[A-Za-z0-9_-]{43}$/u),
    oidc: HostOidcClientSchema,
    oidcClientSecret: z.string().regex(/^ocs_[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export const ManagedHostProvisioningBundleSchema = z
  .discriminatedUnion("provisioningMode", [
    ManagedHostProvisioningBundleBaseSchema.extend({
      initialRunnerEnrollmentToken: z.string().min(32).max(4_096),
      provisioningMode: z.literal("managed"),
      owner: VerifiedDeploymentOwnerProfileSchema,
    }).strict(),
    ManagedHostProvisioningBundleBaseSchema.extend({
      provisioningMode: z.literal("adoption"),
    }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.oidc.issuer !== value.controlApiOrigin) {
      context.addIssue({
        code: "custom",
        path: ["oidc", "issuer"],
        message: "OIDC issuer must equal the control API origin",
      });
    }
    const expectedCallback = new URL(hostOidcCallbackPath, value.deployment.canonicalOrigin).href;
    if (value.oidc.redirectUri !== expectedCallback) {
      context.addIssue({
        code: "custom",
        path: ["oidc", "redirectUri"],
        message: "OIDC callback must match the Deployment canonical origin",
      });
    }
  });
export type ManagedHostProvisioningBundle = z.infer<typeof ManagedHostProvisioningBundleSchema>;

/**
 * The adoption API returns restart-safe Host configuration plus a separately
 * signed, short-lived completion capability. The provisioning bundle is not
 * itself proof that the Account approved the attachment.
 */
export const AdoptExistingDeploymentResponseSchema = z
  .object({
    proofId: HostAccountAdoptionProofIdSchema,
    provisioningBundle: ManagedHostProvisioningBundleSchema.refine(
      (bundle) => bundle.provisioningMode === "adoption",
      { message: "Existing Host adoption requires an adoption provisioning bundle" },
    ),
    completionGrant: HostAccountAdoptionCompletionGrantSchema,
    resultExpiresAt: IsoDateTimeSchema,
  })
  .strict();
export type AdoptExistingDeploymentResponse = z.infer<typeof AdoptExistingDeploymentResponseSchema>;

export const AcknowledgeHostAccountAdoptionRequestSchema = z.object({}).strict();

export const AcknowledgeHostAccountAdoptionResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    proofId: HostAccountAdoptionProofIdSchema,
  })
  .strict();

export function adoptedHostProvisioningBundle(
  controlApiOrigin: string | URL,
  request: AdoptExistingDeploymentRequest,
  response: DeploymentProvisioningResult,
): ManagedHostProvisioningBundle {
  const parsedRequest = AdoptExistingDeploymentRequestSchema.parse(request);
  const parsedResponse = DeploymentProvisioningResultSchema.parse(response);
  const { authority } = parsedRequest;
  const deployment = parsedResponse.deployment;
  if (deployment.id !== authority.deploymentId) {
    throw new TypeError("Adoption response does not match the proved Host authority");
  }
  return ManagedHostProvisioningBundleSchema.parse({
    provisioningMode: "adoption",
    controlApiOrigin: controlApiOrigin instanceof URL ? controlApiOrigin.origin : controlApiOrigin,
    deployment: { ...authority, reachability: deployment.reachability },
    hostCredential: parsedResponse.hostCredential,
    oidc: parsedResponse.oidc,
    oidcClientSecret: parsedResponse.oidcClientSecret,
  });
}

export const DeleteAccountResponseSchema = z.object({ deleted: z.literal(true) }).strict();

export const RevokeAccountSessionsResponseSchema = z.object({ revoked: z.literal(true) }).strict();

export const ControlPlaneErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "recent_sign_in_required",
  "forbidden",
  "not_found",
  "conflict",
  "stale_projection",
  "owned_deployments_exist",
  "unavailable",
  "internal",
]);
export type ControlPlaneErrorCode = z.infer<typeof ControlPlaneErrorCodeSchema>;

/**
 * Machine-readable discriminators for the conflicts a client must react to
 * differently than a generic failure. The HTTP code says what happened; the
 * reason says which recovery the client owns.
 */
export const ControlPlaneErrorReasonSchema = z.enum([
  "personal-account-link-challenge-expired",
  "personal-account-link-reservation-expired",
  "personal-account-link-cancelled",
  "personal-account-link-not-found",
  "personal-account-link-already-active",
  "personal-host-already-linked",
  "account-deployment-quota-exceeded",
  "connect-resource-active",
  "push-not-configured",
  "device-limit",
]);
export type ControlPlaneErrorReason = z.infer<typeof ControlPlaneErrorReasonSchema>;

export const ControlPlaneErrorResponseSchema = z.object({
  error: z.object({
    code: ControlPlaneErrorCodeSchema,
    message: z.string().min(1).max(500),
    reason: ControlPlaneErrorReasonSchema.optional(),
  }),
});

/**
 * Complete scope vocabulary accepted by the Account authorization server.
 * Desktop requests the smaller everyday scope set and asks for
 * `account:delete` only during the explicit fresh-auth deletion flow.
 */
export const controlPlaneOAuthScopes = opensteerAccountDeleteOAuthScopes;

/** Logical Host provider ID; the Host binds this together with the exact Account issuer. */
export const officialOpensteerAccountProviderId = "opensteer-account";
