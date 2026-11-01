import { markColorPaint, type TaskMark as TaskMarkValue } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color } from "../theme.js";
import { WorkspaceIconGlyph } from "./workspace-mark.js";

/**
 * A task's subject, independent of its state, unread status or specialist: a
 * tile tinted with the task's colour under its symbol, and a neutral tile,
 * empty until the task has a symbol, where either is missing. The web's
 * `.task-mark` draws the same tile at the same sizes.
 */
export function TaskMark(props: {
  readonly mark: TaskMarkValue;
  readonly size?: 16 | 20 | 22;
  readonly quiet?: boolean;
}): ReactNode {
  const size = props.size ?? 20;
  const { icon } = props.mark;
  const paint =
    icon === null || props.mark.color === null ? null : markColorPaint[props.mark.color];
  const tile = tiles[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          backgroundColor: paint?.wash ?? color.surfaceRaised,
          borderRadius: tile.radius,
          height: size,
          width: size,
        },
        props.quiet ? styles.quiet : null,
      ]}
    >
      {icon === null ? null : (
        <WorkspaceIconGlyph
          color={paint?.glyph ?? color.muted}
          icon={icon}
          size={tile.glyph}
          strokeWidth={tile.stroke}
        />
      )}
    </View>
  );
}

/** About 1.4pt of stroke at every size, so the smallest glyph does not thin out. */
const tiles = {
  16: { glyph: 11, radius: 5, stroke: 3 },
  20: { glyph: 14, radius: 6, stroke: 2.4 },
  22: { glyph: 15, radius: 7, stroke: 2.25 },
} as const;

const styles = StyleSheet.create({
  quiet: { opacity: 0.6 },
  tile: {
    alignItems: "center",
    borderColor: color.line,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
  },
});
