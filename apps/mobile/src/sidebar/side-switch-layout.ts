import type { SidebarSide } from "./sidebar-side.js";

/** A segment drawn as its mark alone, at a full touch target. */
export const markSegmentWidth = 44;
/** The least the chosen segment keeps for its mark, a few letters of its name and its count. */
export const chosenSegmentMinWidth = 104;
export const segmentGap = 2;
export const trackPadding = 3;

/** What the switch draws: segments in order, and the teams folded into its last one. */
export interface SwitchLayout {
  readonly shown: readonly SidebarSide[];
  readonly folded: readonly SidebarSide[];
  /** Every segment says its name; otherwise only the chosen one does. */
  readonly named: boolean;
}

/**
 * Tasks and every team, as many as the track holds. Two sides split it evenly
 * and both are named. More draw their marks, with the chosen one named, and
 * past what fits the rest fold into one last segment that opens them as a
 * menu. The chosen side is always drawn, in its place in the order; Tasks,
 * first, is the last to fold. Unmeasured, every side is drawn.
 */
export function switchLayout(
  sides: readonly SidebarSide[],
  active: SidebarSide,
  width: number,
): SwitchLayout {
  if (sides.length <= 2) return { shown: sides, folded: [], named: true };
  const room = width - trackPadding * 2 - chosenSegmentMinWidth;
  const marks = Math.floor(room / (markSegmentWidth + segmentGap));
  if (width <= 0 || marks >= sides.length - 1) return { shown: sides, folded: [], named: false };
  // One mark's place goes to the folded segment.
  const others = Math.max(1, marks - 1);
  const kept = new Set([active, ...sides.filter((side) => side !== active).slice(0, others)]);
  return {
    shown: sides.filter((side) => kept.has(side)),
    folded: sides.filter((side) => !kept.has(side)),
    named: false,
  };
}
