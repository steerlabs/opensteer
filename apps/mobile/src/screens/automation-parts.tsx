import type { ScheduleAnchor } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";

/** A group's name over its rows, announced as a heading. */
export function ScheduleGroupHead(props: {
  readonly attention?: boolean;
  readonly count?: number;
  readonly title: string;
}): ReactNode {
  return (
    <View
      accessibilityLabel={
        props.count === undefined ? props.title : `${props.title}, ${props.count}`
      }
      accessibilityRole="header"
      style={styles.groupHead}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={[styles.groupTitle, props.attention === true && styles.attention]}
        tone="soft"
      >
        {props.title}
      </AppText>
      {props.count === undefined ? null : (
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          role="caption"
          style={styles.count}
          tone="muted"
        >
          {String(props.count)}
        </AppText>
      )}
    </View>
  );
}

/** The task a schedule runs in, by the mark the drawer gives it. */
export function AnchorMark(props: {
  readonly anchor: ScheduleAnchor;
  readonly size: 16 | 20 | 22;
}): ReactNode {
  return <TaskMark mark={props.anchor.mark} quiet={!props.anchor.visible} size={props.size} />;
}

const styles = StyleSheet.create({
  attention: { color: color.red },
  count: { fontVariant: ["tabular-nums"] },
  groupHead: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: space[8],
    paddingBottom: space[8],
    paddingHorizontal: space[4],
    paddingTop: space[20],
  },
  groupTitle: { fontWeight: "600" },
});
