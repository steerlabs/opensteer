import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Whether this screen has iOS's vertical bar, measured where the screen is: it
 * is the one thing that insets a single side, as a notch insets both. UIKit
 * moves native bar items into it, and only then is a native bar free of a row
 * over the page. Ask at a screen's root: a pane beside another has one-sided
 * insets of its own.
 */
export function useVerticalBar(): boolean {
  const { left, right } = useSafeAreaInsets();
  return Platform.OS === "ios" && left !== right;
}
