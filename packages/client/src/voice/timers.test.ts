import { afterEach, expect, it, vi } from "vitest";
import { voiceTimers } from "./timers.js";

afterEach(() => vi.unstubAllGlobals());

it("calls the browser timer with the global receiver", () => {
  const callback = vi.fn();
  vi.stubGlobal("setTimeout", function (this: unknown, fn: () => void) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    fn();
    return 1;
  });
  const timers = voiceTimers({});
  expect(timers.set(callback, 10)).toBe(1);
  expect(callback).toHaveBeenCalledOnce();
});
