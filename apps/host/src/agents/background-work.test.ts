import { afterEach, expect, it, vi } from "vitest";
import { waitForBackgroundWork } from "./background-work.test-support.js";

afterEach(() => vi.useRealTimers());

it("names a background condition whose database read never returns", async () => {
  vi.useFakeTimers();
  const read = Promise.withResolvers<boolean>();
  const waiting = waitForBackgroundWork(() => read.promise, "the Run to enter background", 100);
  const failed = expect(waiting).rejects.toThrow(
    "Timed out waiting for the Run to enter background",
  );
  await vi.advanceTimersByTimeAsync(100);
  // Unblock the old polling implementation so its failure is observable without
  // leaving a pending task behind after this regression fails.
  read.resolve(true);
  await failed;
});
