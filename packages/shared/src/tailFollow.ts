/** Scroll offsets land on fractions of a pixel: a change within this is no move. */
const still = 0.5;
/** Within this of the end, a scroller stands at its foot. */
const foot = 2;

/** Where a reader of a growing conversation stood when their scroller was last read. */
export interface TailReading {
  /** Whether new content keeps them at the foot. */
  readonly follows: boolean;
  /** The scroll offset then. */
  readonly offset: number;
}

/**
 * Reads the scroller again, standing at `offset` of the most it scrolls,
 * `max`. Any move toward older content lets go of the foot at once, however
 * near it; the scroller clamping to a shorter extent is no such move. Only the
 * reader's `own` scroll reaching the foot takes it up again: content arriving
 * or the viewport resizing never does.
 */
export function readTail(
  previous: TailReading,
  offset: number,
  max: number,
  own: boolean,
): TailReading {
  const follows = previous.follows
    ? offset >= previous.offset - still || offset >= max - still
    : own && offset >= max - foot;
  return { follows, offset };
}
