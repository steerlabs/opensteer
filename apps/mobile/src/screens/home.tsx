import type { TaskFolder } from "@opensteer/core";
import { useHostSelector } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, type ReactNode } from "react";
import { Keyboard } from "react-native";
import { useSidebarMenu } from "../navigation-header.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NewTaskPane } from "./new-task.js";
import { useNotificationsIntro } from "./notifications-intro.js";

export type HomeScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /** The folder chosen on the composer's chip; Agent home until one is. */
  readonly folder?: TaskFolder | undefined;
}>;

/** Home's own draft: one per person per computer, kept while they come and go. */
export const homeDraftId = "home";

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
  const home = useHostSelector(hostClient, agentHome);
  const folder = chosen ?? home;
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
        draftId={homeDraftId}
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

const agentHome = (snapshot: { readonly personalSettings: { readonly agentHome: TaskFolder } | null }) =>
  snapshot.personalSettings?.agentHome ?? null;

/** "Agent home", or a folder's last path part. */
export function folderLabel(folder: TaskFolder | null, home: TaskFolder | null): string {
  if (folder === null) return "Agent home";
  if (home !== null && folder.computerId === home.computerId && folder.path === home.path)
    return "Agent home";
  return folder.path.split("/").filter(Boolean).at(-1) ?? folder.path;
}
