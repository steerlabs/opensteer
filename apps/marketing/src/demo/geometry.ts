/** The stage, in its own units, and the pieces placed on it. `demo.css` draws to the same numbers. */
export const STAGE_SIZE = { width: 1200, height: 720 } as const;
/** At this width and below the stage crops to the phone. */
export const PHONE_ONLY = "(max-width: 900px)";
export const CROP = { x: 16, width: 376 } as const;
export const DESKTOP = { width: 1040, height: 676 } as const;
/** Each agent's windows and cursor live in one box of desktop points. */
export const GROUP = { width: 700, height: 540 } as const;
/** Where the watched agent's group sits on the desktop. */
export const MAIN_SLOT = [20, 38] as const;
/** The piece of desktop the phone's live view frames, and the scale it draws it at. */
export const LIVE = { width: 452, height: 312, scale: 0.5 } as const;
