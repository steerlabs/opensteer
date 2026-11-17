import type { HostClient } from "@opensteer/client/host";
import type { TabTarget } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  StackActions,
  type NavigationProp,
  type NavigationState,
  type ParamListBase,
} from "@react-navigation/native";
import { tabRoute } from "./surface-route.js";

let openings = 0;
export type OpeningTabRoute = { deploymentId: string; address: string; openingId: number };

/** The pending screen belongs only to this action, never to a late answer. */
export async function openMobileTab(input: {
  navigation: Omit<NavigationProp<ParamListBase>, "getState"> & {
    getState(): NavigationState | undefined;
  };
  hostClient: HostClient;
  deploymentId: string;
  target: TabTarget;
  address: string;
  threadId?: string;
  failed: (error: unknown) => void;
}): Promise<void> {
  const { navigation } = input;
  const openingId = ++openings;
  navigation.dispatch(
    StackActions.push("OpeningTab", {
      deploymentId: input.deploymentId,
      address: input.address,
      openingId,
    }),
  );
  let cancelled = false;
  const selected = () => {
    const state = navigation.getState();
    if (!state) return null;
    const route = state.routes[state.index];
    return route?.name === "OpeningTab" &&
      isRecord(route.params) &&
      route.params["openingId"] === openingId
      ? { source: route.key, target: state.key }
      : null;
  };
  const unsubscribe = navigation.addListener("state", () => {
    if (!selected()) cancelled = true;
  });
  try {
    const tab = await input.hostClient.openTab(input.target);
    if (!cancelled && selected())
      navigation.dispatch({
        ...StackActions.replace(
          "WorkspaceBrowser",
          tabRoute(input.deploymentId, tab.tabId, input.threadId),
        ),
        ...selected(),
      });
  } catch (error) {
    if (!cancelled && selected()) {
      navigation.dispatch({ ...StackActions.pop(), ...selected() });
      input.failed(error);
    }
  } finally {
    unsubscribe();
  }
}
