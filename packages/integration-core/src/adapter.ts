import { z } from "zod";
import { AuthMethodSchema, AuthMethodViewSchema, type AuthPlacement } from "./auth-method.js";
import {
  IntegrationAdapterKindSchema,
  IntegrationDefinitionIdSchema,
  type IntegrationAdapterKind,
} from "./adapter-kind.js";
import type { IntegrationConnectionId } from "./ids.js";
import { IntegrationProviderSchema } from "./identifiers.js";
import {
  ComputerAppConfigSchema,
  ComputerAppPresentationSchema,
  ComputerAppPresentationViewSchema,
  computerAppPresentation,
} from "./computer-app.js";

export { IntegrationAdapterKindSchema, IntegrationDefinitionIdSchema, type IntegrationAdapterKind };

/**
 * A catalog entry: everything Opensteer knows about one external service.
 * Core owns identity, presentation, auth methods, and the computer-app contract.
 * Other `config` values stay adapter-owned and opaque here so adapters can evolve
 * without widening the shared model.
 */
const IntegrationDefinitionBaseSchema = z.strictObject({
  adapter: IntegrationAdapterKindSchema,
  authMethods: z.array(AuthMethodSchema).min(1).max(8),
  config: z.unknown(),
  description: z.string().min(1).max(240),
  hostedOAuth: z
    .strictObject({
      providerApplicationRevision: z.number().int().positive(),
      qualification: z.strictObject({
        authorizationCodeExchange: z.literal(true),
        refresh: z.literal(true),
      }),
    })
    .optional(),
  icon: z.string().min(1).max(2_048).optional(),
  id: IntegrationDefinitionIdSchema,
  name: z.string().min(1).max(80),
  provider: IntegrationProviderSchema,
  setupSteps: z.array(z.string().min(1).max(240)).max(8).optional(),
  setupUrl: z.url().optional(),
});

export const IntegrationDefinitionSchema = IntegrationDefinitionBaseSchema.superRefine(
  (definition, context) => {
    const hasComputerMethod = definition.authMethods.some(({ kind }) => kind === "computer");
    const hasSingleComputerMethod =
      definition.authMethods.length === 1 && definition.authMethods[0]?.kind === "computer";
    if (
      (definition.adapter === "computer" && !hasSingleComputerMethod) ||
      (definition.adapter !== "computer" && hasComputerMethod)
    ) {
      context.addIssue({
        code: "custom",
        message: "A computer definition must declare exactly one computer auth method",
        path: ["authMethods"],
      });
    }
    if (definition.adapter !== "computer") return;
    const parsed = ComputerAppConfigSchema.safeParse(definition.config);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ["config", ...issue.path] });
    }
  },
);
export type IntegrationDefinition = z.infer<typeof IntegrationDefinitionSchema>;

/**
 * Browser-safe catalog facts. Adapter configuration is deliberately absent:
 * it is an internal execution artifact, not part of the installation view.
 */
export const ApiKeyDisclosureSchema = z.strictObject({
  destinations: z.array(z.url()),
  check: z.boolean(),
});
export type ApiKeyDisclosure = z.infer<typeof ApiKeyDisclosureSchema>;

export const IntegrationDefinitionSummarySchema = IntegrationDefinitionBaseSchema.omit({
  config: true,
})
  .extend({
    apiKey: ApiKeyDisclosureSchema.nullable().default(null),
    computerApp: ComputerAppPresentationSchema.optional(),
  })
  .strict();
export const IntegrationDefinitionSummaryViewSchema = z.object({
  ...IntegrationDefinitionSummarySchema.shape,
  apiKey: z.object(ApiKeyDisclosureSchema.shape).nullable().default(null),
  authMethods: z.array(AuthMethodViewSchema).min(1).max(8),
  computerApp: ComputerAppPresentationViewSchema.optional(),
  hostedOAuth: z
    .object({
      ...IntegrationDefinitionSummarySchema.shape.hostedOAuth.unwrap().shape,
      qualification: z.object(
        IntegrationDefinitionSummarySchema.shape.hostedOAuth.unwrap().shape.qualification.shape,
      ),
    })
    .optional(),
});
export type IntegrationDefinitionSummary = z.infer<typeof IntegrationDefinitionSummarySchema>;
export type IntegrationDefinitionSummaryView = z.infer<
  typeof IntegrationDefinitionSummaryViewSchema
>;

export function integrationDefinitionSummary(
  definition: IntegrationDefinition,
  apiKey: ApiKeyDisclosure | null = null,
): IntegrationDefinitionSummary {
  return {
    adapter: definition.adapter,
    apiKey,
    authMethods: definition.authMethods,
    description: definition.description,
    ...(definition.icon === undefined ? {} : { icon: definition.icon }),
    id: definition.id,
    name: definition.name,
    provider: definition.provider,
    ...(definition.adapter === "computer"
      ? { computerApp: computerAppPresentation(ComputerAppConfigSchema.parse(definition.config)) }
      : {}),
    ...(definition.setupSteps === undefined ? {} : { setupSteps: definition.setupSteps }),
    ...(definition.setupUrl === undefined ? {} : { setupUrl: definition.setupUrl }),
  };
}

