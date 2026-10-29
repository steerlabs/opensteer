import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/**
 * A Mac app's mark: its initial on an icon-shaped tile. The Mac draws the real
 * icon and the phone has no copy of it, so this stands where it would. It is
 * decoration; whatever it sits beside names the app.
 */
export function AppMark(props: {
  readonly blocked?: boolean;
  readonly name: string;
  readonly pending?: boolean;
  /** Its side, in points; the initial and the corners keep to it. */
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 32;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        // The corners of a macOS icon, at any size.
        { borderRadius: Math.max(radius.xs, size * 0.225), height: size, width: size },
        props.pending === true && styles.pending,
        props.blocked === true && styles.blocked,
      ]}
    >
      {/* The tile is a fixed size, so its letter is too. */}
      <AppText
        maxFontSizeMultiplier={1}
        role="secondaryMedium"
        style={{ fontSize: Math.round(size * 0.46), lineHeight: Math.round(size * 0.6) }}
        tone="soft"
      >
        {props.name.trim().charAt(0).toUpperCase()}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  blocked: { opacity: 0.45 },
  mark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  pending: {
    backgroundColor: "transparent",
    borderColor: color.lineStrong,
    borderStyle: "dashed",
    borderWidth: 1,
  },
});
