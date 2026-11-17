import { usePersonalResources } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  StackActions,
  useNavigation,
  useIsFocused,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, type ReactNode } from "react";
import { dismissKeyboard } from "../ui/composer-editor.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NewTaskPane } from "./new-task.js";
import { useNotificationsIntro } from "./notifications-intro.js";
import { usePhoneSetup } from "../phone-setup/use-phone-setup.js";

const homeResources = [
  "environment",
  "harness",
  "harness-catalog",
  "harness-auth",
  "settings",
] as const;

export type HomeScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
}>;

/**
 * Home: what the reader's agent should do next, and nothing else. Today's
 * composer, with the AI that runs the task; empty, its circle starts Voice.
 * A task once started becomes the place, in front of Home. The live tasks are
 * in the sidebar; the rest are in Done. It is the root of every computer's
 * stack and stays mounted under every place.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  const focused = useIsFocused();
  usePersonalResources(focused ? hostClient : null, homeResources);
  const setupDue = usePhoneSetup(hostClient, deploymentId);
  useNotificationsIntro(setupDue ? null : hostClient);
  const onStarted = useCallback(
    (threadId: string): boolean => {
      if (!navigation.isFocused()) return false;
      dismissKeyboard();
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId }));
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
