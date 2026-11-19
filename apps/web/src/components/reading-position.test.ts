import { describe, expect, it } from "vitest";
import { anchorCorrection, readingAnchor } from "./reading-position.js";

describe("reading position", () => {
  const rows = [
    { key: "a", top: 0, bottom: 300 },
    { key: "hidden", top: 300, bottom: 300 },
    { key: "b", top: 300, bottom: 700 },
    { key: "c", top: 700, bottom: 900 },
  ];

  it("anchors on the first row still in view, by its offset", () => {
    expect(readingAnchor(rows, 450)).toEqual({ key: "b", offset: -150 });
    expect(readingAnchor(rows, 300)).toEqual({ key: "b", offset: 0 });
    expect(readingAnchor(rows, 950)).toBeNull();
  });

  it("puts the anchor back however the rows above it measured", () => {
    const anchor = readingAnchor(rows, 450)!;
    // The rows above were measured taller than estimated: the anchor now starts 2,000 px down.
    expect(anchorCorrection(anchor, 2_450, 450)).toBe(2_150);
    // Re-applied after that scroll, it is in place and stays put.
    expect(anchorCorrection(anchor, 300, 450)).toBe(0);
    expect(anchorCorrection(anchor, 300.4, 450)).toBe(0);
  });
});
