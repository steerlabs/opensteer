import { catalogContents, type IntegrationDefinition } from "@opensteer/integration-core";
import { catalogPresentation, getIntegrationDefinition } from "@opensteer/integration-catalog";
import type { PluginRow, PluginsDirectoryView } from "@opensteer/protocol";

/**
 * Where the catalog listing meets what a person reads. Stored definitions and
 * installations keep their own names; these views wear the listing's.
 */

/** The name a person reads for a catalog definition. */
export function listedDefinitionName(definition: IntegrationDefinition): string {
  return catalogPresentation(definition)?.title ?? definition.name;
}

/** The catalog as a person browses it: by product, in the listing's order. */
export function settingsCatalogEntries(
  definitions: readonly IntegrationDefinition[],
  added: ReadonlySet<string>,
): PluginsDirectoryView["catalog"] {
  return definitions
    .map((definition) => ({ definition, listed: catalogPresentation(definition) }))
    .sort((a, b) => (a.listed?.rank ?? Infinity) - (b.listed?.rank ?? Infinity))
    .map(({ definition, listed }) => ({
      definitionId: definition.id,
      title: listed?.title ?? definition.name,
      description: definition.description,
      added: added.has(definition.id),
      ...catalogContents(definition),
      ...(listed
        ? {
            product: {
              id: listed.productId,
              title: listed.productName,
              category: listed.category,
              popular: listed.popular,
            },
            ...(listed.variant ? { variant: listed.variant } : {}),
          }
        : {}),
    }));
}

/**
 * A built-in service is stored under its definition's own name; a person sees
 * the listing's. An agent-proposed one keeps the name it was given.
 */
export function listedPluginRow(row: PluginRow): PluginRow {
  if (
    row.source.kind !== "built-in" ||
    (row.target.kind !== "service" && row.target.kind !== "device-app")
  )
    return row;
  const definition = getIntegrationDefinition(row.target.definitionId);
  return definition ? { ...row, title: listedDefinitionName(definition) } : row;
}
