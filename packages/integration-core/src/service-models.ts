import { z } from "zod";
import { JsonObjectSchema } from "./schema-primitives.js";
import { RequestIdSchema, RunnerIdSchema, UserIdSchema } from "@opensteer/core";
import {
  ApiKeyDisclosureSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationDefinitionSummaryViewSchema,
} from "./adapter.js";
import { IntegrationProviderSchema } from "./identifiers.js";
import {
  IntegrationConnectionIdSchema,
  IntegrationInstallationIdSchema,
  IntegrationOAuthAttemptIdSchema,
  IntegrationProviderApplicationIdSchema,
  IntegrationServerIdSchema,
  McpOAuthAttemptIdSchema,
} from "./ids.js";
import {
  IntegrationApplicationSourceSchema,
  IntegrationAuthorizationSurfaceSchema,
  IntegrationConnectionSummarySchema,
  IntegrationConnectionSummaryViewSchema,
  IntegrationInstallationSchema,
  IntegrationInstallationViewSchema,
  IntegrationOAuthApplicationSourceSchema,
  IntegrationProviderAuthorizationSchema,
  IntegrationProviderAuthorizationViewSchema,
  IntegrationServerSummarySchema,
  IntegrationServerSummaryViewSchema,
  IntegrationSlugSchema,
  IntegrationToolSchema,
  IntegrationToolViewSchema,
  providerAuthorizationIncludesSource,
  type IntegrationApplicationSource,
  type IntegrationDeploymentPosture,
  type IntegrationProviderAuthorization,
} from "./models.js";

/** Service integrations: provider applications, sign-in flows, proposals and installs. */
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

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
 * Credential use pins the selected app and revision. The callback belongs to
 * the original consent; changing the next consent callback keeps existing grants usable.
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
  if (source.kind === "deployment-oauth") {
    // A callback pins consent, not an existing grant's use or refresh. Relinking
    // the Deployment must not invalidate credentials for the same registered app.
    return (
      input.authorization?.availableSources.some(
        (candidate) =>
          candidate.kind === "deployment-oauth" &&
          candidate.providerApplicationId === source.providerApplicationId &&
          candidate.providerApplicationRevision === source.providerApplicationRevision,
      ) ?? false
    );
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

/**
 * `app`: the consent finishes in the app that started it, which returns the
 * browser's one-use proof to its own Host. Only apps can receive that return;
 * a browser-only client stays proven by its Account sign-in.
 */
export const IntegrationAuthorizationFinishSchema = z.literal("app");

/**
 * The ports a desktop app may receive its browser return on. A hostile Host
 * chooses this value for its own attempts, so it may only name these reserved
 * ports, never a service a person happens to run on their computer.
 */
export const integrationAuthorizationReturnPorts = { first: 48_200, last: 48_215 } as const;
export const IntegrationAuthorizationReturnPortSchema = z
  .number()
  .int()
  .min(integrationAuthorizationReturnPorts.first)
  .max(integrationAuthorizationReturnPorts.last);

function refineIntegrationAuthorizationFinish(
  value: {
    readonly appReturnPort?: number | undefined;
    readonly finish?: "app" | undefined;
    readonly surface: "desktop" | "native" | "web";
  },
  context: z.RefinementCtx,
): void {
  if (value.finish === "app" && value.surface === "web") {
    context.addIssue({
      code: "custom",
      message: "Only desktop and native apps can finish an authorization",
      path: ["finish"],
    });
  }
  if (
    value.appReturnPort !== undefined &&
    (value.finish !== "app" || value.surface !== "desktop")
  ) {
    context.addIssue({
      code: "custom",
      message: "Only a desktop app finish can return to a port",
      path: ["appReturnPort"],
    });
  }
}

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
    finish: IntegrationAuthorizationFinishSchema.optional(),
    appReturnPort: IntegrationAuthorizationReturnPortSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.applicationSource && value.exactApplicationSource) {
      context.addIssue({
        code: "custom",
        message: "Choose either a legacy source kind or one exact application source",
      });
    }
    refineIntegrationAuthorizationFinish(value, context);
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
        tools: z.array(IntegrationToolViewSchema).max(5_000),
      }),
    )
    .max(1_000),
});
export type IntegrationPlatformDashboard = z.infer<typeof IntegrationPlatformDashboardSchema>;
export type IntegrationPlatformDashboardView = z.infer<
  typeof IntegrationPlatformDashboardViewSchema
>;

export const BeginMcpAuthorizationSchema = z
  .strictObject({
    requestId: RequestIdSchema,
    displayName: z.string().trim().min(1).max(160),
    returnPath: z
      .string()
      .regex(/^\/(?!\/)(?!.*\\)[^\p{Cc}]*$/u)
      .max(2_048)
      .default("/"),
    serverId: IntegrationServerIdSchema,
    surface: z.enum(["desktop", "native", "web"]),
    finish: IntegrationAuthorizationFinishSchema.optional(),
    appReturnPort: IntegrationAuthorizationReturnPortSchema.optional(),
  })
  .superRefine(refineIntegrationAuthorizationFinish);

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
