import { z } from "zod";
import { JsonObjectSchema, McpIdentifierSchema } from "./schema-primitives.js";
import {
  DeploymentIdSchema,
  RequestIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
  UserIdSchema,
  isLoopbackHostname,
  requestReasonMaxLength,
} from "@opensteer/core";
import { IntegrationAdapterKindSchema } from "./adapter-kind.js";
import { ComputerAppIdentitySchema, ComputerAppIdentityViewSchema } from "./computer-app.js";
import {
  ApiKeyDisclosureSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationDefinitionSummaryViewSchema,
} from "./adapter.js";
import { IntegrationProviderSchema } from "./identifiers.js";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantIdSchema,
  IntegrationInstallationIdSchema,
  IntegrationOAuthAttemptIdSchema,
  McpOAuthAttemptIdSchema,
  IntegrationProviderApplicationIdSchema,
  IntegrationServerIdSchema,
  IntegrationSkillIdSchema,
  IntegrationToolIdSchema,
} from "./ids.js";

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export { IntegrationProviderSchema, type IntegrationProvider } from "./identifiers.js";

export const IntegrationConnectionMethodSchema = z.enum([
  "api-key",
  "bring-your-own",
  "computer",
  "device",
  "managed-oauth",
]);
export type IntegrationConnectionMethod = z.infer<typeof IntegrationConnectionMethodSchema>;

const ProviderApplicationRevisionSchema = z.number().int().positive();

/**
 * Immutable provider-application authority captured when a provider connection is created.
 * Provider credentials remain in the Host vault; this value only says which application and
 * callback authority may be used to authorize or refresh them.
 */
export const IntegrationOAuthApplicationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    brokerIssuer: z.url(),
    kind: z.literal("hosted-oauth"),
    providerApplicationRevision: ProviderApplicationRevisionSchema,
  }),
  z.strictObject({
    callbackUrl: z.url(),
    kind: z.literal("deployment-oauth"),
    providerApplicationId: IntegrationProviderApplicationIdSchema,
    providerApplicationRevision: ProviderApplicationRevisionSchema,
  }),
]);
const IntegrationOAuthApplicationSourceViewSchema = z.discriminatedUnion("kind", [
  z.object(IntegrationOAuthApplicationSourceSchema.options[0].shape),
  z.object(IntegrationOAuthApplicationSourceSchema.options[1].shape),
]);
export type IntegrationOAuthApplicationSource = z.infer<
  typeof IntegrationOAuthApplicationSourceSchema
>;

export const IntegrationApplicationSourceSchema = z.discriminatedUnion("kind", [
  ...IntegrationOAuthApplicationSourceSchema.options,
  z.strictObject({ kind: z.literal("api-key") }),
  z.strictObject({
    kind: z.literal("provider-specific"),
    method: z.enum(["bring-your-own", "device"]),
  }),
]);
const IntegrationApplicationSourceViewSchema = z.discriminatedUnion("kind", [
  ...IntegrationOAuthApplicationSourceViewSchema.options,
  z.object(IntegrationApplicationSourceSchema.options[2].shape),
  z.object(IntegrationApplicationSourceSchema.options[3].shape),
]);
export type IntegrationApplicationSource = z.infer<typeof IntegrationApplicationSourceSchema>;

const IntegrationDeploymentPostureSchema = z.enum([
  "account-linked-personal",
  "account-free-personal",
  "independent-self-hosted",
  "account-adopted-self-hosted",
]);
export type IntegrationDeploymentPosture = z.infer<typeof IntegrationDeploymentPostureSchema>;

/**
 * The authenticated Host surface an authorization is started from. A Personal
 * remote session can start any sign-in whose provider returns somewhere its
 * browser can reach; see `oauthSourceFinishesOnHostComputer`.
 */
export const IntegrationAuthorizationSurfaceSchema = z.enum(["canonical", "personal-remote"]);
export type IntegrationAuthorizationSurface = z.infer<typeof IntegrationAuthorizationSurfaceSchema>;

export function resolveIntegrationDeploymentPosture(input: {
  readonly accountReachability: "canonical" | "routed" | null;
  readonly kind: "personal" | "server";
  readonly personalAccountLinked: boolean;
}): IntegrationDeploymentPosture {
  if (input.accountReachability === "canonical") return "account-adopted-self-hosted";
  if (input.kind === "personal") {
    return input.personalAccountLinked ? "account-linked-personal" : "account-free-personal";
  }
  return "independent-self-hosted";
}

export const IntegrationProviderAuthorizationCodeSchema = z.enum([
  "READY",
  "ACCOUNT_LINK_REQUIRED",
  "CANONICAL_SURFACE_REQUIRED",
  "PROVIDER_APPLICATION_REQUIRED",
  "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED",
  "OAUTH_SOURCE_UNAVAILABLE",
  "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE",
]);

export const IntegrationProviderAuthorizationSchema = z
  .strictObject({
    availableSources: z.array(IntegrationOAuthApplicationSourceSchema).max(32),
    code: IntegrationProviderAuthorizationCodeSchema,
    detail: z.string().trim().min(1).max(500),
    hostedOAuthStatus: z.enum(["available", "temporarily-unavailable", "unsupported"]),
    selectedSource: IntegrationOAuthApplicationSourceSchema.nullable(),
    selectedSourceKind: z.enum(["deployment-oauth", "hosted-oauth"]).nullable(),
  })
  .superRefine(validateIntegrationProviderAuthorization);
const IntegrationProviderAuthorizationViewSchema = z
  .object({
    ...IntegrationProviderAuthorizationSchema.shape,
    availableSources: z.array(IntegrationOAuthApplicationSourceViewSchema).max(32),
    selectedSource: IntegrationOAuthApplicationSourceViewSchema.nullable(),
  })
  .superRefine(validateIntegrationProviderAuthorization);
export type IntegrationProviderAuthorization = z.infer<
  typeof IntegrationProviderAuthorizationSchema
>;

export function sameIntegrationOAuthApplicationSource(
  left: IntegrationOAuthApplicationSource,
  right: IntegrationOAuthApplicationSource,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "hosted-oauth" && right.kind === "hosted-oauth") {
    return (
      left.brokerIssuer === right.brokerIssuer &&
      left.providerApplicationRevision === right.providerApplicationRevision
    );
  }
  return (
    left.kind === "deployment-oauth" &&
    right.kind === "deployment-oauth" &&
    left.callbackUrl === right.callbackUrl &&
    left.providerApplicationId === right.providerApplicationId &&
    left.providerApplicationRevision === right.providerApplicationRevision
  );
}

