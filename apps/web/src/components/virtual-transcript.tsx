import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { windowPlan, type WindowItem } from "./workspace/windowed-rows.js";

/** Threads with at most this many rows mount directly without virtualization overhead. */
export const virtualTranscriptThreshold = 48;

/** Generous off-screen draw distance (px) above and below the viewport, matching Legend List. */
const transcriptOverscanPx = 900;

/** Cap retained row height entries so very long browsing sessions stay bounded in memory. */
const maxRetainedMeasurements = 2_000;

export interface VirtualTranscriptOptions {
  /** Scroll container getter; null disables virtualization (e.g. SSR or static previews). */
  readonly scroller: (() => HTMLElement | null) | null;
  /** Stable row keys in document order. */
  readonly keys: readonly string[];
  /** Estimated outer height (px, excluding flex gap) for an unmeasured row. */
  readonly estimate: (index: number) => number;
  /** Row keys that must remain mounted regardless of scroll offset (tail, jump target, focus). */
  readonly pinnedKeys: readonly string[];
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
 * Variable-height viewport virtualization for long transcripts.
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
  initialAtTail = true,
  followTail = false,
}: VirtualTranscriptOptions): VirtualTranscriptState {
  const enabled = scroller !== null && keys.length > virtualTranscriptThreshold;
  const measured = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const initialized = useRef(false);
  const scroll = useRef({ top: 0, height: 0, offsetTop: 0 });
  const anchorRef = useRef<VisualAnchor | null>(null);
  const programmaticScrollTop = useRef<number | null>(null);
  const [view, setView] = useState({ gap: 4, version: 0 });

  const sizes = useMemo(
    () =>
      keys.map((key, index) => {
        const height = measured.current.get(key) ?? estimate(index);
        return height + view.gap;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimate, keys, view.gap, view.version],
  );

  // Before the first real scroll measurement, assume the reader opens at the tail so frame 1
  // mounts the newest rows immediately instead of mounting rows 0..N and jumping.
  const effectiveTop = useMemo(() => {
    if (initialized.current || !initialAtTail) return scroll.current.top;
    const viewport =
      scroll.current.height || (typeof window !== "undefined" ? window.innerHeight : 900);
    let total = 0;
    for (const size of sizes) total += size;
    return Math.max(0, total - viewport);
  }, [initialAtTail, sizes]);

  const effectiveHeight =
    scroll.current.height || (typeof window !== "undefined" ? window.innerHeight : 900);

  const pinnedIndices = useMemo(() => {
    if (!enabled || pinnedKeys.length === 0) return [] as number[];
    const byKey = new Map<string, number>();
    for (let index = 0; index < keys.length; index++) byKey.set(keys[index]!, index);
    const out: number[] = [];
    for (const key of pinnedKeys) {
      const index = byKey.get(key);
      if (index !== undefined) out.push(index);
    }
    return out;
  }, [enabled, keys, pinnedKeys]);

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
    keys,
    pinnedIndices,
    scroller,
    sizes,
  });
  latest.current = {
    enabled,
    followTail,
    gap: view.gap,
    items,
    keys,
    pinnedIndices,
    scroller,
    sizes,
  };

  /** Captures the top-most visible mounted row's pixel offset from the scrollport top. */
  const captureAnchor = useRef((scrollerEl: HTMLElement): VisualAnchor | null => {
    if (latest.current.followTail || scrollerEl.scrollTop <= 0) return null;
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
    const { enabled: isEnabled, gap, scroller: getScroller } = latest.current;
    if (!isEnabled) return;
    const scrollerEl = getScroller?.() ?? null;

    // First, restore the visual anchor if the newly committed DOM shifted the row in view.
    if (scrollerEl) restoreAnchor.current(scrollerEl);

    let changed = false;
    for (const [key, element] of elements.current) {
      if (!element.isConnected) continue;
      const height = element.getBoundingClientRect().height;
      if (height <= 0) continue;
      const previous = measured.current.get(key);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) continue;
      measured.current.set(key, height);
      changed = true;
    }

    const sample = elements.current.values().next().value;
    const parent = sample?.parentElement;
    const nextGap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : gap;

    if (measured.current.size > maxRetainedMeasurements) {
      const protectedKeys = new Set<string>(elements.current.keys());
      for (const index of latest.current.pinnedIndices) {
        const key = latest.current.keys[index];
        if (key !== undefined) protectedKeys.add(key);
      }
      for (const key of measured.current.keys()) {
        if (!protectedKeys.has(key)) measured.current.delete(key);
        if (measured.current.size <= maxRetainedMeasurements) break;
      }
    }

    if (scrollerEl) {
      anchorRef.current = captureAnchor.current(scrollerEl);
    }

    if (changed || Math.abs(nextGap - gap) > 0.5) {
      setView((current) => ({ gap: nextGap, version: current.version + 1 }));
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
      // Ignore the scroll event fired by our own anchor-restoration write so we never
      // drop the anchor before a following ResizeObserver pass finishes.
      if (
        programmaticScrollTop.current !== null &&
        Math.abs(node.scrollTop - programmaticScrollTop.current) <= 1
      ) {
        programmaticScrollTop.current = null;
        return;
      }
      programmaticScrollTop.current = null;
      // Keep the anchor tracking the reader's current post-scroll position immediately.
      anchorRef.current = captureAnchor.current(node);
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    node.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(node);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
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
