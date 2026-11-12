/** The stage, in its own units. `demo.css` draws to the same numbers. */
export const STAGE_SIZE = { width: 1200, height: 720 } as const;
/** At this width and below the stage crops to the phone. */
export const PHONE_ONLY = "(max-width: 900px)";
export const CROP = { x: 0, y: 30, width: 306 } as const;
/** A 13-inch MacBook Air at its 1280x832 resolution, in points. */
export const DESKTOP = { width: 1280, height: 832 } as const;
/** The live page in a thread on the phone, in the phone's points. */
export const PAGE = {
  /** Folded into the thread's bar. */
  folded: { width: 46, height: 30 },
  /** Open under the bar, at a scale that keeps what the agent touches readable. */
  open: { width: 393, height: 246, scale: 0.62 },
} as const;
