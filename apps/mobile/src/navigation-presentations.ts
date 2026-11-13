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
  TeamNewChannel: "formSheet",
  TeamNewMessage: "formSheet",
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
  DeploymentSwitcher: "modal",
  Add: "modal",
} as const satisfies Readonly<Record<string, NativeStackNavigationOptions["presentation"]>>;

const presentations: Readonly<Record<string, NativeStackNavigationOptions["presentation"]>> =
  screenPresentations;

/**
 * Whether the screen of the route `key` is still drawn: everything over it is a
 * sheet it shows beneath. iOS presents a modal as a card over the screen it
 * came from; Android's covers it.
 */
export function routeShown(
  state: {
    readonly index: number;
    readonly routes: readonly { readonly key: string; readonly name: string }[];
  },
  key: string,
  os: string,
): boolean {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (route === undefined) continue;
    if (route.key === key) return true;
    const presentation = presentations[route.name];
    if (presentation !== "formSheet" && !(presentation === "modal" && os === "ios")) return false;
  }
  return false;
}

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
