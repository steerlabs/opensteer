import {
  IntegrationDefinitionSchema,
  type AuthMethodInput,
  type AuthPlacement,
  type IntegrationDefinition,
} from "@opensteer/integration-core";

interface ApiKeyPreset {
  readonly baseUrl?: string;
  readonly description: string;
  readonly healthCheck: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly inputs: readonly AuthMethodInput[];
  readonly name: string;
  readonly placements: readonly AuthPlacement[];
  readonly provider: string;
  readonly readOnlyOperationIds?: readonly string[];
  readonly setupUrl: string;
  readonly specOverrides?: readonly Readonly<Record<string, unknown>>[];
  readonly specUrl: string;
}

export function apiKeyOpenApiPreset(preset: ApiKeyPreset): IntegrationDefinition {
  return IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    authMethods: [
      {
        id: "api-key",
        inputs: preset.inputs,
        kind: "api-key",
        label: `${preset.name} credentials`,
        placements: preset.placements,
      },
    ],
    config: {
      ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
      healthCheck: preset.healthCheck,
      ...(preset.readOnlyOperationIds ? { readOnlyOperationIds: preset.readOnlyOperationIds } : {}),
      ...(preset.specOverrides ? { specOverrides: preset.specOverrides } : {}),
      specUrl: preset.specUrl,
    },
    description: preset.description,
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
    setupUrl: preset.setupUrl,
  });
}

interface ApiKeyGraphqlPreset {
  readonly description: string;
  readonly endpoint: string;
  readonly healthCheck: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly inputs: readonly AuthMethodInput[];
  readonly name: string;
  readonly placements: readonly AuthPlacement[];
  readonly provider: string;
  readonly setupUrl: string;
}

export function apiKeyGraphqlPreset(preset: ApiKeyGraphqlPreset): IntegrationDefinition {
  return IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "api-key",
        inputs: preset.inputs,
        kind: "api-key",
        label: `${preset.name} credentials`,
        placements: preset.placements,
      },
    ],
    config: {
      endpoint: preset.endpoint,
      healthCheck: preset.healthCheck,
    },
    description: preset.description,
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
    setupUrl: preset.setupUrl,
  });
}

export function publicGraphqlPreset(preset: {
  readonly description: string;
  readonly endpoint: string;
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}): IntegrationDefinition {
  return IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
    config: { endpoint: preset.endpoint },
    description: preset.description,
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
  });
}

interface McpPreset {
  readonly auth:
    | { readonly kind: "none" }
    | {
        readonly inputs: readonly AuthMethodInput[];
        readonly kind: "api-key";
        readonly placements: readonly AuthPlacement[];
      }
    | { readonly kind: "mcp-oauth" };
  readonly description: string;
  readonly endpoint: string;
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly setupUrl?: string;
}

export function remoteMcpPreset(preset: McpPreset): IntegrationDefinition {
  const authMethod =
    preset.auth.kind === "none"
      ? { id: "none", kind: "none", label: "No authentication" }
      : preset.auth.kind === "mcp-oauth"
        ? { id: "mcp-oauth", kind: "mcp-oauth", label: `Connect ${preset.name}` }
        : {
            id: "api-key",
            inputs: preset.auth.inputs,
            kind: "api-key",
            label: `${preset.name} credentials`,
            placements: preset.auth.placements,
          };
  return IntegrationDefinitionSchema.parse({
    adapter: "mcp",
    authMethods: [authMethod],
    config: {
      endpoint: preset.endpoint,
      transport: "remote",
    },
    description: preset.description,
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
    ...(preset.setupUrl ? { setupUrl: preset.setupUrl } : {}),
  });
}

export const secretInput = (label: string, variable = "apiKey"): AuthMethodInput => ({
  label,
  secret: true,
  variable,
});

export const bearerApiKey: readonly AuthPlacement[] = [
  { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
];
