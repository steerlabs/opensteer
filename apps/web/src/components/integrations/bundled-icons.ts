import appleMessages from "@opensteer/client/assets/integrations/apple-messages.png?url";
import type { BundledIntegrationIconId } from "@opensteer/client/integrations";

/**
 * This build's copy of each finished tile the tree ships.
 *
 * The record is keyed by the shared list, so adding an id there without adding
 * its artwork here does not compile. Nothing is fetched from a Host or a third
 * party: the bytes are part of this bundle.
 */
export const bundledIntegrationArt: Readonly<Record<BundledIntegrationIconId, string>> = {
  "apple-messages": appleMessages,
};
