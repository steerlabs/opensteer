import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import {
  heldThread,
  reviewHostAction,
  type ActionReview,
  sameTaskRow,
  taskAfter,
  taskDoneConfirmation,
  taskList,
  taskUnderWay,
  taskMark,
  taskMarkQuiet,
  taskRowLabel,
  type HostClient,
  type TaskRow,
} from "@opensteer/client/host";
import type { ActionOutcome } from "@opensteer/client/actions";
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
import {
  color,
  controlFontScaleLimit,
  headerFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";
import { useReducedMotion } from "react-native-reanimated";
import { Symbol } from "../ui/symbol.js";
import { useShowsLive } from "../ui/connection-live.js";
import { useSelectedHostClient } from "../ui/mobile-client-context.js";
import { RowSubtitle, type ActionLineValue } from "../ui/action-line.js";
import { screenAction, useScreenAction } from "../ui/client-feedback.js";
import { ExternalAgentMark } from "../screens/external-agent-mark.js";
import { useSessionRow } from "../thread/agent-session-hooks.js";

/**
 * One of the reader's tasks, as the sidebar, search and Done
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
  /** A live row's one second line: the amber ask of a task that needs the reader. */
  readonly ask?: string | null;
  /** The reader has an unsent reply here. */
  readonly drafted?: boolean;
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
  // Done or Reopen from a menu or a swipe answers here, in the second line's place.
  const line = useTaskDoneLine(row.threadId);
  // A connected agent's own task wears the agent's mark and says what it is using.
  const session = useSessionRow(useSelectedHostClient(), row.threadId);
  const ask = props.ask ?? null;
  const said = ask ?? session?.line ?? null;
  const subtitle = line === null ? said : line;

  const content = (
    <Pressable
      accessibilityActions={move === null ? [] : [{ label: move.label, name: "move" }]}
      accessibilityHint="Opens this task"
      accessibilityLabel={`${taskRowLabel(row)}${row.unread && needsYou ? ", unread" : ""}${
        props.drafted === true ? `, ${draftPenLabel}` : ""
      }`}
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
      {session === null ? (
        <TaskMark mark={taskMark(row)} quiet={taskMarkQuiet(row, props.shelf === "done")} />
      ) : (
        <ExternalAgentMark
          initial={session.agent.initial}
          providerId={session.agent.providerId}
          size={markColumn}
        />
      )}
      {subtitle === null ? (
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="secondary"
          style={[styles.grow, titleStyle(row, props.shelf)]}
        >
          {row.title}
        </AppText>
      ) : (
        <View style={styles.grow}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondary"
            style={titleStyle(row, props.shelf)}
          >
            {row.title}
          </AppText>
          {line === null ? (
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={ask === null ? undefined : styles.ask}
              tone={ask === null ? "muted" : "default"}
            >
              {said}
            </AppText>
          ) : (
            <RowSubtitle line={line} subtitle={null} />
          )}
        </View>
      )}
      <TaskRowState drafted={props.drafted === true} row={row} shelf={props.shelf} time={time} />
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

/**
 * State in its own words; unread is never used as task identity. A task with
 * nothing to say draws nothing, so its title keeps the row's width.
 */
export function TaskRowState(
  props: Pick<TaskRowProps, "drafted" | "row" | "shelf" | "time">,
): ReactNode {
  const { row, shelf, time } = props;
  const drafted = props.drafted === true;
  const reducedMotion = useReducedMotion();
  // Once the pill says the connection is interrupted, "working" holds still.
  const live = useShowsLive(useSelectedHostClient()?.connection ?? null);
  const tone =
    row.tone === "needs-you" ? (
      <NeedsYouTag />
    ) : row.tone === "working" ? (
      reducedMotion || !live ? (
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
    ) : null;
  const when =
    time !== null && (row.tone === "finished" || shelf === "done") ? <Time text={time} /> : null;
  if (tone === null && !drafted && !row.unread && when === null) return null;
  return (
    <View style={styles.state}>
      {tone}
      {drafted ? <DraftPen /> : null}
      {row.unread ? <UnreadDot /> : null}
      {when}
    </View>
  );
}

/** The one loud thing a list says: a question only the reader can answer. */
export function NeedsYouTag(): ReactNode {
  // It grows only as far as a bar's label: past that it would crowd out the
  // title, and the amber ask under the title already says it.
  return (
    <View style={styles.tag}>
      <AppText maxFontSizeMultiplier={headerFontScaleLimit} role="caption" style={styles.tagText}>
        Needs you
      </AppText>
    </View>
  );
}

export function UnreadDot(): ReactNode {
  return <View style={styles.unread} />;
}

export const draftPenLabel = "unsent reply";

/** Something written here and not sent: quieter than any state it sits beside. */
export function DraftPen(): ReactNode {
  return <Symbol name="pencil" size={13} tint={color.muted} />;
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
    left.drafted === right.drafted &&
    left.onOpen === right.onOpen &&
    left.onSetDone === right.onSetDone &&
    left.selected === right.selected &&
    left.shelf === right.shelf &&
    left.time === right.time &&
    sameTaskRow(left.row, right.row)
  );
}

const taskDoneWords = {
  done: {
    label: "mark this task Done",
    done: "marked Done",
    happened: "this task was marked Done",
  },
  reopen: { label: "reopen this task", done: "reopened", happened: "this task was reopened" },
} as const;

function taskDoneSpec(done: boolean) {
  return {
    ...taskDoneWords[done ? "done" : "reopen"],
    execute: (work: () => Promise<boolean>) => work(),
  };
}

/** Ties Done or Reopen, run from any menu, to the task's row and its screen. */
export function taskDoneKey(threadId: string, done: boolean): string {
  return `task-done:${done ? "done" : "reopen"}:${threadId}`;
}

/** What the last Done or Reopen of this task came to, while it is worth saying. */
export function useTaskDoneLine(threadId: string): ActionLineValue | null {
  const hostClient = useSelectedHostClient();
  const marking = useScreenAction(hostClient, taskDoneKey(threadId, true), taskDoneSpec(true));
  const reopening = useScreenAction(hostClient, taskDoneKey(threadId, false), taskDoneSpec(false));
  return marking.line ?? reopening.line;
}

/**
 * Marks a task Done or reopens it under its review, as the task's one keyed
 * action: confirmed true once it changed. Out of reach there is nothing to
 * review, and the tap is answered as not sent.
 */
export function runTaskDone(
  hostClient: HostClient,
  threadId: string,
  done: boolean,
  review: ActionReview | null = reviewHostAction(hostClient, { kind: "task-done", threadId, done }),
): Promise<ActionOutcome<boolean>> {
  const action = screenAction(hostClient, taskDoneKey(threadId, done), taskDoneSpec(done));
  if (review === null) return action.run(() => Promise.resolve(false));
  // One change of a task at a time; the one already under way answers for both.
  if (action.getSnapshot().running) {
    review.cancel();
    return Promise.resolve({ kind: "confirmed", value: false });
  }
  return action
    .run(() => review.confirm())
    .then((outcome) => {
      if (outcome.kind === "not-sent") review.cancel();
      return outcome;
    });
}

/** A task's last Done or Reopen outcome, as a row's second line; nothing once it worked. */
export function TaskDoneLine(props: { readonly threadId: string }): ReactNode {
  const line = useTaskDoneLine(props.threadId);
  return line === null ? null : <RowSubtitle line={line} subtitle={null} />;
}

/**
 * Sets a task aside in Done or brings it back, saying so to a screen reader,
 * whose row has just left from under it. The Host's answer moves the row; any
 * other outcome is said in the row's second line and under the composer. Once it is Done, `advance` hears the
 * task that followed it in the list as it stood when confirmed.
 */
export function setTaskDone(
  hostClient: HostClient,
  threadId: string,
  done: boolean,
  advance?: (next: string | null) => void,
): void {
  const review = reviewHostAction(hostClient, { kind: "task-done", threadId, done });
  const thread = heldThread(hostClient.getSnapshot(), threadId);
  const confirm = () => {
    const next = advance ? taskAfter(taskList(hostClient.getSnapshot()), threadId) : null;
    void runTaskDone(hostClient, threadId, done, review).then((outcome) => {
      if (outcome.kind !== "confirmed" || !outcome.value) return;
      AccessibilityInfo.announceForAccessibility(done ? "Marked Done" : "Reopened");
      if (done) advance?.(next);
    });
  };
  if (review === null) return confirm();
  if (done && thread && taskUnderWay(thread)) {
    Alert.alert(
      "Stop and mark Done?",
      taskDoneConfirmation,
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
  ask: { color: color.amber },
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