/**
 * Whether the provider sends this sign-in back to a loopback address, which
 * only a browser on the computer running the Host can reach. Opensteer's
 * managed app and relayed apps return to the Account service instead, so a
 * browser on any device can finish them.
 */
export function oauthSourceFinishesOnHostComputer(
  source: IntegrationOAuthApplicationSource,
): boolean {
  return (
    source.kind === "deployment-oauth" && isLoopbackHostname(new URL(source.callbackUrl).hostname)
  );
}

function validateIntegrationProviderAuthorization(
  value: {
    readonly availableSources: readonly IntegrationOAuthApplicationSource[];
    readonly code: z.infer<typeof IntegrationProviderAuthorizationCodeSchema>;
    readonly selectedSource: IntegrationOAuthApplicationSource | null;
    readonly selectedSourceKind: "deployment-oauth" | "hosted-oauth" | null;
  },
  context: z.RefinementCtx,
): void {
  if (
    new Set(value.availableSources.map(integrationOAuthApplicationSourceKey)).size !==
    value.availableSources.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Provider authorization sources must be unique",
    });
  }
  // A non-canonical surface keeps the resolved configuration and only reports that authorization
  // cannot launch there, so CANONICAL_SURFACE_REQUIRED is the one non-ready code with a selection.
  if (value.code === "READY" && value.selectedSource === null) {
    context.addIssue({
      code: "custom",
      message: "A ready provider authorization must have one selected source",
    });
  }
  if (
    value.selectedSource !== null &&
    value.code !== "READY" &&
    value.code !== "CANONICAL_SURFACE_REQUIRED"
  ) {
    context.addIssue({
      code: "custom",
      message: "A provider authorization with a selected source must be ready",
    });
  }
  if (value.selectedSource && value.selectedSource.kind !== value.selectedSourceKind) {
    context.addIssue({
      code: "custom",
      message: "The selected provider authorization source kind does not match its source",
    });
  }
  const selectedSource = value.selectedSource;
  if (
    selectedSource &&
    !value.availableSources.some((source) =>
      sameIntegrationOAuthApplicationSource(source, selectedSource),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "The selected provider authorization source must be available",
    });
  }
}

function integrationOAuthApplicationSourceKey(source: IntegrationOAuthApplicationSource): string {
  return source.kind === "hosted-oauth"
    ? `${source.kind}:${source.brokerIssuer}:${source.providerApplicationRevision}`
    : `${source.kind}:${source.providerApplicationId}:${source.providerApplicationRevision}:${source.callbackUrl}`;
}

export function providerAuthorizationIncludesSource(
  authorization: IntegrationProviderAuthorization | null | undefined,
  source: IntegrationOAuthApplicationSource,
): boolean {
  return (
    authorization?.availableSources.some((candidate) =>
      sameIntegrationOAuthApplicationSource(candidate, source),
    ) ?? false
  );
}

export const integrationApplicationSourceUnavailableDetail =
  "The OAuth app used by this account changed or is unavailable. Reconnect the account.";

/** What the Host records when a service turns away an account's saved key or sign-in. */
export function integrationCredentialRejectedDetail(
  name: string,
  credential: "key" | "sign-in",
): string {
  return `${name} rejected the saved ${credential}`;
}

export const integrationProviderIdentityAlreadyConnectedFailureCode =
  "provider-identity-already-connected";
export const integrationProviderIdentityAlreadyConnectedDetail =
  "This account is already connected by another user. Ask them to disconnect it, or connect with your own provider app.";

/**
 * Connections pin the exact OAuth application source that created them. A pinned source that is no
 * longer offered by the provider authorization can never be refreshed or reused, so every surface
 * that reports or enforces connection health must agree on this one predicate.
 */
export function integrationApplicationSourcePinnedAndAvailable(input: {
  readonly applicationSource: IntegrationApplicationSource | null | undefined;
  readonly authorization: IntegrationProviderAuthorization | null | undefined;
}): boolean {
  const source = input.applicationSource;
  if (source?.kind !== "hosted-oauth" && source?.kind !== "deployment-oauth") return true;
  if (input.authorization?.hostedOAuthStatus === "temporarily-unavailable") {
    return true;
  }
  return providerAuthorizationIncludesSource(input.authorization, source);
}

export function defaultOAuthApplicationSource(input: {
  readonly brokerIssuer?: string;
  readonly deploymentSource?: Extract<IntegrationApplicationSource, { kind: "deployment-oauth" }>;
  readonly hostedProviderApplicationRevision?: number;
  readonly posture: IntegrationDeploymentPosture;
}): Extract<IntegrationApplicationSource, { kind: "deployment-oauth" | "hosted-oauth" }> | null {
  const hosted =
    input.brokerIssuer && input.hostedProviderApplicationRevision
      ? IntegrationApplicationSourceSchema.parse({
          brokerIssuer: input.brokerIssuer,
          kind: "hosted-oauth",
          providerApplicationRevision: input.hostedProviderApplicationRevision,
        })
      : null;
  if (input.posture === "account-linked-personal") {
    return hosted as Extract<IntegrationApplicationSource, { kind: "hosted-oauth" }> | null;
  }
  if (input.posture === "account-free-personal") return input.deploymentSource ?? null;
  return input.deploymentSource ?? null;
}

export function integrationApplicationCallbackUrl(
  source: Extract<IntegrationApplicationSource, { kind: "deployment-oauth" | "hosted-oauth" }>,
  provider: z.infer<typeof IntegrationProviderSchema>,
): URL {
  if (source.kind === "deployment-oauth") return new URL(source.callbackUrl);
  return new URL(`/v1/oauth-broker/callback/${encodeURIComponent(provider)}`, source.brokerIssuer);
}

export const IntegrationProviderManifestSchema = z.strictObject({
  description: z.string().min(1).max(240),
  label: z.string().min(1).max(80),
  hostedOAuthCapable: z.boolean(),
  installationUrlRequired: z.boolean().optional(),
  provider: IntegrationProviderSchema,
  secretFields: z.array(z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/)).max(8),
  setupLabel: z.string().min(1).max(120),
  setupSteps: z.array(z.string().min(1).max(240)).min(1).max(8),
  setupUrl: z.url(),
});
const IntegrationProviderManifestViewSchema = z.object(IntegrationProviderManifestSchema.shape);
export type IntegrationProviderManifest = z.infer<typeof IntegrationProviderManifestSchema>;

