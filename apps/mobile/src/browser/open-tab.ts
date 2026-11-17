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

/**
 * The opening screen stands in for the tab until the Host answers, and the
 * answer settles that screen wherever it now sits in the stack: a screen the
 * person covered is still theirs to come back to, one they left is not.
 */
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
  const opening = () => {
    const state = navigation.getState();
    const route = state?.routes.find(
      (candidate) =>
        candidate.name === "OpeningTab" &&
        isRecord(candidate.params) &&
        candidate.params["openingId"] === openingId,
    );
    return state && route ? { source: route.key, target: state.key } : null;
  };
  let tab: Awaited<ReturnType<HostClient["openTab"]>>;
  try {
    tab = await input.hostClient.openTab(input.target);
  } catch (error) {
    const pending = opening();
    if (!pending) return;
    navigation.dispatch({ ...StackActions.pop(), ...pending });
    input.failed(error);
    return;
  }
  const pending = opening();
  if (pending)
    navigation.dispatch({
      ...StackActions.replace(
        "WorkspaceBrowser",
        tabRoute(input.deploymentId, tab.tabId, input.threadId),
      ),
      ...pending,
    });
}
