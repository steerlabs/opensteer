import { useEffect, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { material, radius, space } from "../theme.js";
import { AppText } from "./primitives.js";

/**
 * The picture's own fact while it shows the place as it last was. Input is
 * off then, so a tap on the picture pulses this instead of doing nothing.
 */
export function LastPictureChip(props: { readonly pulse: number }): ReactNode {
  const scale = useSharedValue(1);
  useEffect(() => {
    if (props.pulse === 0) return;
    scale.value = withSequence(withTiming(0.96, { duration: 0 }), withTiming(1, { duration: 120 }));
  }, [props.pulse, scale]);
  const pulsed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.chip, pulsed]}
    >
      <AppText numberOfLines={1} role="caption" tone="soft">
        Last picture
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    ...material.float,
    borderRadius: radius.full,
    bottom: space[10],
    left: space[10],
    paddingHorizontal: space[10],
    paddingVertical: space[4],
    position: "absolute",
  },
});
