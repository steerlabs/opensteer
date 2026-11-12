import {
  doneTaskList,
  quietSeenScope,
  seenThroughOf,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { RootParamList } from "../navigation.js";
import { TasksPane } from "../threads/tasks-pane.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type DoneTasksScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/** Done, newest Done first, from the last line of the drawer's Tasks. */
export function DoneTasksScreen(props: DoneTasksScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const client = useMobileClient();
  const hostClient = useAttachedHost(deploymentId);
  const signIn = useCallback(() => client.signIn(deploymentId), [client, deploymentId]);
  const openTask = useCallback(
    (threadId: string): void => navigation.navigate("Thread", { deploymentId, threadId }),
    [deploymentId, navigation],
  );
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return (
    <Screen edgeToEdge>
      <SeeQuietMoves hostClient={hostClient} />
      <View style={styles.list}>
        <TasksPane
          deploymentId={deploymentId}
          done
          hostClient={hostClient}
          onOpenTask={openTask}
          onSignIn={signIn}
          query=""
        />
      </View>
    </Screen>
  );
}

const newestShown = (snapshot: HostSnapshot): string | null =>
  seenThroughOf(doneTaskList(snapshot)?.rows ?? [], null);

/** What the Done page shows of quiet moves is seen, so "+N" stops counting it. */
function SeeQuietMoves(props: { readonly hostClient: HostClient }): null {
  const focused = useIsFocused();
  const { quietSeen } = useMobileClient();
  const scope = useHostSelector(props.hostClient, quietSeenScope);
  const through = useHostSelector(props.hostClient, newestShown);
  useEffect(() => {
    if (focused && scope !== null && through !== null) quietSeen.see(scope, through);
  }, [focused, quietSeen, scope, through]);
  return null;
}

const styles = StyleSheet.create({
  list: { flex: 1 },
});
