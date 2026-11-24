import { expect, it } from "vitest";
import { withTimeout } from "./withTimeout.js";

it("leaves no failure unhandled when its signal had already ended: the operation was under way", async () => {
  const unhandled: unknown[] = [];
  const seen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", seen);
  try {
    const ended = AbortSignal.abort(new Error("The step ended."));
    // The operation began as the caller's argument, before the signal was looked at.
    const operation = Promise.reject(new Error("The host refused."));
    await expect(
      withTimeout(operation, 1_000, { signal: ended, timeoutError: () => new Error("late") }),
    ).rejects.toThrow("The step ended.");
    // Long enough for Node to report a rejection nobody handled.
    for (let turn = 0; turn < 5; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", seen);
  }
});
