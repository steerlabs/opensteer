import appleMessages from "@opensteer/client/assets/integrations/apple-messages.png?url";
import {
  bundledIntegrationIcon,
  type BundledIntegrationIconId,
} from "@opensteer/client/integrations";

/**
 * This build's copy of each integration mark the tree ships.
 *
 * The record is keyed by the shared list, so adding an id there without adding
 * its artwork here does not compile. Nothing is fetched from a Host or a third
 * party: the bytes are part of this bundle.
 */
const bundledIcons: Readonly<Record<BundledIntegrationIconId, string>> = {
  "apple-messages": appleMessages,
};

export function bundledIntegrationIconUrl(definitionId: string): string | null {
  const id = bundledIntegrationIcon(definitionId);
  return id === null ? null : bundledIcons[id];
}
