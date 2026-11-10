import { describe, expect, it } from "vitest";
import { barFloats, barShown, edgeSwipe, nextBar, type BarScroll } from "./floating-bar.js";

const end = 4000;
function scroll(ys: readonly number[], person = true, from: BarScroll = barShown): BarScroll {
  return ys.reduce((state, y) => nextBar(state, { end, person, y }), from);
}

describe("the floating bar", () => {
  it("shrinks once the person reads down, ignores jitter and returns once they head back up", () => {
    expect(scroll([0, 12, 20]).shrunk).toBe(false);
    const shrunk = scroll([0, 12, 20, 30]);
    expect(shrunk.shrunk).toBe(true);
    // Back and forth by less than the travel changes nothing either way.
    expect(scroll([900, 880, 900, 1200, 1185], true, shrunk).shrunk).toBe(true);
    expect(scroll([1200, 1180], true, shrunk).shrunk).toBe(true);
    expect(scroll([1200, 1170], true, shrunk).shrunk).toBe(false);
  });

  it("is shown at either end of the page, however it got there", () => {
    const shrunk = scroll([400, 600]);
    expect(shrunk.shrunk).toBe(true);
    expect(scroll([4], false, shrunk).shrunk).toBe(false);
    expect(scroll([end - 2], false, shrunk).shrunk).toBe(false);
  });

  it("is left alone when something else moves the page, and counts afresh from there", () => {
    const moved = scroll([2000], false);
    expect(moved.shrunk).toBe(false);
    // An agent scrolling up under a shrunk bar does not bring it back.
    expect(scroll([500, 100], false, scroll([300, 400])).shrunk).toBe(true);
    // The person's next small movement after a jump does not flip the bar.
    expect(scroll([2010], true, moved).shrunk).toBe(false);
    expect(scroll([2030], true, moved).shrunk).toBe(true);
  });

  it("floats on a phone's own page, but not beside its conversation or on a tall regular screen", () => {
    expect(barFloats({ edge: "bottom", height: 700, paired: false })).toBe(true);
    expect(barFloats({ edge: "top", height: 360, paired: false })).toBe(true);
    expect(barFloats({ edge: "top", height: 900, paired: false })).toBe(false);
    expect(barFloats({ edge: "top", height: 360, paired: true })).toBe(false);
  });

  it("swipes back through the page while it has history, and otherwise out of the tab", () => {
    expect(edgeSwipe({ canGoBack: true })).toBe("page");
    expect(edgeSwipe({ canGoBack: false })).toBe("leave");
  });
});
