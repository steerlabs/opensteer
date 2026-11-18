import { usePersonalResources } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  StackActions,
  useNavigation,
  useIsFocused,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useClientConnectionEverReady } from "@opensteer/client/react";
import { useCallback, type ReactNode } from "react";
import { dismissKeyboard } from "../ui/composer-editor.js";
import { Gated } from "../ui/connection-gate.js";
import { useMobileState, useSavedSurface } from "../ui/mobile-client-context.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { HeldNewTaskPane, NewTaskPane } from "./new-task.js";
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
 *
 * Until the computer has answered once, or a saved view of it is on this
 * phone, a task can't start and there is nothing to show: the gate explains,
 * as it does on the web. Over a saved view the composer stays, under the pill.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  const focused = useIsFocused();
  usePersonalResources(focused ? hostClient : null, homeResources);
  const answered = useClientConnectionEverReady(hostClient?.connection ?? null);
  const view = useSavedSurface(deploymentId, "tasks");
  const { rows, selection } = useMobileState();
  // A saved view stands in for the first answer, also while it hands over to
  // the live list, and before this launch has reached the computer at all.
  const savedUserId = view.source === "saved" ? view.userId : null;
  const live = hostClient !== null && (answered || savedUserId !== null || view.source === "live");
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const held =
    !live && savedUserId !== null && row?.signIn === null && selection.deploymentId === deploymentId
      ? savedUserId
      : null;
  const setupDue = usePhoneSetup(hostClient, deploymentId);
  useNotificationsIntro(setupDue ? null : hostClient);
  const onStarted = useCallback(
    (threadId: string): boolean => {
      if (!navigation.isFocused()) return false;
      void dismissKeyboard();
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId }));
      return true;
    },
    [deploymentId, navigation],
  );
  return (
    <Gated
      gate={
        live || held !== null ? null : (
          <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />
        )
      }
    >
      {live ? (
        <Screen edgeToEdge>
          <NewTaskPane
            autoFocus={false}
            deploymentId={deploymentId}
            hostClient={hostClient}
            key={deploymentId}
            onStarted={onStarted}
            savedUserId={savedUserId}
            underHeader
            voice
          />
        </Screen>
      ) : held !== null ? (
        <Screen edgeToEdge>
          <HeldNewTaskPane
            connection={selection.session?.connection ?? null}
            deploymentId={deploymentId}
            key={deploymentId}
            name={row?.name ?? null}
            underHeader
            userId={held}
            voice
          />
        </Screen>
      ) : null}
    </Gated>
  );
}
