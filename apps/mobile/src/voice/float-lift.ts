/** The floating bar's resting height above the safe area, clear of a screen's own bottom bar. */
export const floatRest = 76;

const keyboardGap = 8;

/** How far the floating bar rises from `rest` so it stays above a keyboard this tall. */
export function floatLift(keyboard: number, rest: number): number {
  "worklet";
  return Math.max(0, keyboard + keyboardGap - rest);
}
