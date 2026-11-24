import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoundedCache } from "@opensteer/shared/boundedCache";
import { windowPlan, type WindowItem } from "./workspace/windowed-rows.js";

/** Generous off-screen draw distance (px) above and below the viewport, matching Legend List. */
const transcriptOverscanPx = 900;

/** Rows laid out at widths this close wrap alike, so they share their measured heights. */
const widthStepPx = 16;
const widthClass = (width: number) => Math.round(width / widthStepPx);

/**
 * Each row's last measured height (px, excluding the list's gap), by the width it was laid out at
 * and its row key, shared by every transcript: row keys are item and turn ids, unique across
 * Threads. A task switched back to lays out at its rows' real heights at once, so its scroll
 * position is put back exactly. A row never measured at the list's width stands at its estimate:
 * a narrow column's heights would make a wide one's spacers far too tall.
 */
const measuredHeights = new BoundedCache<string, number>({ maxEntries: 10_000 });

export const rowHeights = {
  /** The row's height as last measured at this width, if it was. */
  peek: (width: number | null, key: string): number | undefined =>
    width === null ? undefined : measuredHeights.peek(heightKey(width, key)),
  set: (width: number, key: string, height: number): void =>
    measuredHeights.set(heightKey(width, key), height),
};

function heightKey(width: number, key: string): string {
  return `${widthClass(width)}:${key}`;
}

/** The width the last list was laid out at: the next one opens in the same column, most likely. */
let lastWidth: number | null = null;

export interface VirtualTranscriptOptions {
  /** Scroll container getter; null disables virtualization (e.g. SSR or static previews). */
  readonly scroller: (() => HTMLElement | null) | null;
  /** Stable row keys in document order. */
  readonly keys: readonly string[];
  /** Estimated outer height (px, excluding flex gap) for an unmeasured row. */
  readonly estimate: (index: number) => number;
  /** Row keys that must remain mounted regardless of scroll offset (jump target, focus). */
  readonly pinnedKeys: readonly string[];
  /** The last rows stay mounted, up to this many and this tall in all (px), so live work is too. */
  readonly tail?: { readonly rows: number; readonly px: number } | undefined;
  /** Start the initial window at the tail before the scroller has been positioned. */
  readonly initialAtTail?: boolean;
  /** True only while the caller is actively following the live tail (never during historical jumps). */
  readonly followTail?: boolean;
}

export interface VirtualTranscriptState {
  readonly enabled: boolean;
  readonly items: readonly WindowItem[];
  /** Ref callback for each mounted virtual slot to register height measurement. */
  readonly observeRow: (key: string, element: HTMLElement | null) => void;
}

interface VisualAnchor {
  readonly key: string;
  readonly offset: number;
  readonly scrollTop: number;
}

/**
 * Variable-height viewport virtualization for transcripts.
 *
 * Keeps only visible rows (+ overscan + pinned tail/jump/focus rows) in the DOM,
 * measures real row heights via ResizeObserver + layout effects, and pins the
 * visible anchor row's exact viewport offset whenever off-screen rows above it
 * mount, unmount, or resize so scrolling up never jumps.
 */
