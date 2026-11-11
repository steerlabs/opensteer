import { showsHostLive, type HostClient, type RunningNow } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, type ReactNode } from "react";
import { FlatList, Platform, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText } from "../ui/primitives.js";
import { useGutter } from "../ui/screen.js";
import { RunningCommandView, RunningRowView, useRunningNow } from "../thread/running-now.js";
import { AgentEngine, AgentGround, threadEngine } from "../thread/agent-mark.js";
import { AgentsLive } from "../thread/subagent-rows.js";

export type RunningNowScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
}>;

type Item =
  | { readonly kind: "row"; readonly row: RunningNow["rows"][number] }
  | { readonly kind: "command"; readonly command: RunningNow["commands"][number] };

/**
 * Running now, opened from its capsule: each subagent and task working for
 * this conversation, with its live line, its time and Stop where its engine
 * allows. It closes itself when the last one settles; a row opens over the
 * conversation, so back returns there.
 */
export function RunningNowScreen(props: RunningNowScreenProps): ReactNode {
  const { deploymentId, threadId } = props.route.params;
  const { selection } = useMobileState();
  const navigation = useNavigation();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return (
      <View style={[styles.sheet, styles.gone]}>
        <AppText role="secondary" tone="muted">
          This deployment is no longer open.
        </AppText>
        <Done onPress={() => navigation.goBack()} />
      </View>
    );
  }
  return (
    <RunningList
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      threadId={threadId}
    />
  );
}

function RunningList(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const gutter = useGutter();
  const reachable = useHostSelector(
    hostClient,
    useCallback(
      (snapshot) => {
        const thread = snapshot.threads.find(({ id }) => id === threadId);
        const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
        return showsHostLive(snapshot) && environment?.status === "connected";
      },
      [threadId],
    ),
  );
  const engine = useHostSelector(
    hostClient,
    useCallback((snapshot) => threadEngine(snapshot, threadId), [threadId]),
  );
  const model = useRunningNow(hostClient, threadId, reachable);
  const empty = model === null;
  useEffect(() => {
    if (empty && navigation.isFocused()) navigation.goBack();
  }, [empty, navigation]);
  const items: readonly Item[] =
    model === null
      ? []
      : [
          ...model.rows.map((row) => ({ kind: "row" as const, row })),
          ...model.commands.map((command) => ({ command, kind: "command" as const })),
        ];
  const open = useCallback(
    (row: RunningNow["rows"][number]) => {
      const opens = row.card.opens;
      if (opens === null) return;
      navigation.goBack();
      navigation.dispatch(
        opens.kind === "thread"
          ? StackActions.push("Thread", { deploymentId, threadId: opens.threadId })
          : StackActions.push("Subagent", {
              deploymentId,
              nodeId: opens.nodeId,
              threadId: opens.threadId,
            }),
      );
    },
    [deploymentId, navigation],
  );
  return (
    <AgentsLive value={reachable}>
      <AgentEngine value={engine}>
        <AgentGround value={color.surfaceElevated}>
          <FlatList
            contentContainerStyle={{
              paddingBottom: insets.bottom + space[16],
              paddingLeft: gutter + insets.left,
              paddingRight: gutter + insets.right - space[8],
            }}
            data={items}
            keyExtractor={(item) => (item.kind === "row" ? item.row.card.key : item.command.key)}
            ListHeaderComponent={
              <View>
                {/* iOS draws the sheet's own grabber; Android's sheet has none. */}
                {Platform.OS === "android" ? <View style={styles.handle} /> : null}
                <View style={styles.head}>
                  <View accessibilityRole="header" style={styles.heading}>
                    <AppText numberOfLines={1} role="title">
                      Running now
                      {model === null ? null : (
                        <AppText role="secondary" tone="muted">{`  ${model.count}`}</AppText>
                      )}
                    </AppText>
                  </View>
                  {/* Android closes a sheet with system back, as every sheet there does. */}
                  {Platform.OS === "ios" ? <Done onPress={() => navigation.goBack()} /> : null}
                </View>
              </View>
            }
            renderItem={({ item }) =>
              item.kind === "row" ? (
                <RunningRowView
                  hostClient={hostClient}
                  onOpen={() => open(item.row)}
                  row={item.row}
                />
              ) : (
                <RunningCommandView command={item.command} />
              )
            }
            style={styles.sheet}
          />
        </AgentGround>
      </AgentEngine>
    </AgentsLive>
  );
}

function Done(props: { readonly onPress: () => void }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={space[8]}
      onPress={props.onPress}
      style={({ pressed }) => [styles.done, pressed && styles.donePressed]}
    >
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="action" tone="ember">
        Done
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  done: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[8] },
  donePressed: { opacity: 0.6 },
  gone: { alignItems: "center", gap: space[12], justifyContent: "center", padding: space[24] },
  handle: {
    alignSelf: "center",
    backgroundColor: color.lineControl,
    borderRadius: radius.full,
    height: 4,
    marginBottom: space[2],
    marginTop: space[14],
    width: 32,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingTop: Platform.OS === "ios" ? space[16] : space[4],
  },
  heading: { flex: 1 },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
});
