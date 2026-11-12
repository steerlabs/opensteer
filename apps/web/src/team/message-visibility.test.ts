// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { observeTeamMessages } from "./message-visibility.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
it("reads each mounted reply only after it remains visible in a focused window", async () => {
  vi.useFakeTimers();
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const root = document.createElement("div"),
    first = document.createElement("div"),
    second = document.createElement("div");
  first.dataset.rowId = "reply-1";
  second.dataset.rowId = "reply-2";
  root.append(first, second);
  document.body.append(root);
  const leave = vi.fn();
  const seen = vi.fn(() => leave);
  let stop = observeTeamMessages(root, [first, second], seen);
  const entry = (row: HTMLElement, visible: boolean) =>
    intersect(
      [
        {
          target: row,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
  entry(first, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).not.toHaveBeenCalled();
  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen.mock.calls).toEqual([["reply-1"]]);
  entry(first, false);
  expect(leave).toHaveBeenCalledTimes(1);
  entry(second, true);
  await vi.advanceTimersByTimeAsync(500);
  focus.mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toHaveBeenCalledTimes(1);
  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toHaveBeenLastCalledWith("reply-2");
  // A late personal read snapshot reattaches the same visible row and retries it.
  stop();
  stop = observeTeamMessages(root, [second], seen);
  entry(second, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toHaveBeenCalledTimes(3);
  stop();
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(leave).toHaveBeenCalledTimes(3);
});
