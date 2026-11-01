import Animated from "react-native-reanimated";
import { taskSlide } from "./task-motion.js";
import {
  canRespondToRequests,
  describeHostConnection,
  filterThreads,
  sameTaskListSource,
  taskAttention,
  taskList,
  taskTime,
  workspaceTaskList,
  type HostClient,
  type HostSnapshot,
  type TaskRow,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, Notice, SecondaryButton, SectionLabel, StatusDot } from "../ui/primitives.js";
import { useListContentInsets } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { setTaskDone, TaskRowView, taskTextInset, type TaskShelf } from "./task-row.js";

/**
 * The reader's tasks as a full screen: every one on the Deployment for
 * Search, or one specialist's own, which the Host lists for that Workspace
 * alone. The rows and groups are the sidebar's, read from the same shared
 * model — Working, Ready, then Done — and a search narrows each to what
 * matches. Chat is not a task and is never listed: it is the screen
 * underneath, at the top of the sidebar.
 */

type TasksRow =
  | { readonly key: string; readonly kind: "empty"; readonly text: string }
  | { readonly key: string; readonly kind: "loading" }
  | {
      readonly key: string;
      readonly kind: "nothing";
      readonly detail: string;
      readonly signIn: boolean;
      readonly title: string;
    }
  | { readonly key: string; readonly kind: "section"; readonly title: string }
  | {
      readonly key: string;
      readonly kind: "task";
      readonly row: TaskRow;
      readonly shelf: TaskShelf;
      readonly time: string | null;
    };

