import { expect, it } from "vitest";
import { mapLimit } from "./lane.js";

// Review G6(c): agent start prepares and settles many slots at once, never more than the limit.
it("runs every item with no more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  await mapLimit(
    Array.from({ length: 50 }, (_, index) => index),
    16,
    async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      done.push(item);
      running -= 1;
    },
  );
  expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index));
  expect(peak).toBe(16);
});