export const IntegrationProviderApplicationSchema = z.strictObject({
  availability: z.enum(["personal", "deployment"]),
  callbackUrl: z.url(),
  canManage: z.boolean(),
  clientId: z.string().trim().min(1).max(2_048),
  configuredSecretFields: z.array(z.string().min(1).max(64)).max(8),
  createdAt: IsoDateTimeSchema,
  displayName: z.string().trim().min(1).max(160),
  id: IntegrationProviderApplicationIdSchema,
  installationUrl: z.url().nullable().optional(),
  ownerUserId: UserIdSchema.nullable(),
  provider: IntegrationProviderSchema,
  revision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]),
  updatedAt: IsoDateTimeSchema,
});
export const IntegrationProviderApplicationViewSchema = z.object(
  IntegrationProviderApplicationSchema.shape,
);
export type IntegrationProviderApplication = z.infer<typeof IntegrationProviderApplicationSchema>;

/**
 * Why a connection needs its owner, when the Host knows: every kind of
 * connection records it in one column. "permissions" means the credential
 * works but the provider has granted it too little, which for a provider
 * account is GitHub's repository installation step.
 */
export const IntegrationConnectionStatusReasonSchema = z.enum([
  "configuration",
  "credentials",
  "permissions",
  "transport",
]);
export type IntegrationConnectionStatusReason = z.infer<
  typeof IntegrationConnectionStatusReasonSchema
>;

export const IntegrationConnectionSummarySchema = z.strictObject({
  accountIdentifier: z.string().trim().min(1).max(320).nullable(),
  applicationSource: IntegrationApplicationSourceSchema.nullable(),
  authMethodId: z.string().min(1).max(64),
  authorizationDigest: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .nullable(),
  computer: z
    .strictObject({
      access: z.enum(["read", "read-write"]),
      /** The app this connection names, for a definition whose connections do. */
      app: ComputerAppIdentitySchema.nullable(),
      blockedAt: IsoDateTimeSchema.nullable(),
      policyRevision: z.number().int().positive().nullable(),
      runnerId: RunnerIdSchema,
    })
    .nullable(),
  connectionMethod: IntegrationConnectionMethodSchema,
  createdAt: IsoDateTimeSchema,
  definitionId: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(512),
  externalIdentityId: z.string().trim().min(1).max(2_048).nullable(),
  externalTenantId: z.string().trim().min(1).max(2_048).nullable(),
  grantedScopes: z.array(z.string().min(1).max(256)).max(512),
  id: IntegrationConnectionIdSchema,
  provider: IntegrationProviderSchema,
  providerApplicationId: IntegrationProviderApplicationIdSchema.nullable(),
  status: z.enum(["pending", "connected", "needs-attention", "paused", "revoked"]),
  statusDetail: z.string().trim().min(1).max(500).nullable(),
  statusReason: IntegrationConnectionStatusReasonSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export const IntegrationConnectionSummaryViewSchema = z.object({
  ...IntegrationConnectionSummarySchema.shape,
  applicationSource: IntegrationApplicationSourceViewSchema.nullable(),
  computer: z
    .object({
      ...IntegrationConnectionSummarySchema.shape.computer.unwrap().shape,
      app: ComputerAppIdentityViewSchema.nullable(),
    })
    .nullable()
    .default(null),
});
export type IntegrationConnectionSummary = z.infer<typeof IntegrationConnectionSummarySchema>;

export const IntegrationDashboardSchema = z.strictObject({
  applications: z.array(IntegrationProviderApplicationSchema).max(512),
  authorizationSurface: IntegrationAuthorizationSurfaceSchema,
  providerAuthorizations: z.record(
    IntegrationProviderSchema,
    IntegrationProviderAuthorizationSchema,
  ),
  callbackUrls: z.record(IntegrationProviderSchema, z.url()),
  connections: z.array(IntegrationConnectionSummarySchema).max(500),
  isAdministrator: z.boolean(),
  providers: z.array(IntegrationProviderManifestSchema).max(16),
  hostedOAuthDisclosure: z.string().min(1).max(1_000),
  /**
   * Set by a Host that begins a Personal remote session's sign-in when its
   * provider returns to the Account service. An older Host omits it and
   * refuses every remote sign-in.
   */
  remoteAccountSignIn: z.literal(true).optional(),
});
export const IntegrationDashboardViewSchema = z.object({
  ...IntegrationDashboardSchema.shape,
  applications: z.array(IntegrationProviderApplicationViewSchema).max(512),
  providerAuthorizations: z.record(
    IntegrationProviderSchema,
    IntegrationProviderAuthorizationViewSchema,
  ),
  connections: z.array(IntegrationConnectionSummaryViewSchema).max(500),
  providers: z.array(IntegrationProviderManifestViewSchema).max(16),
});
export type IntegrationDashboard = z.infer<typeof IntegrationDashboardSchema>;

export const SaveIntegrationProviderApplicationSchema = z.strictObject({
  applicationId: IntegrationProviderApplicationIdSchema.optional(),
  availability: z.enum(["personal", "deployment"]).optional(),
  clientId: z.string().trim().min(1).max(2_048),
  displayName: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().positive().nullable(),
  installationUrl: z.url().nullable().optional(),
  provider: IntegrationProviderSchema,
  secrets: z.record(z.string().max(64), z.string().min(1).max(65_536)),
});
export type SaveIntegrationProviderApplication = z.infer<
  typeof SaveIntegrationProviderApplicationSchema
>;

export const SetIntegrationProviderApplicationStatusSchema = z.strictObject({
  applicationId: IntegrationProviderApplicationIdSchema.optional(),
  expectedRevision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]),
});

export const SetIntegrationApplicationSourceDefaultSchema = z.strictObject({
  applicationSource: z.enum(["hosted-oauth", "deployment-oauth"]),
});

