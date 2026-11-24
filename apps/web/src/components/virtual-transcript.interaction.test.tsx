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

/** Each drawn row's height at each width the column is laid out at. */
const heights = new Map<string, number>();
let columnWidth = 600;
const resized: ResizeObserverCallback[] = [];

function layOut() {
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
    const row = this.dataset.row;
    const height = row === undefined ? 0 : (heights.get(`${columnWidth}:${row}`) ?? 0);
    const width = row === undefined ? 0 : columnWidth;
    return { top: 0, bottom: height, left: 0, right: width, height, width, x: 0, y: 0 } as DOMRect;
  });
}

function List({
  estimate,
  keys,
  pinnedKeys = [],
  scroller,
}: {
  readonly estimate: (index: number) => number;
  readonly keys: readonly string[];
  readonly pinnedKeys?: readonly string[];
  readonly scroller: HTMLElement;
}) {
  const virtual = useVirtualTranscript({
    scroller: () => scroller,
    keys,
    estimate,
    pinnedKeys,
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

function open(
  keys: readonly string[],
  estimate: (index: number) => number,
  pinnedKeys: readonly string[] = [],
) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  document.body.append(scroller);
  const root = createRoot(scroller);
  roots.push(root);
  act(() =>
    root.render(
      <List estimate={estimate} keys={keys} pinnedKeys={pinnedKeys} scroller={scroller} />,
    ),
  );
  const drawn = () =>
    [...scroller.querySelectorAll<HTMLElement>("[data-row]")].map((row) => row.dataset.row!);
  /** The rows after the last one drawn, which the last spacer stands for. */
  const undrawnAfter = () => keys.slice(keys.indexOf(drawn().at(-1)!) + 1);
  const lastSpacer = () =>
    parseFloat(scroller.querySelector<HTMLElement>(".spacer:last-child")!.style.height);
  const close = () => {
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
  };
  return { close, drawn, lastSpacer, scroller, undrawnAfter };
}

describe("a virtual transcript's row heights", () => {
  it("lays out a list opened again at the heights it measured, and measures a row again as it grows", () => {
    layOut();
    const keys = Array.from({ length: 60 }, (_, index) => `remeasure-${index}`);
    for (const key of keys) heights.set(`600:${key}`, 100);
    const estimate = vi.fn((_index: number) => 50);

    const first = open(keys, estimate);
    const measuredFirst = first.drawn();
    expect(measuredFirst.length).toBeGreaterThan(0);
    expect(measuredFirst.length).toBeLessThan(keys.length);
    for (const key of measuredFirst) expect(rowHeights.peek(600, key)).toBe(100);

    // Every drawn row grows (its Markdown arrives, say), and its resize is measured again.
    for (const key of keys) heights.set(`600:${key}`, 180);
    act(() => {
      for (const callback of resized) callback([], {} as ResizeObserver);
    });
    const measuredGrown = first.drawn();
    for (const key of measuredGrown) expect(rowHeights.peek(600, key)).toBe(180);
    first.close();

    // Opened again, a measured row is laid out at its height before anything is drawn.
    estimate.mockClear();
    const again = open(keys, estimate);
    const estimated = new Set(estimate.mock.calls.map(([index]) => keys[index]));
    for (const key of measuredGrown) expect(estimated.has(key)).toBe(false);
    const undrawn = again.undrawnAfter();
    // The list has no gap here, so the spacer stands for exactly the rows after the window.
    expect(undrawn.some((key) => rowHeights.peek(600, key) === 180)).toBe(true);
    expect(again.lastSpacer()).toBeCloseTo(
      undrawn.reduce((sum, key) => sum + (rowHeights.peek(600, key) ?? 50), 0),
      0,
    );
  });

  // Failure mode: a narrow column's measured heights stand in for rows a wide one never drew, so
  // its spacers are far too tall and the scroll position lands rows away from where it should.
  it("stands a row never measured at the list's width at its estimate, and keeps each width's heights", () => {
    layOut();
    const keys = Array.from({ length: 60 }, (_, index) => `width-${index}`);
    for (const key of keys) {
      heights.set(`400:${key}`, 180);
      heights.set(`800:${key}`, 100);
    }
    const estimate = (_index: number) => 50;
    // Narrow, a few rows far down are drawn too (a jump's target, say) and measured.
    const far = keys.slice(30, 36);
    columnWidth = 400;
    const narrow = open(keys, estimate, far);
    expect(narrow.drawn()).toEqual(expect.arrayContaining(far));
    for (const key of far) expect(rowHeights.peek(400, key)).toBe(180);
    narrow.close();

    // Wide, those rows are not drawn: they stand at their estimate, not their narrow height.
    columnWidth = 800;
    const wide = open(keys, estimate);
    const undrawnWide = wide.undrawnAfter();
    expect(undrawnWide).toEqual(expect.arrayContaining(far));
    for (const key of far) expect(rowHeights.peek(800, key)).toBeUndefined();
    for (const key of wide.drawn()) expect(rowHeights.peek(800, key)).toBe(100);
    expect(wide.lastSpacer()).toBeCloseTo(
      undrawnWide.reduce(
        (sum, key) => sum + (far.includes(key) ? 50 : (rowHeights.peek(800, key) ?? 50)),
        0,
      ),
      0,
    );
    wide.close();

    // Narrow again, the rows it measured stand at their narrow heights though they are not drawn.
    columnWidth = 400;
    const back = open(keys, estimate);
    const undrawnBack = back.undrawnAfter();
    expect(undrawnBack).toEqual(expect.arrayContaining(far));
    expect(back.lastSpacer()).toBeCloseTo(
      undrawnBack.reduce((sum, key) => sum + (rowHeights.peek(400, key) ?? 50), 0),
      0,
    );
    expect(back.lastSpacer()).toBeGreaterThanOrEqual(far.length * 180);
  });
});
