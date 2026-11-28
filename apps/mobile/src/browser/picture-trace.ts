/**
 * What became of a page's pictures, for a walk to read: development builds only.
 *
 * Every line starts `[opensteer-picture]`, goes to the console (which Metro writes to its log
 * beside a development build), and is never shown to a person or written by a release build,
 * where `__DEV__` is the literal `false`. The native picture view writes its own reasons to the
 * device log under the same prefix.
 */

declare const __DEV__: boolean | undefined;

/** Where trace lines go; a test may take them. */
let sink: ((line: string) => void) | null =
  typeof __DEV__ !== "undefined" && __DEV__ === true ? (line) => console.info(line) : null;

export const pictureTracePrefix = "[opensteer-picture]";

/** Whether this build traces its pictures: a development build, or a test that asked. */
export function pictureTraceEnabled(): boolean {
  return sink !== null;
}

export function tracePicture(line: string): void {
  sink?.(`${pictureTracePrefix} ${line}`);
}

/** For tests: take the lines, or (null) stop tracing. Returns what was there before. */
export function setPictureTraceSink(
  next: ((line: string) => void) | null,
): ((line: string) => void) | null {
  const previous = sink;
  sink = next;
  return previous;
}

/** A view's pictures so far: how many it was offered, and what it answered. */
export interface PictureTally {
  offered: number;
  presented: number;
  dropped: number;
  failed: number;
  /** Deliveries never offered to the view (no view yet, another tab, too large). */
  skipped: number;
}

export function emptyPictureTally(): PictureTally {
  return { dropped: 0, failed: 0, offered: 0, presented: 0, skipped: 0 };
}

/** What the page is waiting for, in a line a walk reads and a development label shows. */
export function pictureWait(tally: PictureTally, pictureArrived: boolean): string {
  if (!pictureArrived && tally.offered === 0) return "no picture has arrived";
  if (tally.offered === 0) return "a picture arrived but was never offered to the view";
  if (tally.presented > 0) return "the view presented a picture";
  if (tally.offered === tally.dropped)
    return `the view dropped every picture so far (${tally.dropped})`;
  if (tally.failed > 0) return `the view could not decode ${tally.failed} of ${tally.offered}`;
  return `the view has not answered ${tally.offered - tally.dropped - tally.failed} of ${tally.offered}`;
}
