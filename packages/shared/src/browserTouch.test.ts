import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTouchGesture } from "./browserTouch.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup(platform: "ios" | "android" = "ios", frameMs = 16) {
  const wheel = vi.fn<(point: string, dx: number, dy: number) => boolean>(() => true);
  const pointer = vi.fn<
    (point: string, action: "down" | "move" | "up", button: "left" | "right" | "none") => boolean
  >(() => true);
  const cancelPointer = vi.fn();
  const contact = vi.fn();
  const onTap = vi.fn();
  const onDragEnd = vi.fn();
  let usable = true;
  const gesture = createBrowserTouchGesture({
    platform,
    usable: () => usable,
    wheel,
    pointer,
    cancelPointer,
    contact,
    onTap,
    onDragEnd,
    schedule: (callback) => {
      const id = setTimeout(callback, frameMs);
      return () => clearTimeout(id);
    },
  });
  const start = (drag = false) => gesture.start({ point: "page", x: 50, y: 150, scale: 2, drag });
  const scroll = () => {
    start();
    vi.advanceTimersByTime(16);
    gesture.move({ point: "page", x: 50, y: 130 });
    vi.advanceTimersByTime(16);
    gesture.move({ point: "page", x: 50, y: 110 });
    gesture.release();
  };
  return {
    gesture,
    start,
    scroll,
    wheel,
    pointer,
    cancelPointer,
    contact,
    onTap,
    onDragEnd,
    disconnect: () => {
      usable = false;
    },
  };
}
describe("streamed finger input", () => {
  it("acknowledges contact locally, defers a tap, and consumes a stationary long press", () => {
    const { gesture, start, pointer, contact, onTap } = setup();
    start();
    expect(contact).toHaveBeenLastCalledWith({ x: 50, y: 150 });
    expect(pointer).not.toHaveBeenCalled();
    gesture.release();
    expect(pointer.mock.calls).toEqual([
      ["page", "down", "left"],
      ["page", "up", "left"],
    ]);
    expect(onTap).toHaveBeenCalledOnce();
    pointer.mockClear();
    start();
    vi.advanceTimersByTime(500);
    gesture.move({ point: "page", x: 50, y: 80 });
    gesture.release();
    expect(pointer.mock.calls).toEqual([
      ["page", "down", "right"],
      ["page", "up", "right"],
    ]);
    expect(onTap).toHaveBeenCalledOnce();
    expect(contact).toHaveBeenLastCalledWith(null);
  });
  it("measures cumulative slop and cancels long press as soon as scrolling wins", () => {
    const { gesture, start, wheel, pointer } = setup();
    start();
    for (let dy = 2; dy <= 10; dy += 2) {
      vi.advanceTimersByTime(16);
      gesture.move({ point: "page", x: 50, y: 150 - dy });
    }
    vi.advanceTimersByTime(600);
    gesture.release();
    expect(wheel).toHaveBeenCalled();
    expect(wheel.mock.calls[0]).toEqual(["page", 0, 20]);
    expect(pointer).not.toHaveBeenCalled();
  });
  it.each(["ios", "android"] as const)("decays a bounded %s fling by elapsed time", (platform) => {
    const { scroll, wheel, pointer } = setup(platform);
    scroll();
    wheel.mockClear();
    vi.advanceTimersByTime(16);
    const first = wheel.mock.calls[0]![2];
    vi.advanceTimersByTime(16);
    expect(wheel.mock.calls[1]![2]).toBeLessThan(first);
    expect(first).toBeGreaterThan(0);
    vi.advanceTimersByTime(1300);
    const count = wheel.mock.calls.length;
    expect(count).toBeLessThanOrEqual(75);
    vi.advanceTimersByTime(5000);
    expect(wheel).toHaveBeenCalledTimes(count);
    expect(pointer).not.toHaveBeenCalled();
  });
  it("integrates the same distance at different display cadences and decelerates faster on Android", () => {
    const total = (platform: "ios" | "android", frameMs: number) => {
      const { scroll, wheel } = setup(platform, frameMs);
      scroll();
      wheel.mockClear();
      vi.advanceTimersByTime(1200);
      return wheel.mock.calls.reduce((sum, call) => sum + call[2], 0);
    };
    expect(total("ios", 16)).toBeCloseTo(total("ios", 24), 5);
    expect(total("android", 16)).toBeLessThan(total("ios", 16));
  });
  it("bounds release velocity and does not fling after a stationary finish", () => {
    const { gesture, start, wheel } = setup();
    start();
    vi.advanceTimersByTime(1);
    gesture.move({ point: "page", x: 50, y: -10000 });
    gesture.release();
    wheel.mockClear();
    vi.advanceTimersByTime(16);
    expect(wheel.mock.calls[0]![2]).toBeLessThanOrEqual(6 * 16);
    gesture.cancel();
    start();
    vi.advanceTimersByTime(16);
    gesture.move({ point: "page", x: 50, y: 100 });
    vi.advanceTimersByTime(100);
    gesture.release();
    wheel.mockClear();
    vi.advanceTimersByTime(1000);
    expect(wheel).not.toHaveBeenCalled();
  });
  it("never catches up after suspension", () => {
    const { scroll, wheel } = setup("ios", 200);
    scroll();
    wheel.mockClear();
    vi.advanceTimersByTime(2000);
    expect(wheel).not.toHaveBeenCalled();
  });
  it.each(["cancel", "contact", "pinch", "disconnect", "rejection"])(
    "stops inertia on %s",
    (reason) => {
      const { gesture, start, scroll, wheel, disconnect } = setup();
      scroll();
      if (reason === "cancel") gesture.cancel();
      if (reason === "contact") start();
      if (reason === "pinch") gesture.contacts(2);
      if (reason === "disconnect") disconnect();
      if (reason === "rejection") wheel.mockReturnValue(false);
      wheel.mockClear();
      vi.advanceTimersByTime(2000);
      expect(wheel).toHaveBeenCalledTimes(reason === "rejection" ? 1 : 0);
    },
  );
  it("holds a precision drag without scroll arbitration and cancels it before pinch; all fingers must lift", () => {
    const { gesture, start, pointer, cancelPointer, wheel, onDragEnd } = setup();
    start(true);
    vi.advanceTimersByTime(600);
    gesture.move({ point: "end", x: 90, y: 110 });
    expect(pointer.mock.calls).toEqual([
      ["page", "down", "left"],
      ["end", "move", "none"],
    ]);
    gesture.contacts(2);
    expect(cancelPointer).toHaveBeenCalledExactlyOnceWith("end");
    expect(onDragEnd).toHaveBeenCalledOnce();
    gesture.contacts(1);
    start();
    gesture.release();
    expect(pointer).toHaveBeenCalledTimes(2);
    gesture.contacts(0);
    start(true);
    gesture.release();
    expect(pointer.mock.calls.slice(-2)).toEqual([
      ["page", "down", "left"],
      ["page", "up", "left"],
    ]);
    expect(wheel).not.toHaveBeenCalled();
  });
  it("cleans up refused drag moves and releases without replay", () => {
    const { gesture, start, pointer, cancelPointer, onDragEnd } = setup();
    start(true);
    pointer.mockReturnValue(false);
    gesture.move({ point: "end", x: 90, y: 110 });
    gesture.release();
    expect(cancelPointer).toHaveBeenCalledExactlyOnceWith("end");
    expect(onDragEnd).toHaveBeenCalledOnce();
  });
});
