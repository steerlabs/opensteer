import { useSafeAreaFrame } from "react-native-safe-area-context";
import { space, touchTarget } from "../theme.js";
import { useContentInsets } from "./pane.js";

/** One bar button: Back, Menu or Ask. */
export const barItemWidth = touchTarget;

/** How far Liquid Glass draws a custom bar item's capsule outside its view. */
export const barGlassInset = space[8];

/**
 * The widest a custom bar title can be beside the bar's own items, given
 * `trailing`, the width of everything after it. A native bar keeps a title
 * view at the size it reports and never shrinks it, so a wider one is drawn
 * under the items or pushed off the screen.
 */
export function useBarTitleWidth(trailing: number): number {
  const { width } = useSafeAreaFrame();
  const insets = useContentInsets();
  // Back or Menu leads, or its place is kept, as beside iPhone Duo's vertical bar.
  const room =
    width - insets.left - insets.right - 2 * barEdge - barItemWidth - 2 * barGap - trailing;
  return Math.max(barItemWidth * 2, Math.min(room, widest));
}

const barEdge = space[16];
const barGap = space[12];
// Past this a title is read as a sentence, not a name.
const widest = 360;
