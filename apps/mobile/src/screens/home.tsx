import type { TaskFolder } from "@opensteer/core";
import { newTaskDraftKey } from "../client/thread-drafts.js";
import { homeDraftId } from "../home/home-draft.js";
import { useHostValue, useMobileClient } from "../ui/mobile-client-context.js";
import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { Keyboard } from "react-native";
import { useSidebarMenu } from "../navigation-header.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NewTaskPane } from "./new-task.js";
import { useNotificationsIntro } from "./notifications-intro.js";
import { folderLabel } from "../home/folder-label.js";

export type HomeScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /** The folder chosen on the composer's chip; Agent home until one is. */
  readonly folder?: TaskFolder | undefined;
}>;

/**
 * Home: what the reader's agent should do next, and nothing else. Today's
 * composer, with the folder the task will work in and the AI that runs it;
 * empty, its circle starts Voice. A task once started opens over Home, so
 * Back returns here. The live tasks are in the drawer; the rest are in All
 * tasks. It is the root of every computer's stack and stays mounted under
 * everything pushed over it.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId, folder: chosen } = props.route.params;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  useNotificationsIntro(hostClient);
  const home = useHostValue(hostClient, agentHome, null);
  // The folder Home's one draft was left in, until a new one is chosen.
  const userId = useHostValue(hostClient, viewerId, null);
  const drafts = useMobileClient().drafts;
  useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  const draft =
    userId === null ? null : drafts.readDraft(deploymentId, userId, newTaskDraftKey(homeDraftId));
  const folder = chosen ?? draft?.folder ?? home;
  const onStarted = useCallback(
    (threadId: string): boolean => {
      if (!navigation.isFocused()) return false;
      Keyboard.dismiss();
      navigation.dispatch(StackActions.push("Thread", { deploymentId, started: true, threadId }));
      return true;
    },
    [deploymentId, navigation],
  );
  if (hostClient === null)
    return <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />;
  return (
    <Screen edgeToEdge>
      <NewTaskPane
        autoFocus={false}
        deploymentId={deploymentId}
        home={{
          folder,
          folderLabel: folderLabel(folder, home),
          onChooseFolder: () => navigation.navigate("FolderPicker", { deploymentId }),
        }}
        hostClient={hostClient}
        key={deploymentId}
        onStarted={onStarted}
        underHeader
      />
    </Screen>
  );
}

const viewerId = (snapshot: { readonly user: { readonly id: string } | null }) =>
  snapshot.user?.id ?? null;

const agentHome = (snapshot: {
  readonly personalSettings: { readonly agentHome: TaskFolder } | null;
}) => snapshot.personalSettings?.agentHome ?? null;
