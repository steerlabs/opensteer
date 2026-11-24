// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rowHeights, useVirtualTranscript } from "./virtual-transcript.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Each drawn row's height, as layout would give it at the column's current width. */
const heights = new Map<string, number>();
const resized: ResizeObserverCallback[] = [];

function List({
  estimate,
  keys,
  scroller,
}: {
  readonly estimate: (index: number) => number;
  readonly keys: readonly string[];
  readonly scroller: HTMLElement;
}) {
  const virtual = useVirtualTranscript({
    scroller: () => scroller,
    keys,
    estimate,
    pinnedKeys: [],
    initialAtTail: false,
  });
  return (
    <div className="list">
      {virtual.items.map((item, position) =>
        "spacer" in item ? (
          <div className="spacer" key={`spacer:${position}`} style={{ height: item.spacer }} />
        ) : (
          <div
            data-row={keys[item.index]}
            key={keys[item.index]}
            ref={(element) => virtual.observeRow(keys[item.index]!, element)}
          />
        ),
      )}
    </div>
  );
}

function open(keys: readonly string[], estimate: (index: number) => number) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  document.body.append(scroller);
  const root = createRoot(scroller);
  roots.push(root);
  act(() => root.render(<List estimate={estimate} keys={keys} scroller={scroller} />));
  return { root, scroller };
}

describe("a virtual transcript's row heights", () => {
  it("lays out a list opened again at the heights it measured, and measures again at a new width", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const height = heights.get(this.dataset.row ?? "") ?? 0;
      return { top: 0, bottom: height, left: 0, right: 0, height, width: 0, x: 0, y: 0 } as DOMRect;
    });
    const keys = Array.from({ length: 60 }, (_, index) => `remeasure-${index}`);
    for (const key of keys) heights.set(key, 100);
    const estimate = vi.fn((_index: number) => 50);

    const first = open(keys, estimate);
    const drawn = () =>
      [...first.scroller.querySelectorAll<HTMLElement>("[data-row]")].map(
        (row) => row.dataset.row!,
      );
    const measuredFirst = drawn();
    expect(measuredFirst.length).toBeGreaterThan(0);
    expect(measuredFirst.length).toBeLessThan(keys.length);
    for (const key of measuredFirst) expect(rowHeights.peek(key)).toBe(100);

    // The column narrows: every drawn row grows, and its resize is measured again.
    for (const key of keys) heights.set(key, 180);
    act(() => {
      for (const callback of resized) callback([], {} as ResizeObserver);
    });
    const measuredNarrow = drawn();
    for (const key of measuredNarrow) expect(rowHeights.peek(key)).toBe(180);
    act(() => first.root.unmount());
    roots.splice(roots.indexOf(first.root), 1);

    // Opened again, a measured row is laid out at its height before anything is drawn.
    estimate.mockClear();
    const again = open(keys, estimate);
    const estimated = new Set(estimate.mock.calls.map(([index]) => keys[index]));
    for (const key of measuredNarrow) expect(estimated.has(key)).toBe(false);
    const spacer = again.scroller.querySelector<HTMLElement>(".spacer:last-child")!;
    const undrawn = keys.slice(
      keys.indexOf(
        [...again.scroller.querySelectorAll<HTMLElement>("[data-row]")].at(-1)!.dataset.row!,
      ) + 1,
    );
    // The list has no gap here, so the spacer stands for exactly the rows after the window.
    const expected = undrawn.reduce((sum, key) => sum + (rowHeights.peek(key) ?? 50), 0);
    expect(undrawn.some((key) => rowHeights.peek(key) === 180)).toBe(true);
    expect(parseFloat(spacer.style.height)).toBeCloseTo(expected, 0);
  });
});
