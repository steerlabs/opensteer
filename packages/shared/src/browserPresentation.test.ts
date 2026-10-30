import { expect, it } from "vitest";
import { browserRasterDensity } from "./browserPresentation.js";

it("rounds raster density up to the next supported step and falls back to the densest", () => {
  expect(browserRasterDensity(300, 800, 2)).toBe(0.75);
  expect(browserRasterDensity(400, 800, 2)).toBe(1);
  expect(browserRasterDensity(401, 800, 2)).toBe(1.25);
  expect(browserRasterDensity(800, 800, 3)).toBe(2);
  expect(browserRasterDensity(0, 800, 2)).toBe(2);
  expect(browserRasterDensity(400, Number.NaN, 2)).toBe(2);
});
