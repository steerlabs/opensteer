import { describe, expect, it } from "vitest";
import { viewportCapturePlan } from "./viewport-capture.js";

const visible = { width: 631, height: 759 };

describe("viewportCapturePlan", () => {
  it("returns the whole bitmap at the page's CSS size, whatever its density", () => {
    expect(viewportCapturePlan({ width: 1_262, height: 1_518 }, visible, undefined)).toEqual({
      output: visible,
      source: { x: 0, y: 0, width: 1_262, height: 1_518 },
    });
    // Page scale below 1: fewer bitmap pixels than CSS pixels.
    expect(
      viewportCapturePlan({ width: 390, height: 700 }, { width: 980, height: 1_759 }, undefined),
    ).toEqual({
      output: { width: 980, height: 1_759 },
      source: { x: 0, y: 0, width: 390, height: 700 },
    });
  });

  it("crops a clip in bitmap pixels and scales it from CSS pixels", () => {
    expect(
      viewportCapturePlan({ width: 1_262, height: 1_518 }, visible, {
        x: 10.5,
        y: 20,
        width: 100,
        height: 50.25,
        scale: 2,
      }),
    ).toEqual({
      output: { width: 200, height: 101 },
      source: { x: 21, y: 40, width: 200, height: 101 },
    });
  });

  it.each([
    [{ x: -1, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: -1, width: 10, height: 10 }],
    [{ x: 625, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: 755, width: 10, height: 10 }],
  ])("refuses a clip off the surface: %j", (region) => {
    expect(() => viewportCapturePlan(visible, visible, { ...region, scale: 1 })).toThrow(
      /outside the 631×759 the page shows now/,
    );
  });

  it("refuses an output no frame may be, before anything allocates it", () => {
    expect(() =>
      viewportCapturePlan(visible, visible, { x: 0, y: 0, width: 600, height: 700, scale: 100 }),
    ).toThrow(/too large/);
  });
});
