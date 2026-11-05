import { useEffect } from "react";
import { Keyboard } from "react-native";
import { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { duration } from "../ui/motion.js";

/**
 * The keyboard's top above the window's bottom. Not `useAnimatedKeyboard`: on
 * Android it replaces the decor view's insets listener and clears it on leaving,
 * and react-native-screens never registers again, so every form sheet would lose
 * its keyboard handling after the person's first call.
 */
export function useKeyboardHeight(): SharedValue<number> {
  const height = useSharedValue(0);
  const { bottom } = useSafeAreaInsets();
  useEffect(() => {
    // Android measures the keyboard from the navigation bar, not the window's edge.
    const open = Keyboard.metrics();
    if (open && Keyboard.isVisible()) height.value = open.height + bottom;
    const show = Keyboard.addListener("keyboardDidShow", ({ endCoordinates }) => {
      height.value = withTiming(endCoordinates.height + bottom, { duration: duration.enter });
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      height.value = withTiming(0, { duration: duration.exit });
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bottom, height]);
  return height;
}
