// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FoldRow, FoldToFit } from "./fold-to-fit.js";
import { Popover } from "./popover.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fits a resized composer row and repositions its menu after observer delivery, coalescing and cancelling on unmount", async () => {
  const deliveries: (() => void)[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        deliveries.push(() => callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      disconnect() {}
    },
  );
  const anchor = document.createElement("button");
  document.body.append(anchor);
  let left = 40;
  vi.spyOn(anchor, "getClientRects").mockImplementation(
    () => [new DOMRect(left, 100, 40, 30)] as unknown as DOMRectList,
  );
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(left, 100, 40, 30),
  );
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root?.render(
      <>
        <FoldToFit className="test-line">
          <FoldRow className="test-row">
            <span data-fold="1">Model name</span>
          </FoldRow>
        </FoldToFit>
        <Popover anchor={anchor} label="Account menu" onClose={() => undefined}>
          <button>Account</button>
        </Popover>
      </>,
    ),
  );
  const line = node.querySelector<HTMLElement>(".test-line")!;
  const row = node.querySelector<HTMLElement>(".test-row")!;
  const part = row.querySelector<HTMLElement>("[data-fold]")!;
  const panel = document.querySelector<HTMLElement>(".popover")!;
  Object.defineProperty(row, "clientWidth", { configurable: true, value: 60 });
  Object.defineProperty(row, "scrollWidth", {
    configurable: true,
    get: () => (part.hasAttribute("data-folded") ? 20 : 120),
  });
  const initial = line.innerHTML;
  const initialLeft = panel.style.left;
  left = 140;
  await act(async () => {
    for (let pass = 0; pass < 3; pass++) for (const deliver of deliveries) deliver();
  });
  expect(line.innerHTML).toBe(initial);
  expect(panel.style.left).toBe(initialLeft);
  expect(frames.size).toBe(2);
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  expect(part.hasAttribute("data-folded")).toBe(true);
  expect(panel.style.left).toBe("140px");
  await act(async () => {
    for (const deliver of deliveries) deliver();
  });
  expect(frames.size).toBe(2);
  act(() => root?.unmount());
  root = null;
  expect(frames.size).toBe(0);
});