export const BeginIntegrationAuthorizationSchema = z
  .strictObject({
    applicationSource: z.enum(["hosted-oauth", "deployment-oauth"]).optional(),
    exactApplicationSource: IntegrationOAuthApplicationSourceSchema.optional(),
    definitionId: z.string().min(1).max(64),
    returnPath: z
      .string()
      .regex(/^\/(?!\/)(?!.*\\)[^\p{Cc}]*$/u)
      .max(2_048)
      .default("/"),
    surface: z.enum(["desktop", "native", "web"]),
  })
  .superRefine((value, context) => {
    if (value.applicationSource && value.exactApplicationSource) {
      context.addIssue({
        code: "custom",
        message: "Choose either a legacy source kind or one exact application source",
      });
    }
  });

export const IntegrationAuthorizationAttemptIdSchema = z.union([
  IntegrationOAuthAttemptIdSchema,
  McpOAuthAttemptIdSchema,
]);
export const IntegrationAuthorizationStartSchema = z.strictObject({
  attemptId: IntegrationAuthorizationAttemptIdSchema,
  expiresAt: IsoDateTimeSchema,
  launchTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export const IntegrationAuthorizationStartViewSchema = z.object(
  IntegrationAuthorizationStartSchema.shape,
);
export type IntegrationAuthorizationStart = z.infer<typeof IntegrationAuthorizationStartSchema>;

export const IntegrationAuthorizationStatusSchema = z.strictObject({
  connectionId: IntegrationConnectionIdSchema.nullable(),
  expiresAt: IsoDateTimeSchema,
  /** Safe machine-readable failure reason; unknown future broker codes remain valid. */
  failureCode: z.string().trim().min(1).max(128).nullable(),
  status: z.enum(["pending", "launched", "completed", "denied", "failed", "cancelled", "expired"]),
});
export const IntegrationAuthorizationStatusViewSchema = z.object(
  IntegrationAuthorizationStatusSchema.shape,
);
export type IntegrationAuthorizationStatus = z.infer<typeof IntegrationAuthorizationStatusSchema>;

const IntegrationSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);

export const IntegrationTrustSchema = z.enum([
  "built-in",
  "verified-publisher",
  "administrator-approved",
]);

export const IntegrationConnectionRequirementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    definitionId: z.string().min(1).max(64),
    kind: z.literal("provider"),
    provider: IntegrationProviderSchema,
    providerApplicationRequired: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("mcp-oauth") }),
  z.strictObject({
    definitionId: z.string().min(1).max(64),
    kind: z.literal("computer"),
  }),
]);
export const IntegrationConnectionRequirementViewSchema = z.discriminatedUnion("kind", [
  z.object(IntegrationConnectionRequirementSchema.options[0].shape),
  z.object(IntegrationConnectionRequirementSchema.options[1].shape),
  z.object(IntegrationConnectionRequirementSchema.options[2].shape),
  z.object(IntegrationConnectionRequirementSchema.options[3].shape),
]);
export type IntegrationConnectionRequirement = z.infer<
  typeof IntegrationConnectionRequirementSchema
>;

export const IntegrationReadinessCodeSchema = z.enum([
  "READY",
  "ADMIN_CONFIGURATION_REQUIRED",
  "USER_AUTHORIZATION_REQUIRED",
  "REAUTHORIZATION_REQUIRED",
  "ACCESS_GRANT_REQUIRED",
  "INTEGRATION_UNAVAILABLE",
]);

export const IntegrationAccessSchema = z.enum(["read", "read-write"]);
export type IntegrationAccess = z.infer<typeof IntegrationAccessSchema>;

export const IntegrationReadinessSchema = z
  .strictObject({
    code: IntegrationReadinessCodeSchema,
    connectionId: IntegrationConnectionIdSchema.nullable(),
    detail: z.string().trim().min(1).max(1_000).nullable(),
    provider: IntegrationProviderSchema.nullable(),
    requiredAccess: IntegrationAccessSchema.nullable(),
    serverId: IntegrationServerIdSchema,
  })
  .superRefine((readiness, context) => {
    if ((readiness.code === "ACCESS_GRANT_REQUIRED") !== (readiness.requiredAccess !== null)) {
      context.addIssue({
        code: "custom",
        message: "requiredAccess is present exactly when an access grant is required",
        path: ["requiredAccess"],
      });
    }
  });
export type IntegrationReadiness = z.infer<typeof IntegrationReadinessSchema>;

export const IntegrationInstallationSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  description: z.string().max(4_096),
  id: IntegrationInstallationIdSchema,
  manifest: JsonObjectSchema,
  name: IntegrationSlugSchema,
  provenance: JsonObjectSchema,
  revision: z.number().int().positive(),
  sourceKind: z.enum(["agent-plugin", "built-in", "proposed", "remote-mcp"]),
  status: z.enum(["active", "disabled", "needs-attention"]),
  title: z.string().trim().min(1).max(160),
  trust: IntegrationTrustSchema,
  updatedAt: IsoDateTimeSchema,
  version: z.string().max(160).nullable(),
});
export const IntegrationInstallationViewSchema = z.object(IntegrationInstallationSchema.shape);
export type IntegrationInstallation = z.infer<typeof IntegrationInstallationSchema>;

const localMcpLaunchShapes = {
  stdio: {
    args: z.array(z.string().max(32_768)).max(256),
    command: z.string().min(1).max(4_096),
    cwd: z.string().min(1).max(4_096),
    env: z.record(z.string().max(256), z.string().max(32_768)),
    type: z.literal("stdio"),
  },
  http: {
    headers: z.record(z.string().max(256), z.string().max(8_192)),
    type: z.literal("streamable-http"),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
      );
    }, "A computer's own MCP server listens on its loopback"),
  },
} as const;

/**
 * An MCP server one computer runs: a program it starts, or a server already
 * listening on its own loopback. Only that computer can reach either, so the
 * Host never does; the computer runs exactly this, as its owner approved it
 * there (`docs/computers.md`, "MCP servers on a computer").
 */
export const LocalMcpLaunchSchema = z.discriminatedUnion("type", [
  z.strictObject(localMcpLaunchShapes.stdio),
  z.strictObject(localMcpLaunchShapes.http),
]);
export type LocalMcpLaunch = z.infer<typeof LocalMcpLaunchSchema>;
export const LocalMcpLaunchViewSchema = z.discriminatedUnion("type", [
  z.object(localMcpLaunchShapes.stdio),
  z.object(localMcpLaunchShapes.http),
]);

