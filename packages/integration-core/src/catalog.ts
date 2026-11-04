import { z } from "zod";
import { integrationDefinitionSummary } from "./adapter.js";
import type { IntegrationDefinition } from "./adapter.js";
import { IntegrationProviderManifestSchema, type IntegrationProviderManifest } from "./models.js";

/**
 * Dashboard provider metadata is a projection of the authoritative definition.
 * API-key-only definitions have no administrator-owned provider application and
 * therefore do not appear in the provider-application dashboard.
 */
export function integrationDefinitionToProviderManifest(
  definition: IntegrationDefinition,
): IntegrationProviderManifest | null {
  const oauth = definition.authMethods.find((method) => method.kind === "oauth");
  if (!oauth) return null;
  if (!definition.setupUrl) {
    throw new Error(`OAuth definition ${definition.id} requires setupUrl`);
  }
  return IntegrationProviderManifestSchema.parse({
    description: definition.description,
    hostedOAuthCapable: definition.hostedOAuth !== undefined,
    ...(definition.provider === "github" ? { installationUrlRequired: true } : {}),
    label: definition.name,
    provider: definition.provider,
    secretFields: oauth.oauth.clientAuth === "none" ? [] : ["clientSecret"],
    setupLabel: `${definition.name} OAuth application`,
    setupSteps: definition.setupSteps ?? [
      `Create an OAuth application for ${definition.name}.`,
      "Add the callback URL shown by Opensteer.",
      "Copy the client ID and requested client secret into Opensteer.",
    ],
    setupUrl: definition.setupUrl,
  });
}

export function integrationDefinitionsToProviderManifests(
  definitions: readonly IntegrationDefinition[],
): readonly IntegrationProviderManifest[] {
  const manifests = new Map<string, IntegrationProviderManifest>();
  for (const definition of definitions) {
    const candidate = integrationDefinitionToProviderManifest(definition);
    if (!candidate) continue;
    const current = manifests.get(candidate.provider);
    if (!current) {
      manifests.set(candidate.provider, candidate);
      continue;
    }
    if (
      current.setupUrl !== candidate.setupUrl ||
      JSON.stringify(current.secretFields) !== JSON.stringify(candidate.secretFields)
    ) {
      throw new Error(
        `OAuth definitions for ${candidate.provider} must share one provider application posture`,
      );
    }
    manifests.set(candidate.provider, current);
  }
  return [...manifests.values()];
}

// Remote providers may discover additional tools only after authentication. The
// directory describes the declared tool set without contacting those providers.
export function catalogContents(definition: IntegrationDefinition) {
  const summary = integrationDefinitionSummary(definition);
  const config = z
    .object({
      operationFilter: z
        .object({
          include: z.array(
            z.union([z.string(), z.object({ operationId: z.array(z.string()).optional() })]),
          ),
        })
        .optional(),
      operations: z.object({ include: z.array(z.string()).optional() }).optional(),
    })
    .safeParse(definition.config);
  const operations =
    summary.computerApp?.operations.map(({ name }) => name) ??
    (config.success
      ? (config.data.operationFilter?.include.flatMap((item) =>
          typeof item === "string" ? [item] : (item.operationId ?? []),
        ) ?? config.data.operations?.include)
      : undefined);
  return {
    contents: operations?.length
      ? operations.map((name) => ({ name, kind: "tool" as const }))
      : [{ name: `${definition.name} tools (provider-discovered)`, kind: "tool" as const }],
    access: summary.computerApp
      ? [summary.computerApp.accessSummaries.read, summary.computerApp.accessSummaries.readWrite]
      : definition.authMethods.flatMap((method) =>
          method.kind === "oauth" ? method.oauth.scopes : [method.label],
        ),
  };
}
