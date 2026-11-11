import { describe, expect, it } from "vitest";
import { windowPlan } from "./windowed-rows.js";

const rows = (count: number, size = 33) => Array.from({ length: count }, () => size);

describe("windowPlan", () => {
  it("draws only the rows in view and its overscan, standing spacers in for the rest", () => {
    const plan = windowPlan({
      sizes: rows(2_000),
      gap: 1,
      top: 33 * 1_000,
      height: 330,
      overscan: 66,
      pinned: [],
    });
    const drawn = plan.flatMap((item) => ("index" in item ? [item.index] : []));
    expect(drawn[0]).toBe(998);
    expect(drawn.at(-1)).toBe(1_011);
    // Each spacer stands for its rows' sizes less the one gap the spacer keeps itself.
    expect(plan[0]).toEqual({ spacer: 33 * 998 - 1 });
    expect(plan.at(-1)).toEqual({ spacer: 33 * (2_000 - 1_012) - 1 });
  });

  it("keeps the whole list's height, so the scrollbar never jumps as the window moves", () => {
    const sizes = [37, 33, 33, 41, 33, 33, 33, 37, 33, 33];
    const gap = 1;
    const full = sizes.reduce((sum, size) => sum + size, 0) - gap;
    for (const top of [0, 50, 120, 200, 300]) {
      const plan = windowPlan({ sizes, gap, top, height: 70, overscan: 0, pinned: [] });
      // The list's flex gap stands between every two children it draws.
      const drawn = plan.reduce(
        (sum, item) => sum + ("index" in item ? sizes[item.index]! - gap : item.spacer),
        0,
      );
      expect(drawn + gap * (plan.length - 1)).toBe(full);
    }
  });

  it("draws a pinned row where it stands, however far from the view", () => {
    const plan = windowPlan({
      sizes: rows(500),
      gap: 1,
      top: 0,
      height: 99,
      overscan: 0,
      pinned: [400],
    });
    expect(plan.map((item) => ("index" in item ? item.index : "spacer"))).toEqual([
      0,
      1,
      2,
      "spacer",
      400,
      "spacer",
    ]);
    expect(plan[3]).toEqual({ spacer: 33 * (400 - 3) - 1 });
  });

  it("draws everything for a list shorter than its view", () => {
    const plan = windowPlan({
      sizes: rows(4),
      gap: 1,
      top: 0,
      height: 600,
      overscan: 0,
      pinned: [],
    });
    expect(plan).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
  });
});
