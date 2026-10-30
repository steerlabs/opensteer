import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type NativeSyntheticEvent } from "react-native";
import type { SearchBarCommands, SearchBarTextEventData } from "react-native-screens";
import type { RootParamList } from "../navigation.js";
import { color } from "../theme.js";
import { TasksPane } from "../threads/tasks-pane.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type TaskSearchScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Search: every one of the reader's tasks on this Deployment, open and done,
 * narrowed as they type.
 *
 * The sidebar's search opens it with the field ready to type into. A result
 * opens its task over the list at every window size, so Back always returns
 * here with the words and the results as they were; on a wide window the
 * docked sidebar is what keeps a list beside the task. The window's shape
 * never opens or closes anything here.
 */
export function TaskSearchScreen(props: TaskSearchScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const client = useMobileClient();
  const hostClient = useAttachedHost(deploymentId);
  const [query, setQuery] = useState("");
  const searchBar = useRef<SearchBarCommands>(null);

  const signIn = useCallback(() => client.signIn(deploymentId), [client, deploymentId]);
  const openTask = useCallback(
    (threadId: string): void => navigation.navigate("Thread", { deploymentId, threadId }),
    [deploymentId, navigation],
  );

  /**
   * Search lives in the navigation bar, where the platform keeps it, and stays
   * there while the list scrolls: it is what this screen is for.
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        // iOS 26 may fold an "integrated" search field into the bottom
        // toolbar, which on this screen would land beside nothing and leave
        // the bar it belongs to empty. It stays in the navigation bar.
        allowToolbarIntegration: false,
        autoCapitalize: "none",
        barTintColor: color.surfaceElevated,
        headerIconColor: color.ember,
        hideWhenScrolling: false,
        hintTextColor: color.muted,
        onChangeText: (event: NativeSyntheticEvent<SearchBarTextEventData>) =>
          setQuery(event.nativeEvent.text),
        placeholder: "Search tasks",
        ref: searchBar,
        textColor: color.text,
        tintColor: color.ember,
      },
    });
  }, [navigation]);

  // Opened from the sidebar's magnifying glass, so the field is what the
  // reader came for: it takes focus once the screen has arrived, and not again
  // when the reader comes back from a task they found.
  const arrived = useRef(false);
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (event) => {
        if (event.data.closing || arrived.current) return;
        arrived.current = true;
        searchBar.current?.focus();
      }),
    [navigation],
  );

  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;

  return (
    <Screen edgeToEdge>
      <View style={styles.list}>
        <TasksPane
          deploymentId={deploymentId}
          hostClient={hostClient}
          onOpenTask={openTask}
          onSignIn={signIn}
          query={query}
          workspaceId={null}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
});
