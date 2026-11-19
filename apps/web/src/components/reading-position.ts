/** Where a reader stands: the first row still in view, and how far its top is from the view's. */
export interface ReadingAnchor {
  readonly key: string;
  readonly offset: number;
  /**
   * The rows around it when it was measured, nearest first: older ones, then newer ones. When a
   * replacement has no `key`, the first of these still on screen stands at the offset instead.
   */
  readonly neighbours?: readonly string[];
}

/** The rows beside `index` among `rows`, nearest first: the older ones, then the newer ones. */
export function neighbourKeys(
  rows: ArrayLike<Element>,
  index: number,
  key: (row: Element) => string | undefined,
  reach = 25,
): string[] {
  const keys: string[] = [];
  for (let at = index - 1; at >= 0 && at >= index - reach; at--) {
    const name = key(rows[at]!);
    if (name !== undefined) keys.push(name);
  }
  for (let at = index + 1; at < rows.length && at <= index + reach; at++) {
    const name = key(rows[at]!);
    if (name !== undefined) keys.push(name);
  }
  return keys;
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

/**
 * Where a replaced transcript puts the reader back: the measured row; else its nearest surviving
 * neighbour, older first; else, for a measurement that recorded neighbours, the latest. Null for
 * an older restore record (no neighbours) whose row is not drawn yet: nothing moves.
 */
export function restoreTarget<Row>(
  anchor: ReadingAnchor,
  find: (key: string) => Row | null,
): Row | "latest" | null {
  for (const key of [anchor.key, ...(anchor.neighbours ?? [])]) {
    const row = find(key);
    if (row !== null) return row;
  }
  return anchor.neighbours ? "latest" : null;
}