export function TasksPane(props: {
  readonly deploymentId: string;
  /** Content above the list, scrolling with it: a specialist's own heading. */
  readonly header?: ReactNode;
  readonly hostClient: HostClient;
  readonly onOpenTask: (threadId: string) => void;
  /** Runs this deployment's sign-in door when the Host has refused this phone. */
  readonly onSignIn: () => Promise<void>;
  /** What the screen's search bar holds; the pane shows matches while it is not empty. */
  readonly query: string;
  /** The Workspace this list is about, or null for every task on the Deployment. */
  readonly workspaceId: string | null;
}): ReactNode {
  const { hostClient, query, workspaceId } = props;
  const insets = useListContentInsets(space[32]);
  const { loadError, reload, snapshot } = useHostSnapshot(hostClient, samePaneSource);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loadingEarlierRef = useRef(false);

  const connection = describeHostConnection(snapshot);
  const refused = connection.action === "sign-in";
  const authenticated = snapshot.session === "authenticated";

  // A specialist's own list is read when its page opens, and kept current by
  // the Host client from then on.
  useEffect(() => {
    if (workspaceId === null || !authenticated) return;
    let live = true;
    void hostClient.loadWorkspaceTasks(workspaceId).catch((error: unknown) => {
      if (live) setFailure(operationDetail(error, "This specialist’s tasks could not be loaded."));
    });
    return () => {
      live = false;
    };
  }, [authenticated, hostClient, workspaceId]);

  const now = Date.now();
  const read =
    workspaceId === null ? snapshot.tasks : (snapshot.workspaceTasks[workspaceId] ?? null);
  const list = workspaceId === null ? taskList(snapshot) : workspaceTaskList(snapshot, workspaceId);
  const searching = query.trim() !== "";
  // The shared matcher decides what a query finds; the list decides the order.
  const matches = searching
    ? new Set(
        filterThreads(
          (read?.entries ?? []).map(({ thread }) => thread),
          snapshot.workspaces,
          query,
          taskAttention(snapshot),
        ).map(({ id }) => id),
      )
    : null;
  const shown = (row: TaskRow): boolean => matches === null || matches.has(row.threadId);
  const groups = [
    { rows: list.working.filter(shown), shelf: "open", title: "Working" },
    { rows: list.ready.filter(shown), shelf: "open", title: "Ready" },
    { rows: list.done.filter(shown), shelf: "done", title: "Done" },
  ] as const;

  const rows: TasksRow[] = [];
  if (groups.every((group) => group.rows.length === 0)) {
    // A Host that refused this phone told it nothing, and one that has not
    // sent its task list has said nothing either, so "none" is not yet a claim
    // this screen is entitled to make.
    if (refused) {
      rows.push({
        detail: "Sign in to see what is running here.",
        key: "nothing",
        kind: "nothing",
        signIn: true,
        title: "Needs sign-in",
      });
    } else if (read === null) {
      // A read that failed says so above the list instead.
      if (failure === null) rows.push({ key: "loading", kind: "loading" });
    } else if (searching) {
      rows.push({
        key: "empty",
        kind: "empty",
        text: list.hasMore
          ? `No matches in loaded tasks for “${query.trim()}”. Show more to search older tasks.`
          : `No tasks match “${query.trim()}”.`,
      });
    } else {
      rows.push({
        detail:
          workspaceId === null
            ? "Bigger jobs run here as tasks, side by side. Opensteer starts them for you."
            : "Tasks started here use this specialist’s files, instructions and access.",
        key: "nothing",
        kind: "nothing",
        signIn: false,
        title: "No tasks yet",
      });
    }
  }
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    rows.push({ key: `section:${group.title}`, kind: "section", title: group.title });
    for (const row of group.rows) {
      rows.push({
        key: row.threadId,
        kind: "task",
        row,
        shelf: group.shelf,
        time: taskTime(row, now),
      });
    }
  }

  const loadEarlier = (): void => {
    if (loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setFailure(null);
    void (
      workspaceId === null
        ? hostClient.loadEarlierTasks()
        : hostClient.loadEarlierTasks(workspaceId)
    )
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "Earlier tasks could not be loaded."));
      })
      .finally(() => {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      });
  };

  const signIn = useCallback((): void => {
    setFailure(null);
    void props.onSignIn().catch((error: unknown) => {
      setFailure(operationDetail(error, "Sign-in did not finish. Try again."));
    });
  }, [props.onSignIn]);

  const moveTask = useCallback(
    (row: TaskRow, toDone: boolean) => setTaskDone(hostClient, row.threadId, toDone),
    [hostClient],
  );
  const { onOpenTask } = props;
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TasksRow>): ReactElement => {
      switch (item.kind) {
        case "empty":
          return (
            <View style={styles.empty}>
              <AppText role="secondary" tone="muted">
                {item.text}
              </AppText>
            </View>
          );
        case "loading":
          return (
            <View style={styles.loading}>
              <ActivityIndicator color={color.muted} />
            </View>
          );
        case "nothing":
          return (
            <View style={styles.nothing}>
              <Symbol name="checklist" size={30} tint={color.mutedDim} />
              <AppText role="title">{item.title}</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                {item.detail}
              </AppText>
              {item.signIn ? <SecondaryButton compact label="Sign in" onPress={signIn} /> : null}
            </View>
          );
        case "section":
          return (
            <View style={styles.section}>
              <SectionLabel>{item.title}</SectionLabel>
            </View>
          );
        case "task":
          return (
            <TaskRowView
              onOpen={onOpenTask}
              onSetDone={moveTask}
              row={item.row}
              selected={false}
              shelf={item.shelf}
              time={item.time}
            />
          );
      }
    },
    [moveTask, onOpenTask, signIn],
  );

  return (
    <Animated.FlatList
      itemLayoutAnimation={taskSlide}
      // Rows carry their own inset, so the list's gutter is where their mark
      // column begins rather than where their words do.
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: insets.paddingBottom,
          paddingLeft: Math.max(0, insets.paddingLeft - space[12]),
          paddingRight: Math.max(0, insets.paddingRight - space[12]),
        },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      keyExtractor={keyOfRow}
      ListFooterComponent={
        list.hasMore && !refused ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: loadingEarlier }}
            disabled={loadingEarlier}
            onPress={loadEarlier}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            {loadingEarlier ? (
              <ActivityIndicator color={color.muted} size="small" />
            ) : (
              <AppText role="secondaryMedium" tone="muted">
                Show more
              </AppText>
            )}
          </Pressable>
        ) : undefined
      }
      ListHeaderComponent={
        <View style={styles.header}>
          {props.header}
          {canRespondToRequests(snapshot) ? null : (
            <View style={styles.connection}>
              <StatusDot live={snapshot.connection === "connecting"} tone={connection.tone} />
              <AppText numberOfLines={1} role="secondary" style={styles.grow} tone="soft">
                {connection.label}
              </AppText>
              {connection.action === "retry" ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={space[8]}
                  onPress={() => void reload().catch(() => undefined)}
                  style={styles.inlineAction}
                >
                  <AppText role="secondaryMedium" tone="ember">
                    Try again
                  </AppText>
                </Pressable>
              ) : null}
              {connection.action === "sign-in" ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={space[8]}
                  onPress={signIn}
                  style={styles.inlineAction}
                >
                  <AppText role="secondaryMedium" tone="ember">
                    Sign in
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          )}
          {loadError === null && failure === null ? null : (
            <Notice
              detail={failure ?? loadError ?? ""}
              title="Something did not work"
              tone="neutral"
            />
          )}
        </View>
      }
      refreshControl={
        <RefreshControl
          onRefresh={() => {
            setRefreshing(true);
            setFailure(null);
            void hostClient
              .refresh()
              .catch((error: unknown) => {
                setFailure(operationDetail(error, "This deployment could not be refreshed."));
              })
              .finally(() => setRefreshing(false));
          }}
          refreshing={refreshing}
          tintColor={color.muted}
        />
      }
      renderItem={renderItem}
    />
  );
}

/**
 * What the pane reads: the task list's own sources, the Workspaces a search
 * matches names against, and what the connection line says.
 */
function samePaneSource(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    sameTaskListSource(previous, next) &&
    previous.workspaces === next.workspaces &&
    previous.session === next.session &&
    previous.network === next.network
  );
}

function keyOfRow(row: TasksRow): string {
  return row.key;
}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  // What is wrong with the connection, in one inset row: it is a state of the
  // list rather than a failure of anything the person just did, so it sits on
  // the quiet surface instead of inside a notice.
  connection: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  content: { paddingTop: space[4] },
  empty: { paddingHorizontal: taskTextInset, paddingVertical: space[12] },
  grow: { flex: 1 },
  header: { gap: space[10], paddingBottom: space[4], paddingHorizontal: space[12] },
  inlineAction: { justifyContent: "center", minHeight: touchTarget },
  loading: { alignItems: "center", paddingVertical: space[48] },
  more: {
    alignItems: "flex-start",
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: touchTarget,
    paddingLeft: taskTextInset,
  },
  nothing: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  pressed: { backgroundColor: color.surfacePressed },
  section: { paddingBottom: space[4], paddingLeft: taskTextInset, paddingTop: space[20] },
});