export const IntegrationServerTransportSchema = z.discriminatedUnion("type", [
  z.strictObject({
    adapter: IntegrationAdapterKindSchema.exclude(["computer"]),
    definitionId: z.string().min(1).max(64),
    type: z.literal("adapter"),
  }),
  z.strictObject({
    launch: LocalMcpLaunchSchema,
    /**
     * The computer that runs it. Null only for a server carried over from a
     * Host that ran it itself and had no Main computer to move it to.
     */
    runnerId: RunnerIdSchema.nullable(),
    type: z.literal("runner"),
  }),
  z.strictObject({
    headers: z.record(z.string().max(256), z.string().max(8_192)),
    type: z.literal("streamable-http"),
    url: z.url(),
  }),
  z.strictObject({
    definitionId: z.string().min(1).max(64),
    type: z.literal("computer"),
  }),
]);

export const IntegrationServerSchema = z.strictObject({
  connectionRequirement: IntegrationConnectionRequirementSchema,
  id: IntegrationServerIdSchema,
  installationId: IntegrationInstallationIdSchema,
  name: McpIdentifierSchema,
  status: z.enum(["active", "disabled", "needs-attention"]),
  statusDetail: z.string().trim().min(1).max(1_000).nullable(),
  toolGeneration: z.number().int().nonnegative(),
  transport: IntegrationServerTransportSchema,
  updatedAt: IsoDateTimeSchema,
});
export type IntegrationServer = z.infer<typeof IntegrationServerSchema>;

export const IntegrationServerSummarySchema = IntegrationServerSchema.omit({ transport: true })
  .extend({
    transportType: z.enum(["adapter", "computer", "runner", "streamable-http"]),
  })
  .strict();
const IntegrationServerSummaryViewSchema = z.object({
  ...IntegrationServerSummarySchema.shape,
  connectionRequirement: IntegrationConnectionRequirementViewSchema,
});
export type IntegrationServerSummary = z.infer<typeof IntegrationServerSummarySchema>;

/**
 * A tool as the platform lists it. Its schemas are absent: an API's types can
 * run to megabytes, and only describing one tool ever needs them.
 */
export const IntegrationToolSchema = z.strictObject({
  annotations: JsonObjectSchema,
  connectionId: IntegrationConnectionIdSchema.nullable(),
  description: z.string().max(16_384),
  id: IntegrationToolIdSchema,
  name: McpIdentifierSchema,
  schemaDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  serverId: IntegrationServerIdSchema,
  status: z.enum(["active", "disabled"]),
  title: z.string().trim().min(1).max(160),
});
const IntegrationToolViewSchema = z.object(IntegrationToolSchema.shape);
export type IntegrationTool = z.infer<typeof IntegrationToolSchema>;

/**
 * What a materialization writes for one tool. Its schemas may reference the
 * definitions its catalog shares as `#/$defs/<name>`; the store derives the
 * tool's definition closure and `schemaDigest` itself, so no writer can store
 * a digest that disagrees with what describe returns.
 */
export const IntegrationToolMaterialSchema = IntegrationToolSchema.omit({
  schemaDigest: true,
  serverId: true,
})
  .extend({
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.nullable(),
    /** What a call runs, for an adapter that plans its tools' names (`AdapterToolDefinition`). */
    target: JsonObjectSchema.optional(),
  })
  .strict();
export type IntegrationToolMaterial = z.infer<typeof IntegrationToolMaterialSchema>;

/**
 * One scope's tools — a server's own, or those one connection discovered on
 * it — and the JSON Schema definitions they share, each stored once.
 */
export interface IntegrationToolCatalog {
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tools: readonly IntegrationToolMaterial[];
}

export const IntegrationSkillSchema = z.strictObject({
  description: z.string().trim().min(1).max(1_024),
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  id: IntegrationSkillIdSchema,
  installationId: IntegrationInstallationIdSchema,
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(64),
  status: z.enum(["active", "disabled"]),
  updatedAt: IsoDateTimeSchema,
});
const IntegrationSkillViewSchema = z.object(IntegrationSkillSchema.shape);
export type IntegrationSkill = z.infer<typeof IntegrationSkillSchema>;

export const IntegrationGrantSchema = z.strictObject({
  access: IntegrationAccessSchema,
  alias: z.string().trim().min(1).max(80),
  connectionId: IntegrationConnectionIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  id: IntegrationGrantIdSchema,
  installationId: IntegrationInstallationIdSchema,
  isDefault: z.boolean(),
  ownerUserId: z.string().regex(/^usr_[0-9a-f-]{36}$/i),
  revokedAt: IsoDateTimeSchema.nullable(),
  status: z.enum(["active", "revoked"]),
  workspaceId: z.string().regex(/^wsp_[0-9a-f-]{36}$/i),
});
export const IntegrationGrantViewSchema = z.object(IntegrationGrantSchema.shape);
export type IntegrationGrant = z.infer<typeof IntegrationGrantSchema>;

const localMcpServerSetupShape = {
  installationTitle: z.string().trim().min(1).max(160),
  name: McpIdentifierSchema,
  serverId: IntegrationServerIdSchema,
} as const;

/** An installed MCP server a Mac is asked to run, exactly as it will run it. */
export const LocalMcpServerSetupSchema = z.strictObject({
  ...localMcpServerSetupShape,
  launch: LocalMcpLaunchSchema,
});
export type LocalMcpServerSetup = z.infer<typeof LocalMcpServerSetupSchema>;

/**
 * A durable request to review access on its own computer. It never starts an
 * agent. `definitionId` names what is approved: a catalog definition, or for
 * `kind: "server"` the installed MCP server, whose launch `definitionDigest`
 * pins (`localMcpLaunchDigest`).
 */
