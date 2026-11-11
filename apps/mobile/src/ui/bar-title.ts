import { useSafeAreaFrame } from "react-native-safe-area-context";
import { space, touchTarget } from "../theme.js";
import { useContentInsets } from "./pane.js";

/** One bar button: Back, Menu or Ask. */
export const barItemWidth = touchTarget;

/** How far Liquid Glass draws a custom bar item's capsule outside its view. */
export const barGlassInset = space[8];

/** The least of a name a bar keeps before anything beside it gives way, as on the web. */
export const barNameFloor = 64;

/**
 * The widest a custom bar title can be beside the bar's own items, given
 * `trailing`, the width of everything after it. A native bar keeps a title
 * view at the size it reports and never shrinks it, so a wider one is drawn
 * under the items or pushed off the screen.
 */
export function useBarTitleWidth(trailing: number): number {
  return barTitleWidth(useBarTitleRoom(), trailing);
}

/** The bar's room for a title and whatever trails it. */
export function useBarTitleRoom(): number {
  const { width } = useSafeAreaFrame();
  const insets = useContentInsets();
  // Back or Menu leads, or its place is kept, as beside iPhone Duo's vertical bar.
  return width - insets.left - insets.right - 2 * barEdge - barItemWidth - 2 * barGap;
}

export function barTitleWidth(room: number, trailing: number): number {
  return Math.max(barItemWidth * 2, Math.min(room - trailing, widest));
}

/**
 * A bar degrades by design, as the web's does: the name truncates first, down
 * to `barNameFloor` or its whole self if shorter; past that, what trails it
 * gives way in order. `need` is the title's width at that point, `trailing`
 * what trails it with nothing given way, and `freed` what each part that can
 * give way frees, in order. Returns how many give way.
 */
export function barYield(input: {
  readonly freed: readonly number[];
  readonly need: number;
  readonly room: number;
  readonly trailing: number;
}): number {
  let left = input.room - input.trailing;
  let yielded = 0;
  while (yielded < input.freed.length && left < input.need) left += input.freed[yielded++] ?? 0;
  return yielded;
}

const barEdge = space[16];
const barGap = space[12];
// Past this a title is read as a sentence, not a name.
const widest = 360;
