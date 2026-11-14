import { describe, expect, it } from "vitest";
import { readTail } from "./tailFollow.js";

describe("readTail", () => {
  const following = { follows: true, offset: 1600 };

  it("keeps following when the scroller only clamps to a shorter extent", () => {
    // The viewport grew by 100px: the offset fell with the most it scrolls.
    expect(readTail(following, 1500, 1500, false).follows).toBe(true);
  });

  it("lets go at a one-pixel move up from the foot", () => {
    expect(readTail(following, 1599, 1600, true).follows).toBe(false);
  });

  it("takes the foot up again only on the reader's own scroll", () => {
    const reading = { follows: false, offset: 1500 };
    expect(readTail(reading, 1600, 1600, false).follows).toBe(false);
    expect(readTail(reading, 1599, 1600, true).follows).toBe(true);
    expect(readTail(reading, 1570, 1600, true).follows).toBe(false);
  });
});
