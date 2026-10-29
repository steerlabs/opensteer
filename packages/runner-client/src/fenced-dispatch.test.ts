import { describe, expect, it, vi } from "vitest";
import { FencedInboundDispatcher } from "./fenced-dispatch.js";

describe("FencedInboundDispatcher", () => {
  it("rejects stale frames and serializes current-fence work", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = vi.fn(async (message: { fence: number; name: string }) => {
      order.push(`start:${message.name}`);
      if (message.name === "first") await firstPaused;
      order.push(`end:${message.name}`);
    });
    const dispatcher = new FencedInboundDispatcher({
      accepts: (fence: number) => fence === 2,
      fence: (message: { fence: number; name: string }) => message.fence,
      handle,
    });

    await expect(dispatcher.dispatch({ fence: 1, name: "stale" })).rejects.toThrow(/stale/);
    const first = dispatcher.dispatch({ fence: 2, name: "first" });
    const second = dispatcher.dispatch({ fence: 2, name: "second" });
    await vi.waitFor(() => expect(order).toEqual(["start:first"]));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("aborts and drains in-flight work before the stream can be replaced", async () => {
    let observedAbort = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const dispatcher = new FencedInboundDispatcher({
      accepts: () => true,
      fence: () => 1,
      handle: async (_message: string, signal: AbortSignal) => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const handling = dispatcher.dispatch("frame");
    await started;
    await dispatcher.abortAndDrain(new Error("stream replaced"));
    await handling;
    expect(observedAbort).toBe(true);
    await expect(dispatcher.dispatch("late")).rejects.toThrow(/closed/);
  });
});
