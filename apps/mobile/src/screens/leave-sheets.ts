import type { HostClient } from "@opensteer/client/host";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { newTaskDraftId, newTaskDraftKey } from "../client/thread-drafts.js";
import { threadReturn } from "../navigation-state.js";
import { useMobileClient } from "../ui/mobile-client-context.js";

/** The full screens of a Deployment's stack, as opposed to the sheets over them. */
const screenRoutes: ReadonlySet<string> = new Set([
  "AllTasks",
  "Home",
  "NewTask",
  "Tabs",
  "TeamChannel",
  "TeamHome",
  "TeamThread",
  "TaskSearch",
  "Thread",
  "WorkspaceBrowser",
]);

/**
 * Leaving the sheets stacked over a Deployment's work, such as Settings, for
 * one of its Threads or a new task: back to the screen the sheets were opened
 * over, then forward, so its Back returns there and nothing is pushed over a
 * sheet.
 */
export function useLeaveSheets(
  deploymentId: string | null,
  hostClient: HostClient | null,
): {
  readonly openThread: (threadId: string) => void;
  /** A new task in Agent home with `text` already in its composer. */
  readonly openNewTask: (text: string) => Promise<void>;
} {
  const navigation = useNavigation();
  const drafts = useMobileClient().drafts;
  const popSheets = useCallback(() => {
    const routes = navigation.getState()?.routes ?? [];
    const beneath = routes.findLastIndex(({ name }) => screenRoutes.has(name));
    const above = routes.length - 1 - Math.max(beneath, 0);
    if (above > 0) navigation.dispatch(StackActions.pop(above));
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
      const folder = snapshot.personalSettings?.agentHome;
      if (userId === undefined || folder === undefined) return;
      const draftId = newTaskDraftId();
      drafts.placeNewTaskDraft(deploymentId, userId, draftId, folder);
      await drafts.writeDraft(deploymentId, userId, newTaskDraftKey(draftId), text);
      popSheets();
      navigation.dispatch(StackActions.push("NewTask", { deploymentId, draftId }));
    },
    [deploymentId, drafts, hostClient, navigation, popSheets],
  );
  return useMemo(() => ({ openNewTask, openThread }), [openNewTask, openThread]);
}
