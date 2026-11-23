export const settingsDestinations = [
  { route: "SettingsGeneral", title: "General", group: "" },
  { route: "SettingsAccount", title: "Account", group: "" },
  { route: "SettingsDevices", title: "Devices", group: "" },
  { route: "SettingsMessaging", title: "Messaging", group: "" },
  { route: "SettingsExternalAgents", title: "Connected agents", group: "" },
  { route: "SettingsAiSharing", title: "AI sharing", group: "" },
  { route: "SettingsAI", title: "AI", group: "For your agents" },
  { route: "SettingsPlugins", title: "Plugins", group: "For your agents" },
  { route: "SettingsSignIns", title: "Sign-ins", group: "For your agents" },
] as const;

/** On a work Home: its mark as the group's title, and the way to what its organization can see. */
export interface SettingsHomeWork {
  readonly badge: string;
  readonly title: string;
  readonly onPress: () => void;
}

/** The Settings pages that belong to no one Home. */
const settingsWithoutHome: ReadonlySet<SettingsDestination["route"]> = new Set([
  "SettingsAiSharing",
]);
type SettingsDestination = (typeof settingsDestinations)[number];

/**
 * Where a Settings row leads: its page for the open Home, or, with no Home open, the Home picker
 * told which page it is choosing a Home for.
 */
export function settingsDestinationTarget(
  route: SettingsDestination["route"],
  deploymentId: string | null,
):
  | {
      readonly name: SettingsDestination["route"];
      readonly params?: { readonly deploymentId: string };
    }
  | { readonly name: "DeploymentSwitcher"; readonly params: { readonly opening: string } } {
  if (settingsWithoutHome.has(route)) return { name: route };
  if (deploymentId) return { name: route, params: { deploymentId } };
  const title = settingsDestinations.find((destination) => destination.route === route)!.title;
  return { name: "DeploymentSwitcher", params: { opening: title } };
}

/** The one sentence the Home picker says when a Settings page sent a person to it. */
export function homePickerReason(opening: string): string {
  return `${opening} belongs to a Home. Choose the Home whose ${opening} you want to open.`;
}
