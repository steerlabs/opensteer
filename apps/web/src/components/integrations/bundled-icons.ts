// Service SVG marks: Simple Icons (CC0), https://github.com/simple-icons/simple-icons.
import slack from "./icons/slack.svg?url";
import notion from "./icons/notion.svg?url";
import linear from "./icons/linear.svg?url";
import googlecalendar from "./icons/googlecalendar.svg?url";
import github from "./icons/github.svg?url";
import gmail from "./icons/gmail.svg?url";
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
  const serviceIcons: Readonly<Record<string, string>> = {
    "google-gmail": gmail,
    github: github,
    "github-rest": github,
    "google-calendar": googlecalendar,
    linear: linear,
    notion: notion,
    slack: slack,
  };
  if (serviceIcons[definitionId]) return serviceIcons[definitionId];
  const id = bundledIntegrationIcon(definitionId);
  return id === null ? null : bundledIcons[id];
}
