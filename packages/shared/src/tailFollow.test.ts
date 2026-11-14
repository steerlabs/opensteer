import { describe, expect, it } from "vitest";
import { readTail, type TailReading } from "./tailFollow.js";

/** Reads each offset in turn, as the reader's own scroll, against a fixed extent. */
function scroll(from: TailReading, offsets: readonly number[], max = 1600): TailReading {
  return offsets.reduce((reading, offset) => readTail(reading, offset, max, true), from);
}

describe("readTail", () => {
  const following = { follows: true, offset: 1600 };

  it("keeps following when the scroller only clamps to a shorter extent", () => {
    // The viewport grew by 100px: the offset fell with the most it scrolls.
    expect(readTail(following, 1500, 1500, false).follows).toBe(true);
  });

  it("lets go of a slow scroll up, a fraction of a pixel at a time", () => {
    const steps = Array.from({ length: 8 }, (_, step) => 1600 - (step + 1) * 0.25);
    expect(scroll(following, steps).follows).toBe(false);
  });

  it("does not take the foot up again while the reader still moves up near it", () => {
    expect(scroll(following, [1598.5, 1598]).follows).toBe(false);
    expect(scroll(following, [1598.5, 1598, 1599.5]).follows).toBe(true);
  });

  it("takes the foot up again only on the reader's own scroll", () => {
    const reading = { follows: false, offset: 1500 };
    expect(readTail(reading, 1600, 1600, false).follows).toBe(false);
    expect(readTail(reading, 1599.5, 1600, true).follows).toBe(true);
    expect(readTail(reading, 1570, 1600, true).follows).toBe(false);
  });
});
