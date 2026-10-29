import type { MarkColor, WorkspaceIconName } from "@opensteer/core";
import { markColorPaint, workspaceIconArt, workspaceMonogram } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  Line,
  LinearGradient,
  Path,
  Polyline,
  Rect,
  Stop,
} from "react-native-svg";
import { color, radius, space } from "../theme.js";

/**
 * A Workspace's identity, as small as it can be and still be recognised.
 *
 * The mark is decoration in the accessibility tree — a screen reader hears the
 * Workspace's name from the row's own text — so it is hidden rather than
 * announced twice. Its initials never scale with Dynamic Type: they are a
 * graphic sized to the mark, not text anyone is meant to read.
 */
export function WorkspaceMark(props: {
  readonly icon?: WorkspaceIconName | null;
  readonly name: string;
  readonly size?: "mini" | "small" | "medium";
  readonly color: MarkColor | null;
}): ReactNode {
  const tile = props.color === null ? null : markColorPaint[props.color].tile;
  const ink = tile === null ? color.muted : color.text;
  const small = props.size === "small";
  const mini = props.size === "mini";
  const icon = props.icon ?? null;
  const glyphSize = mini ? 10 : small ? 13 : 18;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[mini ? styles.mini : small ? styles.small : styles.medium, styles.mark]}
    >
      <Svg height="100%" width="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={tile?.[0] ?? color.surfaceRaised} />
            <Stop offset="1" stopColor={tile?.[1] ?? color.surfaceElevated} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#tile)" />
      </Svg>
      {icon === null ? (
        <Text
          allowFontScaling={false}
          style={[styles.initials, small ? styles.initialsSmall : null, { color: ink }]}
        >
          {workspaceMonogram(props.name)}
        </Text>
      ) : (
        <WorkspaceIconGlyph color={ink} icon={icon} size={glyphSize} />
      )}
    </View>
  );
}

/**
 * The same 24×24 artwork the web draws, so an agent's icon reads identically
 * on every platform rather than through SF Symbols on one and a character on
 * the other.
 */
export function WorkspaceIconGlyph(props: {
  readonly color: string;
  readonly icon: WorkspaceIconName;
  readonly size: number;
  readonly strokeWidth?: number;
}): ReactNode {
  return (
    <Svg
      // `currentColor` in the artwork (its few filled dots) resolves to this.
      color={props.color}
      fill="none"
      height={props.size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={props.strokeWidth ?? 2}
      viewBox="0 0 24 24"
      width={props.size}
    >
      {workspaceIconArt[props.icon].elements.map(([tag, attributes], index) => {
        switch (tag) {
          case "circle":
            return <Circle key={index} {...attributes} />;
          case "ellipse":
            return <Ellipse key={index} {...attributes} />;
          case "line":
            return <Line key={index} {...attributes} />;
          case "path":
            return <Path key={index} {...attributes} />;
          case "polyline":
            return <Polyline key={index} {...attributes} />;
          case "rect":
            return <Rect key={index} {...attributes} />;
        }
      })}
    </Svg>
  );
}

/** The same identity where there is no room for initials: a coloured dot. */
export function WorkspaceDot(props: { readonly color: MarkColor | null }): ReactNode {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.dot,
        { backgroundColor: props.color === null ? color.muted : markColorPaint[props.color].glyph },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { borderRadius: radius.full, height: 8, width: 8 },
  initials: { fontSize: 11, fontWeight: "700", letterSpacing: -0.4 },
  initialsSmall: { fontSize: 9 },
  mark: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  mini: { borderRadius: radius.xs, height: 16, width: 16 },
  medium: { borderRadius: radius.sm, height: 32, width: 32 },
  small: { borderRadius: space[6], height: 22, width: 22 },
});
