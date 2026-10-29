import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { ActingDot, agentWorkingLabel } from "./acting-dot.js";

/**
 * A conversation's Tabs control: the word, with the green dot while an agent
 * is acting in one of its tabs or apps. No count: a number on a bar item
 * reads as notifications, and the grid says how many there are.
 */
export function BrowserButton(props: {
  readonly acting: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint="Opens this conversation's tabs and apps"
      accessibilityLabel={props.acting ? `Tabs, ${agentWorkingLabel.toLowerCase()}` : "Tabs"}
      accessibilityRole="button"
      hitSlop={space[6]}
      onPress={props.onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {props.acting ? <ActingDot grouped /> : null}
      <AppText maxFontSizeMultiplier={headerFontScaleLimit} role="secondaryMedium" tone="ember">
        Tabs
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: touchTarget,
    paddingHorizontal: space[8],
  },
  pressed: { opacity: 0.6 },
});
