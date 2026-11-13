import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";

export const screenPresentations = {
  BrowserTabs: "formSheet",
  OpenApp: "formSheet",
  ThreadSettings: "formSheet",
  ThreadFind: "formSheet",
  NewThread: "formSheet",
  JoinTeam: "formSheet",
  CreateTeam: "formSheet",
  TeamSetup: "formSheet",
  DeleteTeam: "formSheet",
  TransferTeam: "formSheet",
  ConnectOpensteer: "formSheet",
  ThreadStep: "formSheet",
  RequestSheet: "formSheet",
  ConversationActivity: "formSheet",
  ThreadAround: "formSheet",
  RunningNow: "formSheet",
  Settings: "modal",
  Chrome: "modal",
  BrowserProfiles: "modal",
  ConnectedApps: "modal",
  Plugins: "modal",
  Computer: "modal",
  AddIphone: "formSheet",
  DeploymentSwitcher: "modal",
  Add: "modal",
} as const satisfies Readonly<Record<string, NativeStackNavigationOptions["presentation"]>>;

const presentations: Readonly<Record<string, NativeStackNavigationOptions["presentation"]>> =
  screenPresentations;

/** Sheets leave the underlying page in charge of the surrounding layout. */
export function layoutRoute<T extends { readonly name: string }>(state: {
  readonly index: number;
  readonly routes: readonly T[];
}): T | undefined {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (route === undefined) continue;
    const presentation = presentations[route.name];
    if (presentation === undefined || presentation === "card" || presentation === "fullScreenModal")
      return route;
  }
  return undefined;
}