const computerAppSetupRequestShapeSchema = z.strictObject({
  id: z.uuid(),
  deploymentId: DeploymentIdSchema,
  ownerUserId: UserIdSchema,
  runnerId: RunnerIdSchema,
  definitionId: z.string().min(1).max(64),
  definitionDigest: z.string().min(1).max(128),
  access: IntegrationAccessSchema,
  kind: z.enum(["app", "policy", "server"]),
  policyAppApproval: z.literal("automatic").nullable(),
  app: ComputerAppIdentitySchema.nullable(),
  /** Only a `kind: "server"` request names one; every other kind has none. */
  server: LocalMcpServerSetupSchema.nullable().default(null),
  reason: z.string().max(requestReasonMaxLength).nullable(),
  threadId: ThreadIdSchema.nullable(),
  workspaceId: WorkspaceIdSchema.nullable(),
  /** The name the panel shows, fixed when this request was created. */
  workspaceName: z.string().min(1).max(160).nullable(),
  threadTitle: z.string().max(240).nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
function validComputerAppSetupKind(request: {
  readonly access: IntegrationAccess;
  readonly app: unknown;
  readonly definitionId: string;
  readonly kind: "app" | "policy" | "server";
  readonly policyAppApproval: "automatic" | null;
  readonly server: { readonly serverId: string } | null;
}): boolean {
  if (request.kind === "server") {
    return (
      request.server !== null &&
      request.definitionId === request.server.serverId &&
      request.app === null &&
      request.policyAppApproval === null &&
      request.access === "read-write"
    );
  }
  if (request.server !== null) return false;
  return request.kind === "app"
    ? request.policyAppApproval === null
    : request.policyAppApproval === "automatic" &&
        request.app === null &&
        request.definitionId === "macos-app" &&
        request.access === "read-write";
}
export const ComputerAppSetupRequestSchema = computerAppSetupRequestShapeSchema.refine(
  validComputerAppSetupKind,
  "Setup request scope must match its kind",
);
export const ComputerAppSetupRequestViewSchema = z
  .object({
    ...computerAppSetupRequestShapeSchema.shape,
    app: ComputerAppIdentityViewSchema.nullable(),
    server: z
      .object({ ...localMcpServerSetupShape, launch: LocalMcpLaunchViewSchema })
      .nullable()
      .default(null),
  })
  .refine(validComputerAppSetupKind, "Setup request scope must match its kind");
export type ComputerAppSetupRequest = z.infer<typeof ComputerAppSetupRequestSchema>;

/** A short-lived signature over the entire Host-issued request plus this expiration. */
export const ComputerAppApprovalSchema = z.strictObject({
  requestId: z.uuid(),
  expiresAt: IsoDateTimeSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type ComputerAppApproval = z.infer<typeof ComputerAppApprovalSchema>;

const computerAppSetupInputSchema = z.strictObject({
  kind: z.literal("app"),
  access: IntegrationAccessSchema,
  app: ComputerAppIdentitySchema.nullable(),
  definitionId: z.string().min(1).max(64),
  runnerId: RunnerIdSchema,
});
const computerPolicySetupInputSchema = z.strictObject({
  kind: z.literal("policy"),
  appApproval: z.literal("automatic"),
  runnerId: RunnerIdSchema,
});
export const RequestComputerAppSetupSchema = z.discriminatedUnion("kind", [
  computerAppSetupInputSchema,
  computerPolicySetupInputSchema,
]);
/**
 * The owner may keep or lower a Mac app's access from any client. Creating,
 * widening or unblocking a Mac app, and turning automatic approval on, require
 * the person's signed answer on that Mac's Runner stream. The owner may also
 * create or widen an Android phone's connection from any client.
 */
export const SetComputerAppConnectionSchema = computerAppSetupInputSchema;
export type SetComputerAppConnection = z.infer<typeof SetComputerAppConnectionSchema>;

/**
 * The key a Mac desktop signs its own approvals with. It is never the
 * computer's Runner key, so the connection that carries agents' work cannot
 * also speak for its owner.
 */
export const RegisterComputerUseApprovalKeySchema = z.strictObject({
  /** Ed25519 SubjectPublicKeyInfo, PEM. */
  publicKey: z
    .string()
    .min(1)
    .max(512)
    .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/u),
  runnerId: RunnerIdSchema,
});
export type RegisterComputerUseApprovalKey = z.infer<typeof RegisterComputerUseApprovalKeySchema>;

/**
 * How a task asks for one app on one Mac, or for a whole Android phone, as an
 * `integration_request` variant.
 *
 * For a Mac, `app` is whatever the model has — a name, a path, or a bundle
 * identifier — because only the Mac can turn that into a
 * `ComputerAppIdentity`, and a model inventing one would name an app nobody
 * resolved; `runnerId` is optional so a Deployment with one Mac needs no id at
 * all. A phone is asked for whole, so it takes no `app` and must be named by
 * its `runnerId`.
 */
export const RequestComputerAppAccessSchema = z
  .strictObject({
    access: IntegrationAccessSchema,
    app: z.string().trim().min(1).max(255).optional(),
    kind: z.literal("computer-app"),
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    runnerId: RunnerIdSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.app === undefined && request.runnerId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Name the app on a Mac, or the phone by its runnerId",
        path: ["app"],
      });
    }
  });
export type RequestComputerAppAccess = z.infer<typeof RequestComputerAppAccessSchema>;

export const IntegrationProposalKindSchema = z.enum(["graphql", "mcp", "openapi"]);
export type IntegrationProposalKind = z.infer<typeof IntegrationProposalKindSchema>;

export const IntegrationProposalSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    content: z
      .string()
      .min(1)
      .max(8 * 1_024 * 1_024),
    type: z.literal("inline"),
  }),
  z.strictObject({
    origin: z.url(),
    type: z.literal("url"),
    url: z.url(),
  }),
]);
export type IntegrationProposalSource = z.infer<typeof IntegrationProposalSourceSchema>;

export const IntegrationProposalSourceSummarySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("inline") }),
  z.strictObject({ origin: z.url(), type: z.literal("url") }),
]);

export const IntegrationProposalCredentialSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  setupUrl: z
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "setupUrl must be an HTTPS URL without credentials"),
});
export const IntegrationProposalCheckSchema = z.strictObject({
  operationId: z.string().trim().min(1).max(256),
  args: JsonObjectSchema.refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4_096,
    "Check arguments must not exceed 4096 bytes",
  ).optional(),
});
/**
 * Text the agent that researched a service wrote about it. It is shown where
 * Opensteer's own words about an integration go, so it is held to one line: no
 * line or paragraph separator, and no control or invisible formatting
 * character that could make it read as something else.
 */
function proposalTextLine(maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "Must be one line of plain text");
}

/** The service's common name, shown as the integration's name. */
export const IntegrationProposalNameSchema = proposalTextLine(80);

/**
 * What the service does, shown under its name. It fits a definition's
 * description, which it becomes.
 */
export const IntegrationProposalDescriptionSchema = proposalTextLine(240);

