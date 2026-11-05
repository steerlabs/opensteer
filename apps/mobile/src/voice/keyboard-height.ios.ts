import { useAnimatedKeyboard, type SharedValue } from "react-native-reanimated";

/** The keyboard's top above the window's bottom, following it frame by frame. */
export function useKeyboardHeight(): SharedValue<number> {
  return useAnimatedKeyboard().height;
}
