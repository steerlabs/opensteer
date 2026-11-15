/**
 * Within this of the end, a scroller is at its foot: a browser rounds the
 * extent it reports, while the offset lands on fractions of a pixel.
 */
const foot = 1;

/** Where a reader of a growing conversation stood when their scroller was last read. */
export interface TailReading {
  /** Whether new content keeps them at the foot. */
  readonly follows: boolean;
  /** The scroll offset then. */
  readonly offset: number;
}

/**
 * Reads the scroller again, standing at `offset` of the most it scrolls,
 * `max`. Any move toward older content away from the foot lets go at once,
 * however near it; the scroller clamping to a shorter extent is no such move.
 * Only the reader's `own` scroll coming to the foot takes it up again: content
 * arriving or the viewport resizing never does.
 */
export function readTail(
  previous: TailReading,
  offset: number,
  max: number,
  own: boolean,
): TailReading {
  const atFoot = offset >= max - foot;
  const up = offset < previous.offset;
  const follows = previous.follows ? atFoot || !up : own && atFoot && !up;
  return { follows, offset };
}
