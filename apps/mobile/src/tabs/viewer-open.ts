import type { TabDestination } from "@opensteer/client/host";
import type { TabId } from "@opensteer/core";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { paramsTabId, tabRoute } from "../browser/surface-route.js";

/**
 * Shows exactly one tab, pushed over the screen that asked so Back returns
 * there; the tab already in front is left as it is. `threadId` is the
 * conversation it was opened from.
 */
export function useShowTab(deploymentId: string, threadId?: string): (tabId: TabId) => void {
  const navigation = useNavigation();
  return useCallback(
    (tabId: TabId) => {
      const state = navigation.getState();
      const current = state?.routes[state.index];
      if (current?.name === "WorkspaceBrowser" && paramsTabId(current.params) === tabId) return;
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", tabRoute(deploymentId, tabId, threadId)),
      );
    },
    [deploymentId, navigation, threadId],
  );
}

/**
 * Opens the tab a task's place names, whatever its kind. `leave` runs just
 * before the tab is shown, as a sheet that asked closes itself.
 */
export function useOpenPlace(
  deploymentId: string,
  threadId?: string,
  leave?: () => void,
): (destination: TabDestination) => void {
  const showTab = useShowTab(deploymentId, threadId);
  return useCallback(
    (destination: TabDestination) => {
      leave?.();
      showTab(destination.tabId);
    },
    [leave, showTab],
  );
}
