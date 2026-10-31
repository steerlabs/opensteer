import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, material, radius, touchTarget } from "../theme.js";
import type { ComposerActionProps } from "./composer-action.types.js";

/**
 * One circle, drawn at 34 points inside the 44 a finger is owed.
 *
 * The Pressable itself is the full touch target and the circle is painted
 * inside it, rather than a 34-point control with slop around it: slop is a
 * courtesy the platform extends to a stray touch, and the accessibility frame a
 * switch-control or a pointer lands on is the view's own bounds.
 */
export function ComposerAction(props: ComposerActionProps): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.disabled || props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={styles.target}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.button,
            props.kind === "stop" && styles.stop,
            (props.disabled || props.busy) && styles.disabled,
            pressed && (props.kind === "stop" ? styles.stopPressed : styles.pressed),
          ]}
        >
          {props.busy ? (
            <ActivityIndicator color={color.inkOnEmber} />
          ) : props.kind === "stop" ? (
            <View style={styles.square} />
          ) : (
            <View style={styles.arrow}>
              <View style={styles.arrowHead} />
              <View style={styles.arrowStem} />
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.full,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  stop: { ...material.destructive },
  disabled: { opacity: 0.4 },
  pressed: { ...material.accentPressed },
  stopPressed: {
    ...material.platePressed,
    backgroundColor: material.destructive.backgroundColor,
    borderTopColor: material.destructive.borderColor,
  },
  square: { backgroundColor: color.inkOnEmber, borderRadius: 2, height: 11, width: 11 },
  target: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  arrow: { alignItems: "center", height: 17, justifyContent: "center", width: 17 },
  arrowHead: {
    borderLeftColor: color.inkOnEmber,
    borderTopColor: color.inkOnEmber,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    height: 9,
    position: "absolute",
    top: 2,
    transform: [{ rotate: "45deg" }],
    width: 9,
  },
  arrowStem: { backgroundColor: color.inkOnEmber, height: 14, width: 2 },
});