/** Host-private, immutable adapter input captured when an installation is reconciled. */
export const maximumIntegrationAdapterSnapshotBytes = 8 * 1_024 * 1_024;
export const IntegrationAdapterSnapshotSchema = z
  .strictObject({
    adapter: IntegrationAdapterKindSchema.exclude(["computer"]),
    config: z.record(z.string(), z.unknown()),
    definitionId: IntegrationDefinitionIdSchema,
  })
  .refine(
    (snapshot) =>
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <=
      maximumIntegrationAdapterSnapshotBytes,
    `Integration adapter snapshot exceeds ${maximumIntegrationAdapterSnapshotBytes} bytes`,
  );
export type IntegrationAdapterSnapshot = z.infer<typeof IntegrationAdapterSnapshotSchema>;

/** MCP-shaped tool produced by an adapter from its config (and connection). */
export interface AdapterToolDefinition {
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /**
   * What a call to the tool runs, when its name is planned rather than the
   * operation's own: stored with the tool and given back to `invokeTool`.
   */
  readonly target?: Readonly<Record<string, unknown>>;
}

/**
 * What one discovery yields: the tools, and the JSON Schema definitions they
 * share. A tool's schemas reference a definition as `#/$defs/<name>` and carry
 * no copy of it, so a type every operation uses is stored once, not once per
 * operation that reaches it.
 */
export interface AdapterToolCatalog {
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tools: readonly AdapterToolDefinition[];
}

/**
 * Structured failure vocabulary shared by all adapters. Error results are
 * written for the agent to act on, so codes are specific and carry the data
 * needed to recover.
 */
export type AdapterToolResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | {
      readonly code:
        | "connection_rejected"
        | "invalid_arguments"
        | "oauth_scope_insufficient"
        | "upstream_http_error"
        | "upstream_timeout";
      readonly details?: Readonly<Record<string, unknown>>;
      readonly kind: "error";
      readonly message: string;
    };

interface AdapterIdentity {
  readonly accountIdentifier?: string;
  readonly displayName?: string;
  readonly externalIdentityId: string;
  readonly externalTenantId?: string;
}

export type AdapterHealthResult =
  | { readonly healthy: true; readonly identity?: AdapterIdentity }
  | { readonly detail: string; readonly healthy: false; readonly status?: number };

interface AdapterResolveToolsInput {
  readonly config: unknown;
  /** Present when tools are account-scoped (e.g. MCP servers listing per-connection). */
  readonly connectionId?: IntegrationConnectionId;
  /**
   * Present when discovery itself requires authorization (an MCP server that
   * only lists tools post-auth, a GraphQL API whose introspection is gated).
   * Rendered via `placements` exactly like invocation credentials.
   */
  readonly credentialValues?: Readonly<Record<string, string>>;
  readonly placements?: readonly AuthPlacement[];
}

interface AdapterInvokeToolInput {
  readonly args: Readonly<Record<string, unknown>>;
  readonly config: unknown;
  /**
   * Stable identity for session/pool keying (e.g. one pooled MCP session per
   * connection). Adapters must never key long-lived state on raw credential
   * values when this is present.
   */
  readonly connectionId?: IntegrationConnectionId;
  /** Resolved credential values (variable → secret), rendered via placements by the adapter. */
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly placements: readonly AuthPlacement[];
  /** The target `resolveTools` gave the tool, as stored with it; null when it gave none. */
  readonly target?: Readonly<Record<string, unknown>> | null;
  readonly toolName: string;
}

interface AdapterCheckHealthInput {
  readonly config: unknown;
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly placements: readonly AuthPlacement[];
}

/**
 * The extension point for integrations the Host executes. Computer definitions
 * run through their Runner module instead. One adapter serves every integration
 * of its kind; per-service knowledge lives in definitions, never adapter code.
 * Adapters are stateless — persistence, credential custody, grants, and
 * authorization belong to the platform.
 */
export interface IntegrationAdapter {
  readonly kind: IntegrationAdapterKind;
  /** Validate and normalize adapter-owned config. Throws on invalid config. */
  parseConfig(config: unknown): unknown;
  /** Metadata only: read stored origins and check configuration, without resolving a document. */
  credentialDisclosure(config: unknown): ApiKeyDisclosure | null;
  /** Resolve remote schema material once into the bounded immutable config used at runtime. */
  snapshotConfig(config: unknown): Promise<Readonly<Record<string, unknown>>>;
  /** Verify a credential works and derive the external account identity. */
  checkHealth(input: AdapterCheckHealthInput): Promise<AdapterHealthResult>;
  invokeTool(input: AdapterInvokeToolInput): Promise<AdapterToolResult>;
  resolveTools(input: AdapterResolveToolsInput): Promise<AdapterToolCatalog>;
}
