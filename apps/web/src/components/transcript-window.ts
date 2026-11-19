import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptGroup } from "@opensteer/client/host";

/** Below this many rows every row is drawn; windowing pays only on long conversations. */
export const transcriptWindowMinimum = 60;
/** The newest rows are always drawn: the turn under way streams there and the tail follows it. */
export const transcriptPinnedTail = 4;
const estimatedRowHeight = 160;

export type TranscriptSegment =
  | { readonly kind: "rows"; readonly from: number; readonly to: number }
  | { readonly kind: "gap"; readonly from: number; readonly to: number; readonly height: number };

/**
 * Which rows to draw, as runs of rows and the gaps between them. A row is drawn when it is within
 * `overscan` of the viewport, among the pinned tail, or kept (with the row above it, so a page
 * prepended above a kept anchor has a neighbour to measure). `sizes` are measured row heights
 * including the gap after each row; an unmeasured row counts as the average measured one.
 */
export function transcriptWindow(input: {
  readonly keys: readonly string[];
  readonly sizes: ReadonlyMap<string, number>;
  /** The viewport's top, from the first row's top, or null to start at the tail. */
  readonly top: number | null;
  readonly height: number;
  readonly overscan: number;
  readonly keep: ReadonlySet<string>;
}): readonly TranscriptSegment[] {
  const { keys, sizes } = input;
  if (keys.length <= transcriptWindowMinimum) return [{ kind: "rows", from: 0, to: keys.length }];
  let measured = 0;
  let total = 0;
  for (const key of keys) {
    const size = sizes.get(key);
    if (size === undefined) continue;
    measured++;
    total += size;
  }
  const estimate = measured ? total / measured : estimatedRowHeight;
  const size = (index: number) => sizes.get(keys[index]!) ?? estimate;
  let length = 0;
  for (let index = 0; index < keys.length; index++) length += size(index);
  const top = input.top ?? Math.max(0, length - input.height);
  const from = top - input.overscan;
  const to = top + input.height + input.overscan;
  const drawn = Array.from({ length: keys.length }, () => false);
  let start = 0;
  for (let index = 0; index < keys.length; index++) {
    const end = start + size(index);
    if (
      (end > from && start < to) ||
      index >= keys.length - transcriptPinnedTail ||
      input.keep.has(keys[index]!)
    ) {
      drawn[index] = true;
      if (input.keep.has(keys[index]!) && index > 0) drawn[index - 1] = true;
    }
    start = end;
  }
  const segments: TranscriptSegment[] = [];
  let index = 0;
  while (index < keys.length) {
    const first = index;
    if (drawn[index]) {
      while (index < keys.length && drawn[index]) index++;
      segments.push({ kind: "rows", from: first, to: index });
    } else {
      let height = 0;
      while (index < keys.length && !drawn[index]) height += size(index++);
      segments.push({ kind: "gap", from: first, to: index, height: Math.round(height) });
    }
  }
  return segments;
}

/** The row a transcript entry is drawn in, for a jump or a reveal to keep it drawn. */
export function transcriptRowOf(
  rows: readonly { readonly key: string; readonly group: TranscriptGroup }[],
  entryId: string,
): string | null {
  for (const { key, group } of rows) {
    if (group.kind !== "turn") {
      if (group.entry.id === entryId) return key;
      continue;
    }
    const { turn } = group;
    if (
      turn.reply?.id === entryId ||
      turn.run?.id === entryId ||
      turn.work.some((entry) => entry.id === entryId) ||
      turn.assignments.some((entry) => entry.id === entryId)
    )
      return key;
  }
  return null;
}

/**
 * Draws a long transcript's rows near the viewport and stands measured gaps in for the rest. The
 * rows stay in normal flow, so the scroller's own tail-following and anchor code keep working, and
 * a browser's scroll anchoring holds the reader in place when a row above them is measured.
 */