export const IntegrationProposalManifestSchema = z.strictObject({
  apiKey: ApiKeyDisclosureSchema.optional(),
  credential: IntegrationProposalCredentialSchema.optional(),
  check: IntegrationProposalCheckSchema.optional(),
  name: IntegrationProposalNameSchema.optional(),
  // Proposals stored before agents described them have none.
  description: IntegrationProposalDescriptionSchema.optional(),
  authMethods: z.array(z.enum(["api-key", "mcp-oauth", "none", "oauth"])).max(8),
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  kind: IntegrationProposalKindSchema,
  preview: JsonObjectSchema,
  source: IntegrationProposalSourceSchema,
});
export type IntegrationProposalManifest = z.infer<typeof IntegrationProposalManifestSchema>;

/**
 * What a proposed integration is called on its Request, its review and once
 * installed: the name the agent gave it, else the title its document declares,
 * else the host it was researched from.
 */
export function integrationProposalName(
  proposal: Pick<IntegrationProposalManifest, "kind" | "name" | "preview"> & {
    readonly source: z.infer<typeof IntegrationProposalSourceSummarySchema>;
  },
): string {
  if (proposal.name !== undefined) return proposal.name;
  const title = proposal.preview["title"];
  if (typeof title === "string" && title.trim()) return title.trim().slice(0, 80);
  return proposal.source.type === "url"
    ? new URL(proposal.source.origin).hostname
    : `${proposal.kind} integration`;
}

/**
 * A summary is stored on a Request payload, whose JSON column is bounded, while
 * the document a preview is derived from is not: an adapter preview carries tag,
 * server, and tool-name lists that grow with the document. The preview is
 * therefore projected to a fixed budget wherever a summary is produced, so no
 * document can be inspected cleanly and then fail to be stored. The manifest
 * itself is untouched — it keeps the whole preview in the Request detail table.
 */
export const integrationProposalPreviewMaxSerializedBytes = 8 * 1_024;
const previewStringMaxLength = 240;
const previewCollectionMaxLength = 50;
const previewMaximumDepth = 3;

const BoundedProposalPreviewSchema = JsonObjectSchema.refine(
  (value) => serializedPreviewBytes(value) <= integrationProposalPreviewMaxSerializedBytes,
  `A proposal preview must not exceed ${integrationProposalPreviewMaxSerializedBytes} serialized bytes`,
);

export const IntegrationProposalSummarySchema = IntegrationProposalManifestSchema.omit({
  preview: true,
  source: true,
}).extend({
  preview: BoundedProposalPreviewSchema,
  source: IntegrationProposalSourceSummarySchema,
});
type IntegrationProposalSummary = z.infer<typeof IntegrationProposalSummarySchema>;

export function integrationProposalSummary(
  manifest: IntegrationProposalManifest,
): IntegrationProposalSummary {
  return {
    authMethods: manifest.authMethods,
    ...(manifest.apiKey ? { apiKey: manifest.apiKey } : {}),
    ...(manifest.credential ? { credential: manifest.credential } : {}),
    ...(manifest.check ? { check: manifest.check } : {}),
    ...(manifest.name === undefined ? {} : { name: manifest.name }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    digest: manifest.digest,
    kind: manifest.kind,
    preview: boundedProposalPreview(manifest.preview),
    source:
      manifest.source.type === "inline"
        ? { type: "inline" }
        : { origin: manifest.source.origin, type: "url" },
  };
}

function serializedPreviewBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

/**
 * Scalars are projected first because they are the identity facts an approver
 * reads — a title must never be dropped so that a tag list can fit. Collections
 * are capped, and one that still does not fit the remaining budget is dropped
 * rather than left looking complete; either way `truncated` records it, so a
 * shortened preview is never mistaken for the whole one.
 */
function boundedProposalPreview(
  preview: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const entries = Object.entries(preview);
  const ordered = [
    ...entries.filter(([, value]) => typeof value !== "object" || value === null),
    ...entries.filter(([, value]) => typeof value === "object" && value !== null),
  ];
  const bounded: Record<string, unknown> = {};
  let budget = integrationProposalPreviewMaxSerializedBytes - serializedPreviewBytes({});
  let truncated = false;
  for (const [key, value] of ordered) {
    const projected = boundedPreviewValue(value, 1);
    if (projected.truncated) truncated = true;
    if (projected.value === undefined) continue;
    const cost = serializedPreviewBytes({ [key]: projected.value });
    if (cost > budget) {
      truncated = true;
      continue;
    }
    budget -= cost;
    bounded[key] = projected.value;
  }
  return truncated ? { ...bounded, truncated: true } : bounded;
}

function boundedPreviewValue(
  value: unknown,
  depth: number,
): { readonly truncated: boolean; readonly value: unknown } {
  if (typeof value === "string") {
    return value.length > previewStringMaxLength
      ? { truncated: true, value: value.slice(0, previewStringMaxLength) }
      : { truncated: false, value };
  }
  if (typeof value === "boolean" || value === null) return { truncated: false, value };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { truncated: false, value }
      : { truncated: true, value: undefined };
  }
  if (depth >= previewMaximumDepth || typeof value !== "object") {
    return { truncated: true, value: undefined };
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, previewCollectionMaxLength)
      .map((item) => boundedPreviewValue(item, depth + 1));
    return {
      truncated: value.length > previewCollectionMaxLength || kept.some((item) => item.truncated),
      value: kept.flatMap(({ value: item }) => (item === undefined ? [] : [item])),
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries
    .slice(0, previewCollectionMaxLength)
    .map(([key, item]) => [key, boundedPreviewValue(item, depth + 1)] as const);
  return {
    truncated:
      entries.length > previewCollectionMaxLength || kept.some(([, item]) => item.truncated),
    value: Object.fromEntries(
      kept.flatMap(([key, item]) => (item.value === undefined ? [] : [[key, item.value]])),
    ),
  };
}

/**
 * The immutable input to one administrator-reviewed installation. Catalog
 * presets and researched proposals share the same approval lifecycle, while
 * remaining different trust sources. A catalog request pins both the public
 * definition facts and its full-definition digest so approval can never drift
 * to a newer preset silently.
 */
export const IntegrationInstallManifestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    definition: IntegrationDefinitionSummarySchema,
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    kind: z.literal("catalog"),
  }),
  z.strictObject({
    kind: z.literal("proposal"),
    proposal: IntegrationProposalManifestSchema,
  }),
]);
export type IntegrationInstallManifest = z.infer<typeof IntegrationInstallManifestSchema>;

