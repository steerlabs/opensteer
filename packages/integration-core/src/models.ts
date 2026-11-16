import { z } from "zod";
import { JsonObjectSchema, McpIdentifierSchema } from "./schema-primitives.js";
import { RunnerIdSchema, isLoopbackHostname } from "@opensteer/core";
import { IntegrationAdapterKindSchema } from "./adapter-kind.js";
import { ComputerAppIdentitySchema, ComputerAppIdentityViewSchema } from "./computer-app.js";
import { IntegrationProviderSchema } from "./identifiers.js";
import {
  IntegrationConnectionIdSchema,
  IntegrationGrantIdSchema,
  IntegrationInstallationIdSchema,
  IntegrationProviderApplicationIdSchema,
  IntegrationServerIdSchema,
  IntegrationToolIdSchema,
} from "./ids.js";
import { IntegrationAccessSchema } from "./access.js";
import { LocalMcpLaunchSchema } from "./local-mcp.js";

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
export const IntegrationOAuthApplicationSourceViewSchema = z.discriminatedUnion("kind", [
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
export const IntegrationApplicationSourceViewSchema = z.discriminatedUnion("kind", [
  ...IntegrationOAuthApplicationSourceViewSchema.options,
  z.object(IntegrationApplicationSourceSchema.options[2].shape),
  z.object(IntegrationApplicationSourceSchema.options[3].shape),
]);
export type IntegrationApplicationSource = z.infer<typeof IntegrationApplicationSourceSchema>;

const IntegrationDeploymentPostureSchema = z.enum([
  "account-linked-personal",
  "account-free-personal",
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
  readonly personalAccountLinked: boolean;
}): IntegrationDeploymentPosture {
  return input.personalAccountLinked ? "account-linked-personal" : "account-free-personal";
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
export const IntegrationProviderAuthorizationViewSchema = z
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

export const IntegrationSlugSchema = z
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
  pluginId: z.string().nullable().optional(),
  sourceKind: z.enum(["plugin", "built-in", "proposed", "remote-mcp"]),
  status: z.enum(["active", "disabled", "needs-attention"]),
  title: z.string().trim().min(1).max(160),
  trust: IntegrationTrustSchema,
  updatedAt: IsoDateTimeSchema,
  version: z.string().max(160).nullable(),
});
export const IntegrationInstallationViewSchema = z.object(IntegrationInstallationSchema.shape);
export type IntegrationInstallation = z.infer<typeof IntegrationInstallationSchema>;

export const PluginDeviceKindSchema = z.enum(["tv", "speaker", "light", "camera", "other"]);
export type PluginDeviceKind = z.infer<typeof PluginDeviceKindSchema>;
/**
 * The physical thing an agent-built plugin controls, such as a TV its server
 * reaches over the home network. The plugin's author writes it, so it only
 * decides where the plugin is listed; it never grants or proves anything.
 */
export const PluginDeviceSchema = z.strictObject({
  kind: PluginDeviceKindSchema,
  name: z.string().trim().min(1).max(80),
});
export type PluginDevice = z.infer<typeof PluginDeviceSchema>;
export const PluginDeviceViewSchema = z.object(PluginDeviceSchema.shape);

/** The device a stored plugin manifest declares, or null when it declares none. */
export function pluginDeviceFromManifest(manifest: unknown): PluginDevice | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const extensions = (manifest as { extensions?: unknown }).extensions;
  if (typeof extensions !== "object" || extensions === null) return null;
  const opensteer = (extensions as Record<string, unknown>)["com.opensteer"];
  if (typeof opensteer !== "object" || opensteer === null) return null;
  const parsed = PluginDeviceSchema.safeParse((opensteer as { device?: unknown }).device);
  return parsed.success ? parsed.data : null;
}

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
export const IntegrationServerSummaryViewSchema = z.object({
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
export const IntegrationToolViewSchema = z.object(IntegrationToolSchema.shape);
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
});
export const IntegrationGrantViewSchema = z.object(IntegrationGrantSchema.shape);
export type IntegrationGrant = z.infer<typeof IntegrationGrantSchema>;

export const CreateIntegrationGrantSchema = z.strictObject({
  access: IntegrationAccessSchema,
  alias: z.string().trim().min(1).max(80),
  connectionId: IntegrationConnectionIdSchema.nullable(),
  installationId: IntegrationInstallationIdSchema,
  isDefault: z.boolean().default(false),
});
export type CreateIntegrationGrant = z.infer<typeof CreateIntegrationGrantSchema>;