export function useTranscriptWindow(input: {
  readonly keys: readonly string[];
  readonly scroller: (() => HTMLElement | null) | null;
  readonly keep: ReadonlySet<string>;
}) {
  const { keys, scroller, keep } = input;
  const sizes = useRef(new Map<string, number>());
  const [view, setView] = useState<{ top: number | null; height: number; revision: number }>({
    top: null,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    revision: 0,
  });
  const start = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ keys, keep });
  latest.current = { keys, keep };
  const kept = () => withReaderHeld(latest.current.keep);
  const active = scroller !== null && keys.length > transcriptWindowMinimum;
  const segments = useMemo(
    () =>
      active
        ? transcriptWindow({
            keys,
            sizes: sizes.current,
            top: view.top,
            height: view.height,
            overscan: view.height,
            keep: withReaderHeld(keep),
          })
        : [{ kind: "rows" as const, from: 0, to: keys.length }],
    // A new `view` is how a scroll or a measurement reaches the window.
    [active, keep, keys, view],
  );
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const geometry = useCallback(() => {
    const element = scroller?.();
    const first = start.current;
    if (!element || !first) return null;
    const box = element.getBoundingClientRect();
    return {
      element,
      top: element.scrollTop - (first.getBoundingClientRect().top - box.top + element.scrollTop),
      height: element.clientHeight,
    };
  }, [scroller]);

  // Re-windows when the reader moves far enough to change which rows are drawn.
  const reread = useCallback(
    (measuredChange: boolean) => {
      const read = geometry();
      if (!read) return;
      const next = transcriptWindow({
        keys: latest.current.keys,
        sizes: sizes.current,
        top: read.top,
        height: read.height,
        overscan: read.height,
        keep: kept(),
      });
      if (!measuredChange && sameSegments(next, segmentsRef.current)) return;
      setView((previous) => ({
        top: read.top,
        height: read.height,
        revision: previous.revision + 1,
      }));
    },
    [geometry],
  );

  useEffect(() => {
    const element = active ? scroller?.() : null;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reread(false);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [active, reread, scroller]);

  const observer = useMemo(() => {
    if (!active || typeof ResizeObserver === "undefined") return null;
    let frame = 0;
    return new ResizeObserver((entries) => {
      const element = scroller?.();
      const viewportTop = element?.getBoundingClientRect().top ?? 0;
      let changed = false;
      let above = 0;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const key = target.dataset.transcriptUnit;
        if (!key) continue;
        const height = target.getBoundingClientRect().height;
        const gap = Number.parseFloat(
          target.parentElement ? getComputedStyle(target.parentElement).rowGap : "0",
        );
        const size = height > 0 ? height + (Number.isFinite(gap) ? gap : 0) : 0;
        const previous = sizes.current.get(key);
        if (previous === size) continue;
        sizes.current.set(key, size);
        changed = true;
        if (target.getBoundingClientRect().bottom <= viewportTop)
          above += size - (previous ?? size);
      }
      // A browser without scroll anchoring would let a row measured above the reader push them.
      if (above && element && !CSS.supports("overflow-anchor", "auto")) element.scrollTop += above;
      if (!changed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reread(true);
      });
    });
  }, [active, reread, scroller]);
  useEffect(() => () => observer?.disconnect(), [observer]);

  // Forgets rows no longer in the conversation.
  useLayoutEffect(() => {
    if (sizes.current.size <= keys.length * 2) return;
    const held = new Set(keys);
    for (const key of sizes.current.keys()) if (!held.has(key)) sizes.current.delete(key);
  }, [keys]);

  const measure = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !observer) return;
      observer.observe(element);
      return () => observer.unobserve(element);
    },
    [observer],
  );
  return { segments, measure, start, windowed: active };
}

/** Rows the reader has focus or a text selection in stay drawn, wherever they scroll. */
function withReaderHeld(keep: ReadonlySet<string>): ReadonlySet<string> {
  if (typeof document === "undefined") return keep;
  const held = [document.activeElement, document.getSelection()?.anchorNode ?? null].flatMap(
    (node) => {
      const element = node instanceof Element ? node : (node?.parentElement ?? null);
      const key = element?.closest<HTMLElement>("[data-transcript-unit]")?.dataset.transcriptUnit;
      return key && !keep.has(key) ? [key] : [];
    },
  );
  return held.length ? new Set([...keep, ...held]) : keep;
}

function sameSegments(left: readonly TranscriptSegment[], right: readonly TranscriptSegment[]) {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index]!;
    if (segment.kind === "rows")
      return other.kind === "rows" && other.from === segment.from && other.to === segment.to;
    return (
      other.kind === "gap" &&
      other.from === segment.from &&
      other.to === segment.to &&
      Math.abs(other.height - segment.height) < 1
    );
  });
}
