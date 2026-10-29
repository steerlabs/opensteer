import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";

/** What the green dot says to a screen reader, and what a control holding one adds to its name. */
export const agentWorkingLabel = "Agent working";

/**
 * An agent is acting here right now. Green says nothing else.
 *
 * On its own it is named "Agent working". Inside a control that already says
 * so in its own name it is `grouped`, and silent, so it is not read twice.
 */
export function ActingDot(props: {
  readonly grouped?: boolean;
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 7;
  const dot = [styles.dot, { height: size, width: size }];
  return props.grouped === true ? (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={dot} />
  ) : (
    <View accessibilityLabel={agentWorkingLabel} accessibilityRole="image" accessible style={dot} />
  );
}

const styles = StyleSheet.create({
  dot: { backgroundColor: color.green, borderRadius: radius.full },
});
