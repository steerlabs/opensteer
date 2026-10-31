import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import {
  heldThread,
  reviewHostAction,
  sameTaskRow,
  taskUnderWay,
  taskMark,
  taskRowLabel,
  type HostClient,
  type TaskRow,
} from "@opensteer/client/host";
import { memo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, material, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";
import { useReducedMotion } from "react-native-reanimated";
import { Symbol } from "../ui/symbol.js";

/**
 * One of the reader's tasks, as the sidebar, search and a specialist's page
 * all draw it, from the shared task list (`taskList` in `@opensteer/client/host`)
 * and nothing else, on one line: its subject mark, title, and state — "Needs you", a spinner,
 * waiting or failure words, with a separate unread dot and finished time.
 *
 * Setting a finished task aside, or bringing one back, is a long press: the
 * same native menu a task's bubble in a conversation opens, and an action a
 * screen reader offers on the row itself.
 */

/** The column a row's mark sits in, at the mark's own width. */
const markColumn = 20;

/** Where a row's words start, past the mark's column; other text in a task list lines up here. */
export const taskTextInset = space[12] + markColumn + space[12];

/** Where a row is listed, which decides the one thing a long press can do with it. */
export type TaskShelf = "open" | "done";

export interface TaskRowProps {
  readonly onOpen: (threadId: string) => void;
  readonly onSetDone: (row: TaskRow, done: boolean) => void;
  readonly row: TaskRow;
  readonly selected: boolean;
  readonly shelf: TaskShelf;
  /** When it stopped, from `taskTime`, read by the list as it draws. */
  readonly time: string | null;
}

export const TaskRowView = memo(function TaskRowView(props: TaskRowProps): ReactNode {
  const { row, time } = props;
  const menu = useRef<MenuComponentRef>(null);
  const move = shelfMove(row);
  const needsYou = row.tone === "needs-you";
  // The native menu sizes itself to what it holds, so a row inside it is
  // given the width the list gave the row.
  const [width, setWidth] = useState<number | null>(null);
  const inMenu = move !== null && width !== null;

  const content = (
    <Pressable
      accessibilityActions={move === null ? [] : [{ label: move.label, name: "move" }]}
      accessibilityHint="Opens this task"
      accessibilityLabel={`${taskRowLabel(row)}${row.unread && needsYou ? ", unread" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onAccessibilityAction={(event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === "move" && move !== null) {
          props.onSetDone(row, move.done);
        }
      }}
      onLongPress={
        // Android's menu opens from this handle; iOS opens its context menu
        // from the long press itself.
        move !== null && Platform.OS === "android" ? () => menu.current?.show() : undefined
      }
      onPress={() => props.onOpen(row.threadId)}
      style={({ pressed }) => [
        styles.row,
        inMenu && { width },
        props.selected && styles.selected,
        needsYou && styles.needsYou,
        needsYou && props.selected && styles.needsYouSelected,
        pressed &&
          (needsYou
            ? styles.needsYouPressed
            : props.selected
              ? styles.selectedPressed
              : styles.pressed),
      ]}
    >
      <TaskMark mark={taskMark(row)} quiet={props.shelf === "done"} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={[styles.grow, titleStyle(row, props.shelf)]}
      >
        {row.title}
      </AppText>
      <TaskRowState row={row} shelf={props.shelf} time={time} />
    </Pressable>
  );

  if (move === null) return content;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {inMenu ? (
        <MenuView
          actions={[
            {
              id: "move",
              image: move.done ? "checkmark" : "arrow.uturn.backward",
              title: move.label,
            },
          ]}
          colorScheme="dark"
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "move") props.onSetDone(row, move.done);
          }}
          ref={menu}
          shouldOpenOnLongPress
        >
          {content}
        </MenuView>
      ) : (
        content
      )}
    </View>
  );
}, sameTaskRowProps);

/** State retains its own words and slot; unread is never used as task identity. */
export function TaskRowState(props: Pick<TaskRowProps, "row" | "shelf" | "time">): ReactNode {
  const { row, shelf, time } = props;
  const reducedMotion = useReducedMotion();
  return (
    <View style={styles.state}>
      {row.tone === "needs-you" ? (
        <NeedsYouTag />
      ) : row.tone === "working" ? (
        reducedMotion ? (
          <Symbol name="circle.dotted" size={16} tint={color.ember} />
        ) : (
          <ActivityIndicator color={color.ember} size="small" style={styles.spinner} />
        )
      ) : row.tone === "failed" ? (
        <AppText role="caption" tone="danger">
          Couldn't finish
        </AppText>
      ) : row.tone === "waiting" ? (
        <AppText role="caption" tone="muted">
          Waiting
        </AppText>
      ) : null}
      {row.unread ? <UnreadDot /> : null}
      {time !== null && (row.tone === "finished" || shelf === "done") ? <Time text={time} /> : null}
    </View>
  );
}

/** The one loud thing a list says: a question only the reader can answer. */
export function NeedsYouTag(): ReactNode {
  return (
    <View style={styles.tag}>
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.tagText}>
        Needs you
      </AppText>
    </View>
  );
}

export function UnreadDot(): ReactNode {
  return <View style={styles.unread} />;
}

/** Unread work and questions read bright; finished work the reader has seen steps back. */
function titleStyle(row: TaskRow, shelf: TaskShelf): { readonly color: string } {
  if (row.tone === "needs-you") return styles.strong;
  if (shelf === "done") return styles.quiet;
  if (row.unread) return styles.bright;
  return row.tone === "finished" ? styles.quiet : styles.title;
}

/**
 * The shared task state decides the action, independently of its unread shelf.
 */
function shelfMove(row: TaskRow): { readonly done: boolean; readonly label: string } | null {
  if (!row.canBeDone) return null;
  return row.done ? { done: false, label: "Reopen" } : { done: true, label: "Mark Done" };
}

function Time(props: { readonly text: string }): ReactNode {
  return (
    <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.time}>
      {props.text}
    </AppText>
  );
}

/**
 * Rows are rebuilt from the task list on every change the drawer or list
 * hears, so identity says nothing; a row redraws only when its own words do.
 */
function sameTaskRowProps(left: TaskRowProps, right: TaskRowProps): boolean {
  return (
    left.onOpen === right.onOpen &&
    left.onSetDone === right.onSetDone &&
    left.selected === right.selected &&
    left.shelf === right.shelf &&
    left.time === right.time &&
    sameTaskRow(left.row, right.row)
  );
}

/**
 * Sets a task aside in Done or brings it back, saying so to a screen reader,
 * whose row has just left from under it. The Host's answer moves the row; a
 * refusal is said where the reader is.
 */
export function setTaskDone(hostClient: HostClient, threadId: string, done: boolean): void {
  const review = reviewHostAction(hostClient, { kind: "task-done", threadId, done });
  if (!review) return;
  const thread = heldThread(hostClient.getSnapshot(), threadId);
  const confirm = () =>
    void review.confirm().then(
      (changed) => {
        if (changed) AccessibilityInfo.announceForAccessibility(done ? "Marked Done" : "Reopened");
      },
      (error: unknown) => Alert.alert("Task not changed", operationDetail(error, "Try again.")),
    );
  if (done && thread && taskUnderWay(thread)) {
    Alert.alert(
      "Stop and mark Done?",
      "This stops its work and the tasks it handed out, and pauses its schedules.",
      [
        { text: "Keep working", style: "cancel", onPress: review.cancel },
        { text: "Mark Done", style: "destructive", onPress: confirm },
      ],
      { onDismiss: review.cancel },
    );
  } else confirm();
}

const styles = StyleSheet.create({
  bright: { color: color.text },
  grow: { flex: 1, minWidth: 0 },
  state: { alignItems: "center", flexDirection: "row", gap: space[8], flexShrink: 0 },
  needsYou: {
    ...material.attention,
    marginVertical: space[2],
  },
  needsYouPressed: { ...material.attentionPressed },
  needsYouSelected: { backgroundColor: material.selected.backgroundColor },
  selectedPressed: { ...material.platePressed },
  pressed: { ...material.quiet },
  quiet: { color: color.muted },
  row: {
    borderColor: "transparent",
    borderWidth: 1,
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    paddingHorizontal: space[12] - 1,
  },
  selected: { ...material.selected },
  // The platform spinner is a little larger than the state slot.
  spinner: { transform: [{ scale: 0.8 }] },
  strong: { color: color.text, fontWeight: "600" },
  tag: {
    backgroundColor: color.amber,
    borderRadius: radius.full,
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
  tagText: { color: color.inkOnAmber, fontWeight: "700" },
  time: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  title: { color: color.textSoft },
  unread: { backgroundColor: color.ember, borderRadius: radius.full, height: 7, width: 7 },
});
