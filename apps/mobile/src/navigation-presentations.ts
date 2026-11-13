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
  QuietlyMoved: "formSheet",
  NotificationsIntro: "formSheet",
  Settings: "modal",
  Chrome: "modal",
  BrowserProfiles: "modal",
  ConnectedApps: "modal",
  Plugins: "modal",
  Computer: "modal",
  DeploymentSwitcher: "modal",
  AgentAuthorization: "modal",
  // The Add group's presentation, which each of its screens takes.
  Add: "modal",
  AddDeployment: "modal",
  AddServer: "modal",
  AddPersonal: "modal",
} as const satisfies Readonly<Record<string, NativeStackNavigationOptions["presentation"]>>;

const presentations: Readonly<Record<string, NativeStackNavigationOptions["presentation"]>> =
  screenPresentations;

type StackState = {
  readonly index: number;
  readonly routes: readonly { readonly key: string; readonly name: string }[];
};

const modalKinds = new Set<NativeStackNavigationOptions["presentation"]>([
  "modal",
  "transparentModal",
  "containedModal",
  "containedTransparentModal",
  "fullScreenModal",
  "formSheet",
  "pageSheet",
]);

/**
 * Whether the screen of the route `key` is still drawn: everything over it is a
 * sheet it shows beneath. A screen with no presentation of its own over a modal
 * is presented as a modal too, as the native stack does. iOS presents a modal as
 * a card over the screen it came from; Android's covers it.
 */
export function routeShown(state: StackState, key: string, os: string): boolean {
  let inModal = false;
  const effective = state.routes.map((route) => {
    const own = presentations[route.name];
    if (modalKinds.has(own) || (inModal && own === undefined)) {
      inModal = true;
      return own ?? "modal";
    }
    return own;
  });
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (route === undefined) continue;
    if (route.key === key) return true;
    const presentation = effective[index];
    const seeThrough =
      presentation === "formSheet" ||
      presentation === "transparentModal" ||
      presentation === "containedTransparentModal" ||
      ((presentation === "modal" || presentation === "pageSheet") && os === "ios");
    if (!seeThrough) return false;
  }
  return false;
}

/** How many screens are over the route `key` on its stack, or null when it is not on it. */
export function routesAbove(state: StackState, key: string): number | null {
  const index = state.routes.findIndex((route) => route.key === key);
  return index < 0 ? null : Math.max(0, state.index - index);
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
