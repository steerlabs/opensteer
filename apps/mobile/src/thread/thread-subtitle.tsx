import { Pressable, StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { taskMark, type ThreadSummary, type WorkspaceSummary } from "@opensteer/client/host";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { barNameFloor } from "../ui/bar-title.js";
import { AppText } from "../ui/primitives.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { TaskStatus, type TaskHeading } from "./task-status.js";

/** A Thread's subject and name in both the native bar and the split pane. */
export function ThreadName(props: {
  readonly maxFontSizeMultiplier?: number;
  readonly numberOfLines: number;
  /** Hears the row's width with the name whole, or at `barNameFloor` if longer. */
  readonly onNeed?: (width: number) => void;
  readonly title: string;
  readonly icon: ThreadSummary["icon"];
  readonly color: ThreadSummary["color"];
  readonly isHome: boolean;
  readonly isVoice?: boolean;
}) {
  const mark = props.isHome ? (
    <ChatOrb size={22} />
  ) : props.isVoice === true ? (
    <Symbol name="waveform" size={20} tint={color.ember} weight="semibold" />
  ) : (
    <TaskMark mark={taskMark(props)} size={22} />
  );
  const name = (style: StyleProp<TextStyle>) => (
    <AppText
      {...(props.maxFontSizeMultiplier === undefined
        ? {}
        : { maxFontSizeMultiplier: props.maxFontSizeMultiplier })}
      numberOfLines={props.numberOfLines}
      role="title"
      style={style}
    >
      {props.title}
    </AppText>
  );
  const { onNeed } = props;
  return (
    <View style={styles.row}>
      {mark}
      {name(styles.nameText)}
      {onNeed === undefined ? null : (
        // A shown name can't say how wide it would be whole, so a hidden copy free of the bar does.
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={styles.ruler}
        >
          <View onLayout={(event) => onNeed(event.nativeEvent.layout.width)} style={styles.row}>
            {mark}
            {name(styles.floor)}
          </View>
        </View>
      )}
    </View>
  );
}

/** Project attribution and state stay separate from the task's subject mark. */
export function ThreadSubtitle(props: {
  readonly workspaceName: string | null;
  readonly workspaceColor: WorkspaceSummary["color"];
  readonly workspaceIcon: WorkspaceSummary["icon"];
  readonly connectionLabel: string | null;
  readonly onRetry?: (() => void) | undefined;
  readonly task: Pick<TaskHeading, "moving" | "tone" | "word"> | null;
}) {
  const { task } = props;
  if (props.workspaceName === null && props.connectionLabel === null && task === null) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.row}>
      {task !== null && props.connectionLabel === null ? (
        <TaskStatus moving={task.moving} tone={task.tone} word={task.word} />
      ) : null}
      {props.workspaceName === null ? null : (
        <View style={[styles.row, styles.workspace]}>
          <WorkspaceMark
            color={props.workspaceColor}
            icon={props.workspaceIcon}
            name={props.workspaceName}
            size="mini"
          />
          <AppText
            maxFontSizeMultiplier={headerFontScaleLimit}
            numberOfLines={1}
            role="caption"
            tone="muted"
            style={styles.workspace}
          >
            {props.workspaceName}
          </AppText>
        </View>
      )}
      {props.connectionLabel === null ? null : (
        <AppText
          numberOfLines={1}
          style={styles.workspace}
          maxFontSizeMultiplier={headerFontScaleLimit}
          role="caption"
          tone="muted"
        >
          {props.connectionLabel}
        </AppText>
      )}
      {props.onRetry ? (
        <Pressable accessibilityRole="button" onPress={props.onRetry} style={styles.retry}>
          <AppText role="caption" tone="soft">
            Retry
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  floor: { maxWidth: barNameFloor },
  nameText: { flexShrink: 1 },
  row: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[6] },
  workspace: { flexShrink: 1 },
  ruler: {
    alignItems: "flex-start",
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 1000,
  },
  retry: { minHeight: touchTarget, minWidth: 48, alignItems: "center", justifyContent: "center" },
});
