import { describe, expect, it, vi } from "vitest";
import {
  observeVisualViewportKeyboardInset,
  visualViewportKeyboardInset,
} from "./visual-viewport-keyboard.js";

type ViewportEvent = "resize" | "scroll";

class FakeVisualViewport {
  height = 812;
  offsetTop = 0;
  scale = 1;
  readonly listeners = new Map<ViewportEvent, Set<() => void>>();

  addEventListener(type: ViewportEvent, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: ViewportEvent, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: ViewportEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe("visualViewportKeyboardInset", () => {
  it("measures the occluded bottom of a fixed layout viewport", () => {
    const viewport = new FakeVisualViewport();
    viewport.height = 510;
    viewport.offsetTop = 8;

    expect(visualViewportKeyboardInset({ innerHeight: 812, visualViewport: viewport })).toBe(294);
  });

  it("stays at zero when Android has already shrunk the layout viewport", () => {
    const viewport = new FakeVisualViewport();
    viewport.height = 510;

    expect(visualViewportKeyboardInset({ innerHeight: 510, visualViewport: viewport })).toBe(0);
  });

  it("does not treat pinch zoom as a software keyboard", () => {
    const viewport = new FakeVisualViewport();
    viewport.height = 406;
    viewport.scale = 2;

    expect(visualViewportKeyboardInset({ innerHeight: 812, visualViewport: viewport })).toBe(0);
  });

  it("updates for viewport resize and scroll and removes both listeners", () => {
    const viewport = new FakeVisualViewport();
    const windowLike = { innerHeight: 812, visualViewport: viewport };
    const listener = vi.fn();
    const stop = observeVisualViewportKeyboardInset(windowLike, listener);

    viewport.height = 520;
    viewport.dispatch("resize");
    viewport.offsetTop = 12;
    viewport.dispatch("scroll");

    expect(listener.mock.calls.map(([inset]) => inset)).toEqual([0, 292, 280]);

    stop();
    viewport.height = 812;
    viewport.dispatch("resize");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reports zero without VisualViewport support", () => {
    const listener = vi.fn();
    const stop = observeVisualViewportKeyboardInset(
      { innerHeight: 812, visualViewport: null },
      listener,
    );

    expect(listener).toHaveBeenCalledWith(0);
    expect(stop()).toBeUndefined();
  });
});
