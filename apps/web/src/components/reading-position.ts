/** Where a reader stands: the first row still in view, and how far its top is from the view's. */
export interface ReadingAnchor {
  readonly key: string;
  readonly offset: number;
}

/** The reading anchor among rows in document order, measured in the same coordinates as `top`. */
export function readingAnchor(
  rows: readonly { readonly key: string; readonly top: number; readonly bottom: number }[],
  viewportTop: number,
): ReadingAnchor | null {
  const row = rows.find(({ bottom, top }) => bottom > viewportTop && bottom > top);
  return row ? { key: row.key, offset: row.top - viewportTop } : null;
}

/** How far to scroll so the anchor row stands where it stood; under a pixel is in place. */
export function anchorCorrection(anchor: ReadingAnchor, rowTop: number, viewportTop: number) {
  const delta = rowTop - viewportTop - anchor.offset;
  return Math.abs(delta) < 1 ? 0 : delta;
}
