import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, type ReactNode } from "react";
import { Keyboard } from "react-native";
import { useSidebarMenu } from "../navigation-header.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NewTaskPane } from "./new-task.js";
import { useNotificationsIntro } from "./notifications-intro.js";
import { usePhoneSetup } from "../phone-setup/use-phone-setup.js";

export type HomeScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
}>;

/**
 * Home: what the reader's agent should do next, and nothing else. Today's
 * composer, with the AI that runs the task; empty, its circle starts Voice.
 * A task once started opens over Home, so Back returns here. The live tasks
 * are in the drawer; the rest are in All tasks. It is the root of every
 * computer's stack and stays mounted under everything pushed over it.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  const setupDue = usePhoneSetup(hostClient, deploymentId);
  useNotificationsIntro(setupDue ? null : hostClient);
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
        hostClient={hostClient}
        key={deploymentId}
        onStarted={onStarted}
        underHeader
        voice
      />
    </Screen>
  );
}
