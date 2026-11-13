import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";

/** Every route presented over the stack rather than pushed onto it, by route name. */
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
  AddDeployment: "modal",
  AddServer: "modal",
  AddPersonal: "modal",
} as const satisfies Readonly<Record<string, NativeStackNavigationOptions["presentation"]>>;

const presentations: Readonly<Record<string, NativeStackNavigationOptions["presentation"]>> =
  screenPresentations;

function presented(name: string): boolean {
  const presentation = presentations[name];
  return presentation !== undefined && presentation !== "card";
}

/**
 * Where the presented flow over the stack begins, or -1 when there is none.
 * A card pushed after a sheet or modal is inside that presentation, as
 * native-stack presents it, so everything from the first one up is one flow.
 */
export function presentedFrom(state: {
  readonly index: number;
  readonly routes: readonly { readonly name: string }[];
}): number {
  return state.routes.findIndex((route, index) => index <= state.index && presented(route.name));
}

/** Sheets and modals leave the screen beneath them in charge of the surrounding layout. */
export function layoutRoute<T extends { readonly name: string }>(state: {
  readonly index: number;
  readonly routes: readonly T[];
}): T | undefined {
  const from = presentedFrom(state);
  return state.routes[from === -1 ? state.index : from - 1];
}
