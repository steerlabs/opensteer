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

/**
 * The reading anchor among rows laid out top to bottom, found by bisecting on their bottoms: a
 * scroll frame measures a handful of rows however long the transcript, rather than every row
 * above the viewport. An empty row (no height) is passed over.
 */
export function findReadingAnchor(
  rows: ArrayLike<Element>,
  viewportTop: number,
  key: (row: Element) => string | undefined,
): ReadingAnchor | null {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle]!.getBoundingClientRect().bottom > viewportTop) high = middle;
    else low = middle + 1;
  }
  for (let index = low; index < rows.length; index++) {
    const row = rows[index]!;
    const box = row.getBoundingClientRect();
    const name = key(row);
    if (name === undefined || box.bottom <= box.top) continue;
    return { key: name, offset: box.top - viewportTop };
  }
  return null;
}
