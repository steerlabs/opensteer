import type { HostClient, PersonalSurfaceDestination } from "@opensteer/client/host";
import { TabIdSchema, type TabId } from "@opensteer/core";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";
import { paramsTabId, tabRoute } from "../browser/surface-route.js";
import { operationDetail } from "../client/mobile-client.js";
import { placeTabId } from "./place-tab.js";

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
 * Opens the tab a task's place names. A page is shown at once; an app or a
 * phone first opens its one tab, and is shown only to a person still here.
 * A place with no tab to name opens nothing. `leave` runs just before the tab
 * is shown, as a sheet that asked closes itself.
 */
export function useOpenPlace(
  hostClient: HostClient,
  deploymentId: string,
  threadId?: string,
  leave?: () => void,
): (destination: PersonalSurfaceDestination) => void {
  const navigation = useNavigation();
  const showTab = useShowTab(deploymentId, threadId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    (destination: PersonalSurfaceDestination) => {
      if (destination.kind === "browser") {
        leave?.();
        showTab(TabIdSchema.parse(destination.tabId));
        return;
      }
      void placeTabId(hostClient, destination).then(
        (tabId) => {
          if (tabId === null || !mounted.current || !navigation.isFocused()) return;
          leave?.();
          showTab(tabId);
        },
        (error: unknown) => {
          if (mounted.current)
            Alert.alert(
              "This couldn’t be opened",
              operationDetail(error, "Try again in a moment."),
            );
        },
      );
    },
    [hostClient, leave, navigation, showTab],
  );
}
