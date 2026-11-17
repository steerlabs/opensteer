import { Pressable, StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { taskMark, type ThreadSummary } from "@opensteer/client/host";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { BarControl } from "../ui/bar-control.js";
import { barNameFloor } from "../ui/bar-title.js";
import { AppText } from "../ui/primitives.js";
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
  readonly isVoice?: boolean;
}) {
  const mark =
    props.isVoice === true ? (
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

/** The channel that asked, if any, and the task's state, apart from its mark. */
export function ThreadSubtitle(props: {
  /** The team channel that asked, "#support". */
  readonly placeName: string | null;
  readonly connectionLabel: string | null;
  readonly onRetry?: (() => void) | undefined;
  readonly task: Pick<TaskHeading, "moving" | "tone" | "word"> | null;
}) {
  const { task } = props;
  if (props.placeName === null && props.connectionLabel === null && task === null) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.row}>
      {task !== null && props.connectionLabel === null ? (
        <TaskStatus moving={task.moving} tone={task.tone} word={task.word} />
      ) : null}
      {props.placeName === null ? null : (
        <View style={[styles.row, styles.workspace]}>
          <Symbol name="number" size={11} tint={color.muted} />
          <AppText
            maxFontSizeMultiplier={headerFontScaleLimit}
            numberOfLines={1}
            role="caption"
            tone="muted"
            style={styles.workspace}
          >
            {props.placeName}
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
        <BarControl>
          <Pressable accessibilityRole="button" onPress={props.onRetry} style={styles.retry}>
            <AppText role="caption" tone="soft">
              Retry
            </AppText>
          </Pressable>
        </BarControl>
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
