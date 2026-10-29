/**
 * The integrations this tree ships artwork for.
 *
 * An app on a computer has no icon URL to fetch — it is the product's own mark,
 * and asking a Host or a third party for it at render time would make a
 * person's integrations page describe them to somebody else. The bytes live in
 * `packages/client/assets/integrations`, and each client binds this id to its
 * own bundle so there is one list and no per-surface guess about which
 * integrations have a mark.
 */
export const bundledIntegrationIconIds = ["apple-messages"] as const;

export type BundledIntegrationIconId = (typeof bundledIntegrationIconIds)[number];

export function bundledIntegrationIcon(definitionId: string): BundledIntegrationIconId | null {
  return (
    bundledIntegrationIconIds.find(
      (candidate): candidate is BundledIntegrationIconId => candidate === definitionId,
    ) ?? null
  );
}
