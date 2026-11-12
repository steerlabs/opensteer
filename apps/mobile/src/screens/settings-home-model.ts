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

/** Settings' Teams group: the teams of the computer being shown, and Join a team. */
export interface SettingsHomeTeam {
  readonly name: string;
  readonly rows: readonly { readonly title: string; readonly onPress: () => void }[];
}
