import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useClientConnectionEverReady } from "@opensteer/client/react";
import { useCallback, type ReactNode } from "react";
import { dismissKeyboard } from "../ui/composer-editor.js";
import { Gated } from "../ui/connection-gate.js";
import { useSavedSurface } from "../ui/mobile-client-context.js";
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
 * A task once started becomes the place, in front of Home. The live tasks are
 * in the sidebar; the rest are in Done. It is the root of every computer's
 * stack and stays mounted under every place.
 *
 * Until the computer has answered once, or a saved view of it is on this
 * phone, a task can't start and there is nothing to show: the gate explains,
 * as it does on the web.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  const answered = useClientConnectionEverReady(hostClient?.connection ?? null);
  const saved = useSavedSurface(deploymentId, "tasks").source === "saved";
  const usable = hostClient !== null && (answered || saved);
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
  return (
    <Gated
      gate={
        usable ? null : <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />
      }
    >
      {!usable ? null : (
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
      )}
    </Gated>
  );
}
