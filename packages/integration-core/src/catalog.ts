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