export const IntegrationInstallManifestSummarySchema = z.discriminatedUnion("kind", [
  IntegrationInstallManifestSchema.options[0],
  z.strictObject({
    kind: z.literal("proposal"),
    proposal: IntegrationProposalSummarySchema,
  }),
]);
export type IntegrationInstallManifestSummary = z.infer<
  typeof IntegrationInstallManifestSummarySchema
>;

/** Catalog consent is also read from JSON Request payloads, outside the Host response graph. */
export const IntegrationInstallManifestSummaryViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...IntegrationInstallManifestSchema.options[0].shape,
    definition: IntegrationDefinitionSummaryViewSchema,
  }),
  z.object(IntegrationInstallManifestSummarySchema.options[1].shape),
]);
export type IntegrationInstallManifestSummaryView = z.infer<
  typeof IntegrationInstallManifestSummaryViewSchema
>;

export const InstallCatalogIntegrationSchema = z.strictObject({
  definitionId: z.string().min(1).max(64),
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

export function integrationInstallManifestSummary(
  manifest: IntegrationInstallManifest,
): IntegrationInstallManifestSummary {
  return manifest.kind === "catalog"
    ? manifest
    : { kind: "proposal", proposal: integrationProposalSummary(manifest.proposal) };
}

export const IntegrationCatalogEntrySchema = z.strictObject({
  definition: IntegrationDefinitionSummarySchema,
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  installationId: IntegrationInstallationIdSchema.nullable(),
});
const IntegrationCatalogEntryViewSchema = z.object({
  ...IntegrationCatalogEntrySchema.shape,
  definition: IntegrationDefinitionSummaryViewSchema,
});
export type IntegrationCatalogEntry = z.infer<typeof IntegrationCatalogEntrySchema>;
export type IntegrationCatalogEntryView = z.infer<typeof IntegrationCatalogEntryViewSchema>;

export const ConnectIntegrationApiKeySchema = z.strictObject({
  authMethodId: z.string().min(1).max(64),
  /**
   * The owner's connection this key reconnects. A key the provider names no
   * account for is otherwise indistinguishable from a new account, so a
   * reconnect has to say which connection it repairs.
   */
  connectionId: IntegrationConnectionIdSchema.optional(),
  definitionId: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(160).optional(),
  values: z.record(z.string().min(1).max(64), z.string().min(1).max(65_536)),
});
export type ConnectIntegrationApiKey = z.infer<typeof ConnectIntegrationApiKeySchema>;

export const IntegrationPlatformDashboardSchema = z.strictObject({
  authorizationSurface: IntegrationAuthorizationSurfaceSchema,
  catalog: z.array(IntegrationCatalogEntrySchema).max(1_000),
  connections: z
    .array(
      z.strictObject({
        accountIdentifier: z.string().trim().min(1).max(320).nullable(),
        connectionId: IntegrationConnectionIdSchema,
        createdAt: IsoDateTimeSchema,
        displayName: z.string().min(1).max(160),
        installationId: IntegrationInstallationIdSchema,
        serverId: IntegrationServerIdSchema,
        status: z.enum(["connected", "needs-attention", "revoked"]),
        updatedAt: IsoDateTimeSchema,
      }),
    )
    .max(1_000),
  installations: z
    .array(
      z.strictObject({
        installation: IntegrationInstallationSchema,
        servers: z.array(IntegrationServerSummarySchema).max(100),
        skills: z.array(IntegrationSkillSchema).max(1_000),
        tools: z.array(IntegrationToolSchema).max(5_000),
      }),
    )
    .max(1_000),
});
export const IntegrationPlatformDashboardViewSchema = z.object({
  ...IntegrationPlatformDashboardSchema.shape,
  catalog: z.array(IntegrationCatalogEntryViewSchema).max(1_000),
  connections: z
    .array(z.object(IntegrationPlatformDashboardSchema.shape.connections.element.shape))
    .max(1_000),
  installations: z
    .array(
      z.object({
        ...IntegrationPlatformDashboardSchema.shape.installations.element.shape,
        installation: IntegrationInstallationViewSchema,
        servers: z.array(IntegrationServerSummaryViewSchema).max(100),
        skills: z.array(IntegrationSkillViewSchema).max(1_000),
        tools: z.array(IntegrationToolViewSchema).max(5_000),
      }),
    )
    .max(1_000),
});
export type IntegrationPlatformDashboard = z.infer<typeof IntegrationPlatformDashboardSchema>;
export type IntegrationPlatformDashboardView = z.infer<
  typeof IntegrationPlatformDashboardViewSchema
>;

export const BeginMcpAuthorizationSchema = z.strictObject({
  requestId: RequestIdSchema,
  displayName: z.string().trim().min(1).max(160),
  returnPath: z
    .string()
    .regex(/^\/(?!\/)(?!.*\\)[^\p{Cc}]*$/u)
    .max(2_048)
    .default("/"),
  serverId: IntegrationServerIdSchema,
  surface: z.enum(["desktop", "native", "web"]),
});

export const InstallAgentPluginSchema = z.strictObject({
  directory: z.string().trim().min(1).max(4_096),
  /**
   * The computer that runs the plugin's servers that start a program or
   * listen on loopback; the Deployment's Main computer when omitted.
   */
  runnerId: RunnerIdSchema.optional(),
});

export const InstallRemoteMcpSchema = z.strictObject({
  description: z.string().trim().max(4_096).default(""),
  name: IntegrationSlugSchema,
  title: z.string().trim().min(1).max(160),
  url: z.url(),
});
export type InstallRemoteMcp = z.infer<typeof InstallRemoteMcpSchema>;

export const CreateIntegrationGrantSchema = z.strictObject({
  access: IntegrationAccessSchema,
  alias: z.string().trim().min(1).max(80),
  connectionId: IntegrationConnectionIdSchema.nullable(),
  installationId: IntegrationInstallationIdSchema,
  isDefault: z.boolean().default(false),
  workspaceId: z.string().regex(/^wsp_[0-9a-f-]{36}$/i),
});
export type CreateIntegrationGrant = z.infer<typeof CreateIntegrationGrantSchema>;
