import { markColorPaint, type TaskMark as TaskMarkValue } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { View } from "react-native";
import { color } from "../theme.js";
import { WorkspaceIconGlyph } from "./workspace-mark.js";

/** A task's subject, independent of its state, unread status or specialist. */
export function TaskMark(props: {
  readonly mark: TaskMarkValue;
  readonly size?: 16 | 20 | 22;
  readonly quiet?: boolean;
}): ReactNode {
  const size = props.size ?? 20;
  const glyphSize = size === 16 ? 16 : size === 20 ? 18 : 20;
  const stroke = size === 16 ? 1.5 : size === 20 ? 1.7 : 1.75;
  const glyphColor =
    !props.mark.pending && props.mark.color !== null
      ? markColorPaint[props.mark.color].glyph
      : color.muted;
  const muted = props.mark.pending || props.mark.color === null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        opacity: props.quiet ? 0.6 : 1,
      }}
    >
      <WorkspaceIconGlyph
        color={glyphColor}
        icon={muted ? "document" : props.mark.icon}
        size={glyphSize}
        strokeWidth={(stroke * 24) / glyphSize}
      />
    </View>
  );
}