export function useVirtualTranscript({
  scroller,
  keys,
  estimate,
  pinnedKeys,
  tail,
  initialAtTail = true,
  followTail = false,
}: VirtualTranscriptOptions): VirtualTranscriptState {
  const enabled = scroller !== null;
  const elements = useRef(new Map<string, HTMLElement>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const initialized = useRef(false);
  const scroll = useRef({ top: 0, height: 0, offsetTop: 0 });
  const anchorRef = useRef<VisualAnchor | null>(null);
  const programmaticScrollTop = useRef<number | null>(null);
  const tailBroken = useRef(false);
  const prevFollowTail = useRef(followTail);
  if (followTail && !prevFollowTail.current) {
    tailBroken.current = false;
  } else if (!followTail) {
    tailBroken.current = false;
  }
  prevFollowTail.current = followTail;
  const lastTailGeometry = useRef<{
    readonly height: number;
    readonly viewport: number;
    readonly scrollTop: number;
  } | null>(null);
  // The width rows are laid out at is known once one is drawn; until then, the last list's.
  const [view, setView] = useState(() => ({ gap: 4, version: 0, width: lastWidth }));

  const sizes = useMemo(
    () =>
      keys.map((key, index) => {
        const height = rowHeights.peek(view.width, key) ?? estimate(index);
        return height + view.gap;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimate, keys, view.gap, view.version, view.width],
  );

  // While following the tail (or before the first real scroll measurement on initial tail open),
  // target the true bottom of the measured/estimated list so height updates mount tail rows in
  // one pass instead of lagging behind an old scrollTop.
  const effectiveTop = useMemo(() => {
    if ((followTail && !tailBroken.current) || (!initialized.current && initialAtTail)) {
      const viewport =
        scroll.current.height || (typeof window !== "undefined" ? window.innerHeight : 900);
      let total = 0;
      for (const size of sizes) total += size;
      return Math.max(0, total - viewport);
    }
    return scroll.current.top;
  }, [followTail, initialAtTail, sizes]);

  const effectiveHeight =
    scroll.current.height || (typeof window !== "undefined" ? window.innerHeight : 900);

  const tailRows = tail?.rows ?? 0;
  const tailPx = tail?.px ?? 0;
  const pinnedIndices = useMemo(() => {
    if (!enabled) return [] as number[];
    const out = new Set<number>();
    let height = 0;
    for (
      let index = keys.length - 1;
      index >= Math.max(0, keys.length - tailRows) && height < tailPx;
      index--
    ) {
      out.add(index);
      height += sizes[index]! - view.gap;
    }
    if (pinnedKeys.length > 0) {
      const byKey = new Map<string, number>();
      for (let index = 0; index < keys.length; index++) byKey.set(keys[index]!, index);
      for (const key of pinnedKeys) {
        const index = byKey.get(key);
        if (index !== undefined) out.add(index);
      }
    }
    return [...out];
  }, [enabled, keys, pinnedKeys, sizes, tailPx, tailRows, view.gap]);

  const items: readonly WindowItem[] = useMemo(() => {
    if (!enabled) return keys.map((_, index) => ({ index }));
    return windowPlan({
      sizes,
      gap: view.gap,
      top: effectiveTop,
      height: effectiveHeight,
      overscan: transcriptOverscanPx,
      pinned: pinnedIndices,
    });
  }, [effectiveHeight, effectiveTop, enabled, keys, pinnedIndices, sizes, view.gap]);

  const latest = useRef({
    enabled,
    followTail,
    gap: view.gap,
    items,
    pinnedIndices,
    scroller,
    sizes,
    width: view.width,
  });
  latest.current = {
    enabled,
    followTail,
    gap: view.gap,
    items,
    pinnedIndices,
    scroller,
    sizes,
    width: view.width,
  };

  /** Captures the top-most visible mounted row's pixel offset from the scrollport top. */
  const captureAnchor = useRef((scrollerEl: HTMLElement): VisualAnchor | null => {
    if ((latest.current.followTail && !tailBroken.current) || scrollerEl.scrollTop <= 0) {
      return null;
    }
    const rect = scrollerEl.getBoundingClientRect();
    let best: { key: string; offset: number } | null = null;
    for (const [key, element] of elements.current) {
      if (!element.isConnected) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom <= rect.top + 1 || box.top >= rect.bottom) continue;
      const offset = box.top - rect.top;
      if (best === null || offset < best.offset) {
        best = { key, offset };
      }
    }
    return best ? { ...best, scrollTop: scrollerEl.scrollTop } : null;
  });

  /** Restores the captured visible row to its exact viewport pixel offset before paint. */
  const restoreAnchor = useRef((scrollerEl: HTMLElement) => {
    const held = anchorRef.current;
    if (!held) return;
    // If the user scrolled since the anchor was captured, discard the stale anchor.
    if (Math.abs(scrollerEl.scrollTop - held.scrollTop) > 1) {
      anchorRef.current = captureAnchor.current(scrollerEl);
      return;
    }
    const element = elements.current.get(held.key);
    if (!element || !element.isConnected) {
      anchorRef.current = captureAnchor.current(scrollerEl);
      return;
    }
    const rect = scrollerEl.getBoundingClientRect();
    const drift = element.getBoundingClientRect().top - rect.top - held.offset;
    if (Math.abs(drift) >= 0.5) {
      const nextScrollTop = Math.max(0, scrollerEl.scrollTop + drift);
      programmaticScrollTop.current = nextScrollTop;
      scrollerEl.scrollTop = nextScrollTop;
      const appliedScrollTop = scrollerEl.scrollTop;
      programmaticScrollTop.current = appliedScrollTop;
      const actualDelta = appliedScrollTop - held.scrollTop;
      scroll.current = {
        ...scroll.current,
        top: Math.max(0, scroll.current.top + actualDelta),
      };
      anchorRef.current = {
        key: held.key,
        offset: element.getBoundingClientRect().top - rect.top,
        scrollTop: appliedScrollTop,
      };
    }
  });

  /** Measures mounted rows, compensates any height drift above the viewport, and schedules updates. */
  const commitMeasurements = useRef(() => {
    const {
      enabled: isEnabled,
      followTail: isFollowingTail,
      gap,
      scroller: getScroller,
      width,
    } = latest.current;
    if (!isEnabled) return;
    const scrollerEl = getScroller?.() ?? null;

    if (scrollerEl) {
      if (isFollowingTail && !tailBroken.current) {
        const previous = lastTailGeometry.current;
        const userMovedUp =
          previous !== null &&
          previous.height === scrollerEl.scrollHeight &&
          previous.viewport === scrollerEl.clientHeight &&
          scrollerEl.scrollTop < previous.scrollTop - 1;
        if (userMovedUp) {
          tailBroken.current = true;
          lastTailGeometry.current = null;
        } else {
          // Pin the scroller to the tail synchronously before paint so spacer/row height
          // adjustments never leave scrollTop short of scrollHeight or trigger a shrink+grow
          // clamp that detaches tail-follow.
          const maxTop = Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight);
          if (Math.abs(scrollerEl.scrollTop - maxTop) >= 0.5) {
            programmaticScrollTop.current = maxTop;
            scrollerEl.scrollTop = scrollerEl.scrollHeight;
            programmaticScrollTop.current = scrollerEl.scrollTop;
          }
          scroll.current = {
            ...scroll.current,
            top: Math.max(0, scrollerEl.scrollTop - scroll.current.offsetTop),
          };
          lastTailGeometry.current = {
            height: scrollerEl.scrollHeight,
            viewport: scrollerEl.clientHeight,
            scrollTop: scrollerEl.scrollTop,
          };
        }
      } else {
        lastTailGeometry.current = null;
        // Restore the visual anchor if the newly committed DOM shifted the row in view.
        restoreAnchor.current(scrollerEl);
      }
    }

    let changed = false;
    let measuredWidth: number | null = null;
    for (const [key, element] of elements.current) {
      if (!element.isConnected) continue;
      const box = element.getBoundingClientRect();
      if (box.height <= 0) continue;
      // Every row fills the list's width, so any drawn row says what width the list lays out at.
      measuredWidth = box.width;
      const previous = rowHeights.peek(box.width, key);
      // Set even when unchanged: a drawn row is the most recently used, so it is never dropped.
      rowHeights.set(box.width, key, box.height);
      if (previous === undefined || Math.abs(previous - box.height) >= 0.5) changed = true;
    }
    if (measuredWidth !== null) lastWidth = measuredWidth;
    const widthChanged =
      measuredWidth !== null && (width === null || widthClass(measuredWidth) !== widthClass(width));

    const sample = elements.current.values().next().value;
    const parent = sample?.parentElement;
    const nextGap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : gap;

    if (scrollerEl) {
      anchorRef.current = captureAnchor.current(scrollerEl);
    }

    if (changed || widthChanged || Math.abs(nextGap - gap) > 0.5) {
      setView((current) => ({
        gap: nextGap,
        version: current.version + 1,
        width: widthChanged ? measuredWidth : current.width,
      }));
    }
  });

  const observeRow = useMemo(
    () => (key: string, element: HTMLElement | null) => {
      const previous = elements.current.get(key);
      if (previous === element) return;
      if (previous) {
        resizeObserver.current?.unobserve(previous);
        elements.current.delete(key);
      }
      if (element) {
        elements.current.set(key, element);
        resizeObserver.current?.observe(element);
      }
    },
    [],
  );

  // Mark the scroller as virtualized before first paint so browser heuristic scroll anchoring
  // never fights our own pre-paint tail/anchor pinning on frame 1.
  useLayoutEffect(() => {
    if (!enabled) return;
    const node = scroller?.() ?? null;
    if (!node) return;
    node.dataset.virtualized = "true";
    return () => {
      delete node.dataset.virtualized;
    };
  }, [enabled, scroller]);

  // Measure mounted rows and lock visual anchor synchronously before paint after every commit.
  useLayoutEffect(() => {
    if (!enabled) return;
    commitMeasurements.current();
  });

  // Shared ResizeObserver catches async Markdown/image/collapsible height changes.
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      commitMeasurements.current();
    });
    resizeObserver.current = observer;
    for (const element of elements.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      if (resizeObserver.current === observer) resizeObserver.current = null;
    };
  }, [enabled]);

  // Passive rAF-coalesced scroll & viewport resize tracking with covers() bail-out.
  useEffect(() => {
    if (!enabled) return;
    const node = scroller?.() ?? null;
    if (!node) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const sample = elements.current.values().next().value;
      const list = sample?.parentElement ?? node.firstElementChild;
      const offsetTop =
        list instanceof HTMLElement && list !== node
          ? list.offsetTop + (parseFloat(getComputedStyle(list).paddingTop) || 0)
          : 0;
      const top = Math.max(0, node.scrollTop - offsetTop);
      const height = node.clientHeight;
      const before = scroll.current;
      const firstRead = !initialized.current;
      initialized.current = true;
      scroll.current = { top, height, offsetTop };
      // Refresh the visual anchor to the reader's post-scroll position.
      anchorRef.current = captureAnchor.current(node);
      if (!firstRead && before.height === height && Math.abs(before.top - top) < 1) return;
      const { items: drawn, sizes: held, gap, pinnedIndices: pinned } = latest.current;
      const next = windowPlan({
        sizes: held,
        gap,
        top,
        height: height || 900,
        overscan: transcriptOverscanPx,
        pinned,
      });
      if (firstRead || before.height !== height || !covers(drawn, next)) {
        setView((current) => ({ ...current, version: current.version + 1 }));
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    const onScroll = () => {
      // Ignore the scroll event fired by our own anchor/tail restoration write so we never
      // drop the anchor before a following ResizeObserver pass finishes.
      if (
        programmaticScrollTop.current !== null &&
        Math.abs(node.scrollTop - programmaticScrollTop.current) <= 1
      ) {
        programmaticScrollTop.current = null;
        return;
      }
      programmaticScrollTop.current = null;
      if (latest.current.followTail && !tailBroken.current) {
        const previous = lastTailGeometry.current;
        const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
        const sameGeometry =
          previous !== null &&
          previous.height === node.scrollHeight &&
          previous.viewport === node.clientHeight;
        if (sameGeometry && node.scrollTop < maxTop - 1) {
          tailBroken.current = true;
          lastTailGeometry.current = null;
        }
      }
      // Keep the anchor tracking the reader's current post-scroll position immediately.
      anchorRef.current = captureAnchor.current(node);
      schedule();
    };
    read();
    node.addEventListener("scroll", onScroll, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(node);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll);
      resize?.disconnect();
    };
  }, [enabled, scroller]);

  return { enabled, items, observeRow };
}

function covers(drawn: readonly WindowItem[], next: readonly WindowItem[]): boolean {
  const indices = new Set<number>();
  for (const item of drawn) if ("index" in item) indices.add(item.index);
  return next.every((item) => !("index" in item) || indices.has(item.index));
}
