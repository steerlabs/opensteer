import type { HostClient } from "@opensteer/client/host";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { newTaskDraftKey } from "../client/thread-drafts.js";
import { homeDraftId } from "../home/home-draft.js";
import { presentedFrom } from "../navigation-presentations.js";
import { threadReturn } from "../navigation-state.js";
import { useMobileClient } from "../ui/mobile-client-context.js";

/**
 * Leaving the sheets stacked over a Deployment's work, such as Settings, for
 * one of its Threads, back to the screen the sheets were opened over and then
 * forward, so its Back returns there and nothing is pushed over a sheet; or
 * for a new task, which is Home's.
 */
export function useLeaveSheets(
  deploymentId: string | null,
  hostClient: HostClient | null,
): {
  readonly openThread: (threadId: string) => void;
  /** Home, with `text` as its new task's words. */
  readonly openNewTask: (text: string) => Promise<void>;
} {
  const navigation = useNavigation();
  const drafts = useMobileClient().drafts;
  const popSheets = useCallback(() => {
    const state = navigation.getState();
    const from = state === undefined ? -1 : presentedFrom(state);
    if (state !== undefined && from > 0)
      navigation.dispatch(StackActions.pop(state.index - from + 1));
  }, [navigation]);
  const openThread = useCallback(
    (threadId: string) => {
      if (deploymentId === null || hostClient === null) return;
      const destination = { deploymentId, threadId };
      if (threadReturn(navigation.getState()?.routes ?? [], destination) === "pop-to") {
        navigation.dispatch(StackActions.popTo("Thread", destination));
        return;
      }
      popSheets();
      navigation.dispatch(StackActions.push("Thread", destination));
    },
    [deploymentId, hostClient, navigation, popSheets],
  );
  const openNewTask = useCallback(
    async (text: string) => {
      if (deploymentId === null || hostClient === null) return;
      const snapshot = hostClient.getSnapshot();
      const userId = snapshot.user?.id;
      if (userId === undefined) return;
      await drafts.writeDraft(deploymentId, userId, newTaskDraftKey(homeDraftId), text);
      navigation.dispatch(StackActions.popToTop());
    },
    [deploymentId, drafts, hostClient, navigation],
  );
  return useMemo(() => ({ openNewTask, openThread }), [openNewTask, openThread]);
}
