import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** A row the list draws, or a spacer standing in for the rows between two it draws. */
export type WindowItem = { readonly index: number } | { readonly spacer: number };

/** How far beyond its view, above and below, a list draws rows. */
const overscan = 400;

/**
 * The rows a list draws for its view, by each row's size (its top margin, its
 * height and the list's gap after it), the pinned rows wherever they stand,
 * and a spacer for each run between. A spacer keeps one gap of its own, so the
 * list is exactly as tall as it would be with every row drawn.
 */
export function windowPlan(input: {
  readonly sizes: readonly number[];
  readonly gap: number;
  readonly top: number;
  readonly height: number;
  readonly overscan: number;
  readonly pinned: readonly number[];
}): WindowItem[] {
  const { sizes, gap } = input;
  const from = input.top - input.overscan;
  const to = input.top + input.height + input.overscan;
  const drawn = new Set<number>();
  let start = 0;
  for (let index = 0; index < sizes.length; index++) {
    const end = start + sizes[index]!;
    if (end > from && start < to) drawn.add(index);
    else if (start >= to) break;
    start = end;
  }
  for (const index of input.pinned) if (index >= 0 && index < sizes.length) drawn.add(index);
  const plan: WindowItem[] = [];
  let run = 0;
  let skipped = 0;
  for (let index = 0; index < sizes.length; index++) {
    if (drawn.has(index)) {
      if (skipped > 0) plan.push({ spacer: run - gap });
      run = 0;
      skipped = 0;
      plan.push({ index });
    } else {
      run += sizes[index]!;
      skipped++;
    }
  }
  if (skipped > 0) plan.push({ spacer: run - gap });
  return plan;
}

interface Measured {
  readonly height: number;
  readonly size: number;
}

/**
 * Windowed rendering for a list whose rows are its `[data-motion-key]`
 * children, keyed as `keys`: it draws the rows in view and `pinned` (the
 * active and focused rows, so neither is ever unmounted under the person),
 * or every row while `all` (a drag measures them all). Rows are measured as
 * they are drawn; one never drawn counts at `estimate`.
 */
export function useWindowedRows(input: {
  readonly list: RefObject<HTMLElement | null>;
  readonly keys: readonly string[];
  readonly estimate: (index: number) => number;
  readonly pinned: readonly string[];
  readonly all: boolean;
}): readonly WindowItem[] {
  const { all, keys, list } = input;
  const measured = useRef(new Map<string, Measured>());
  // Where the list stands; a scroll that keeps the same rows drawn renders nothing.
  const scroll = useRef({ top: 0, height: 0 });
  const [view, setView] = useState({ gap: 0, version: 0 });
  const sizes = keys.map((key, index) => measured.current.get(key)?.size ?? input.estimate(index));
  const at = new Map(keys.map((key, index) => [key, index]));
  const pinned = input.pinned.flatMap((key) => (at.has(key) ? [at.get(key)!] : []));
  const plan: readonly WindowItem[] = all
    ? keys.map((_, index) => ({ index }))
    : windowPlan({
        sizes,
        gap: view.gap,
        top: scroll.current.top,
        // Before the list is measured, a window as tall as the screen.
        height: scroll.current.height || window.innerHeight,
        overscan,
        pinned,
      });
  const latest = useRef({ plan, sizes, gap: view.gap });
  latest.current = { plan, sizes, gap: view.gap };

  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const gap = parseFloat(getComputedStyle(node).rowGap) || 0;
    let changed = false;
    for (const row of node.children) {
      if (!(row instanceof HTMLElement)) continue;
      const key = row.dataset.motionKey;
      if (key === undefined) continue;
      const height = row.offsetHeight;
      const held = measured.current.get(key);
      if (held?.height === height) continue;
      const size = height + (parseFloat(getComputedStyle(row).marginTop) || 0) + gap;
      measured.current.set(key, { height, size });
      if (Math.abs((held?.size ?? -1) - size) > 0.5) changed = true;
    }
    if (changed || gap !== view.gap) setView((current) => ({ gap, version: current.version + 1 }));
  });

  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = node.scrollTop;
      const height = node.clientHeight;
      const before = scroll.current;
      scroll.current = { top, height };
      if (before.height === height && Math.abs(before.top - top) < 1) return;
      const { plan: drawn, sizes: held, gap } = latest.current;
      const next = windowPlan({ sizes: held, gap, top, height, overscan, pinned: [] });
      if (before.height !== height || !covers(drawn, next))
        setView((current) => ({ ...current, version: current.version + 1 }));
    };
    const schedule = () => {
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
  }, [list]);
  return plan;
}

/** Whether every row a view needs is among the rows drawn now, so it can wait. */
function covers(drawn: readonly WindowItem[], next: readonly WindowItem[]): boolean {
  const indices = new Set(drawn.flatMap((item) => ("index" in item ? [item.index] : [])));
  return next.every((item) => !("index" in item) || indices.has(item.index));
}
