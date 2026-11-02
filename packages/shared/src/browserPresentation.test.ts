import { expect, it } from "vitest";
import {
  browserCropCue,
  browserFrameContentRect,
  browserFrameCornerRadii,
  browserRasterDensity,
} from "./browserPresentation.js";

it("rounds a picture's corners only where it floats free of its stage", () => {
  const stage = { left: 0, top: 0, width: 800, height: 600 };
  const corners = (width: number, height: number, align: "top" | "center") =>
    browserFrameCornerRadii(
      stage,
      browserFrameContentRect(stage, width * 2, height * 2, { width, height }, align)!,
    );
  const r = browserCropCue.radius;
  // Filling the stage, or one side of it, the picture meets the toolbar and panel square.
  expect(corners(800, 600, "top")).toEqual([0, 0, 0, 0]);
  expect(corners(1600, 900, "top")).toEqual([0, 0, 0, 0]);
  expect(corners(1600, 900, "center")).toEqual([0, 0, 0, 0]);
  expect(corners(400, 1200, "center")).toEqual([0, 0, 0, 0]);
  // Smaller both ways it is a card: under the toolbar only its lower corners are free.
  expect(corners(500, 300, "top")).toEqual([0, 0, r, r]);
  expect(corners(500, 300, "center")).toEqual([r, r, r, r]);
});

it("rounds raster density up to the next supported step and falls back to the densest", () => {
  expect(browserRasterDensity(300, 800, 2)).toBe(0.75);
  expect(browserRasterDensity(400, 800, 2)).toBe(1);
  expect(browserRasterDensity(401, 800, 2)).toBe(1.25);
  expect(browserRasterDensity(800, 800, 3)).toBe(2);
  expect(browserRasterDensity(0, 800, 2)).toBe(2);
  expect(browserRasterDensity(400, Number.NaN, 2)).toBe(2);
});
