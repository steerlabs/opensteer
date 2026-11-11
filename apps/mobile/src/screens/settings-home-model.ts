export const settingsDestinations = [
  { route: "SettingsGeneral", title: "General", group: "" },
  { route: "SettingsAccount", title: "Account", group: "" },
  { route: "SettingsDevices", title: "Devices", group: "" },
  { route: "SettingsMessaging", title: "Messaging", group: "" },
  { route: "SettingsExternalAgents", title: "External agents", group: "" },
  { route: "SettingsAiSharing", title: "AI sharing", group: "" },
  { route: "SettingsAI", title: "AI", group: "For your agents" },
  { route: "SettingsPlugins", title: "Plugins", group: "For your agents" },
  { route: "SettingsSignIns", title: "Sign-ins", group: "For your agents" },
] as const;

/** Settings a team place doesn't have: no computers, messaging, personal AI sharing, plugins or sign-ins. */
const absentOnTeamPlace: ReadonlySet<string> = new Set([
  "SettingsDevices",
  "SettingsMessaging",
  "SettingsAiSharing",
  "SettingsPlugins",
  "SettingsSignIns",
]);

export function settingsHomeDestinations(teamPlace: boolean) {
  return teamPlace
    ? settingsDestinations.filter(({ route }) => !absentOnTeamPlace.has(route))
    : settingsDestinations;
}

export function settingsGroupTitle(group: string, teamPlace: boolean): string {
  return group === "" ? "" : teamPlace ? "For the team's projects" : group;
}

/** The one line a team place gives for everything it doesn't have. */
export const teamPlaceElsewhere =
  "Your own Chat, memory, sign-ins, apps and computers are in your own Opensteer.";

/** The team's rows in Settings, present only when its Host lets this person in. */
export interface SettingsHomeTeam {
  readonly name: string;
  readonly rows: readonly { readonly title: string; readonly onPress: () => void }[];
}
