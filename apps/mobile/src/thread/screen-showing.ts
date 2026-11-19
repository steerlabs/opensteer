import { useIsFocused } from "@react-navigation/native";
import { useAppForeground } from "../ui/foreground.js";

/**
 * Whether this screen is in front of the person: focused and the app active. A screen stacked
 * under another keeps drawing what it has but holds no subscription of its own.
 */
export function useScreenShowing(): boolean {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  return focused && foreground;
}
