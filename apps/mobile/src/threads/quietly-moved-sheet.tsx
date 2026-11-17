import {
  doneTaskList,
  quietlyMoved,
  quietSeenScope,
  reviewHostAction,
  sameTaskListSource,
  seenThroughOf,
  taskMark,
  type HostClient,
  type TaskRow,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { openTopLevel } from "../top-level.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, Notice, PrimaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";

export type QuietlyMovedScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/** How many tasks "Move all back" asks the Host to reopen at once. */
const moveBackConcurrency = 4;

/**
 * The tasks the Host just moved to Done for the reader, by name, from "+N"
 * on the sidebar's Done line. Each can go back on its own or all at once;
 * closing the sheet leaves them in Done. Opening it counts them as seen.
 */
export function QuietlyMovedScreen(props: QuietlyMovedScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Unavailable />;
  }
  return <QuietlyMoved deploymentId={deploymentId} hostClient={selection.hostClient} />;
}

function QuietlyMoved(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const { quietSeen } = useMobileClient();
  const { snapshot } = useHostSnapshot(hostClient, sameTaskListSource);
  const scope = quietSeenScope(snapshot);
  // What counted as new when the sheet opened stays listed while it is open,
  // though opening it has just marked those tasks seen.
  const [since] = useState(() =>
    scope === null ? null : (quietSeen.getSnapshot()?.[scope] ?? null),
  );
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const [movingAll, setMovingAll] = useState(false);
  const rows = quietlyMoved(doneTaskList(snapshot), since, Date.now());
  const days = snapshot.quietTaskDays;

  const shownThrough = seenThroughOf(rows, null);
  useEffect(() => {
    if (scope !== null && shownThrough !== null) quietSeen.see(scope, shownThrough);
  }, [quietSeen, scope, shownThrough]);

  // A row leaves once the Host has reopened its task; the last to leave closes the sheet.
  const listed = useRef(false);
  useEffect(() => {
    if (rows.length > 0) listed.current = true;
    else if (listed.current) navigation.goBack();
  }, [navigation, rows.length]);

  const busy = (threadId: string, on: boolean) =>
    setMoving((current) => {
      const next = new Set(current);
      if (on) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  const moveOne = (row: TaskRow): void => {
    busy(row.threadId, true);
    void moveBack(hostClient, row.threadId)
      .then(
        () => {
          void Haptics.selectionAsync();
          AccessibilityInfo.announceForAccessibility(`${row.title} moved back to Tasks`);
        },
        (error: unknown) =>
          Alert.alert("Task not moved back", operationDetail(error, "Try again.")),
      )
      .finally(() => busy(row.threadId, false));
  };
  const moveAll = (): void => {
    if (movingAll) return;
    setMovingAll(true);
    const queue = rows.map(({ threadId }) => threadId);
    let failed = 0;
    void Promise.all(
      Array.from({ length: Math.min(moveBackConcurrency, queue.length) }, async () => {
        for (let threadId = queue.shift(); threadId !== undefined; threadId = queue.shift()) {
          await moveBack(hostClient, threadId).catch(() => {
            failed += 1;
          });
        }
      }),
    ).then(() => {
      setMovingAll(false);
      if (failed === 0) {
        void Haptics.selectionAsync();
        return;
      }
      Alert.alert(
        failed === 1 ? "One task wasn’t moved back" : `${failed} tasks weren’t moved back`,
        "They’re still in Done. Check your connection and try again.",
      );
    });
  };
  // Reached from the sidebar, so a task chosen here is top-level like one chosen there.
  const openTask = useCallback(
    (threadId: string) => {
      const state = navigation.getState();
      const action =
        state === undefined
          ? null
          : openTopLevel(state, { name: "Thread", params: { deploymentId, threadId } });
      if (action === null) navigation.goBack();
      else navigation.dispatch(action);
    },
    [deploymentId, navigation],
  );

  return (
    <View style={styles.sheet}>
      <View style={[styles.header, { paddingLeft: insets.left + sheetInset }]}>
        <View accessibilityRole="header" style={styles.heading}>
          <AppText role="title">Moved to Done for you</AppText>
          <AppText role="secondary" tone="muted">
            {days === null || days === 0
              ? "No recent activity"
              : `No activity in ${days} ${days === 1 ? "day" : "days"}`}
          </AppText>
        </View>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={space[8]}
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [
            styles.close,
            { marginRight: insets.right + sheetInset },
            pressed && styles.pressed,
          ]}
        >
          <Symbol name="xmark" size={13} tint={color.textSoft} weight="semibold" />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + space[24],
            paddingLeft: insets.left + sheetInset,
            paddingRight: insets.right + sheetInset,
          },
        ]}
      >
        {rows.length === 0 ? (
          <AppText role="secondary" style={styles.empty} tone="muted">
            Nothing was moved to Done for you.
          </AppText>
        ) : (
          <>
            <View style={styles.group}>
              {rows.map((row, index) => (
                <View key={row.threadId} style={[styles.row, index > 0 && styles.separated]}>
                  <Pressable
                    accessibilityHint="Opens this task"
                    accessibilityLabel={row.title}
                    accessibilityRole="button"
                    onPress={() => openTask(row.threadId)}
                    style={({ pressed }) => [styles.open, pressed && styles.pressed]}
                  >
                    <TaskMark mark={taskMark(row)} quiet />
                    <AppText
                      maxFontSizeMultiplier={controlFontScaleLimit}
                      numberOfLines={1}
                      role="secondary"
                      style={styles.title}
                    >
                      {row.title}
                    </AppText>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Move ${row.title} back`}
                    accessibilityRole="button"
                    accessibilityState={{ busy: moving.has(row.threadId) }}
                    disabled={moving.has(row.threadId) || movingAll}
                    onPress={() => moveOne(row)}
                    style={({ pressed }) => [styles.back, pressed && styles.pressed]}
                  >
                    {moving.has(row.threadId) ? (
                      <ActivityIndicator color={color.muted} size="small" />
                    ) : (
                      <AppText
                        maxFontSizeMultiplier={controlFontScaleLimit}
                        role="secondaryMedium"
                        tone="ember"
                      >
                        Move back
                      </AppText>
                    )}
                  </Pressable>
                </View>
              ))}
            </View>
            <PrimaryButton
              busy={movingAll}
              disabled={moving.size > 0}
              label={rows.length === 1 ? "Move it back" : `Move all ${rows.length} back`}
              onPress={moveAll}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** Reopens one task; one already reopened by someone else counts as moved back. */
async function moveBack(hostClient: HostClient, threadId: string): Promise<void> {
  const review = reviewHostAction(hostClient, { done: false, kind: "task-done", threadId });
  if (review === null) throw new Error("This deployment isn’t connected.");
  await review.confirm();
}

function Unavailable(): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.unavailable]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail="This deployment is no longer open."
        title="This can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const sheetInset = space[16];

const styles = StyleSheet.create({
  back: {
    alignItems: "center",
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space[12],
  },
  close: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  content: { gap: space[16], paddingTop: space[16] },
  empty: { paddingHorizontal: space[4] },
  group: { backgroundColor: color.surfaceRaised, borderRadius: radius.md, overflow: "hidden" },
  header: { alignItems: "flex-start", flexDirection: "row", gap: space[8] },
  heading: { flex: 1, gap: space[2], paddingLeft: space[4] },
  open: {
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minWidth: 0,
    paddingLeft: space[12],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: Platform.OS === "android" ? 52 : 48,
  },
  separated: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1, paddingTop: space[20] },
  title: { color: color.textSoft, flex: 1 },
  unavailable: { justifyContent: "center", padding: space[24] },
});
