import { describe, expect, it } from "vitest";
import {
  anchorCorrection,
  findReadingAnchor,
  neighbourKeys,
  readingAnchor,
  restoreTarget,
} from "./reading-position.js";

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

describe("finding the row in view", () => {
  /** Rows 40px tall, some empty, counting every geometry read. */
  function rows(count: number) {
    let reads = 0;
    const list = Array.from({ length: count }, (_, index) => {
      const empty = index % 7 === 3;
      return {
        key: `row-${index}`,
        getBoundingClientRect: () => {
          reads++;
          const top = index * 40;
          return { top, bottom: empty ? top : top + 40 } as DOMRect;
        },
      };
    });
    return { list: list as unknown as Element[], reads: () => reads };
  }
  const key = (row: Element) => (row as unknown as { key: string }).key;

  it("finds the same row as a scan from the top, reading a handful of rows however many there are", () => {
    const { list, reads } = rows(5_000);
    for (const viewportTop of [0, 15, 39, 40, 135, 99_999, 150_000]) {
      const scanned = readingAnchor(
        list.map((row) => ({ key: key(row), ...row.getBoundingClientRect() })),
        viewportTop,
      );
      const before = reads();
      expect(findReadingAnchor(list, viewportTop, key), String(viewportTop)).toEqual(scanned);
      expect(
        reads() - before,
        "a scroll frame read rows in proportion to the transcript",
      ).toBeLessThan(20);
    }
  });
});

describe("putting the reader back after a replacement", () => {
  const anchor = { key: "c", offset: -30, neighbours: ["b", "a", "d", "e"] };
  const drawn =
    (...keys: string[]) =>
    (key: string) =>
      keys.includes(key) ? key : null;

  it("is the measured row when it is still there", () => {
    expect(restoreTarget(anchor, drawn("a", "b", "c", "d"))).toBe("c");
  });
  it("is the nearest surviving older neighbour, else the nearest newer one", () => {
    expect(restoreTarget(anchor, drawn("a", "b", "d"))).toBe("b");
    expect(restoreTarget(anchor, drawn("a", "d"))).toBe("a");
    expect(restoreTarget(anchor, drawn("d", "e"))).toBe("d");
  });
  it("is the latest when nothing measured is left, never wherever the scroll was", () => {
    expect(restoreTarget(anchor, drawn("x", "y"))).toBe("latest");
  });
  it("records the neighbours nearest first, older then newer", () => {
    const rows = ["a", "b", "c", "d", "e"].map((key) => ({ key }) as unknown as Element);
    expect(neighbourKeys(rows, 2, (row) => (row as unknown as { key: string }).key)).toEqual([
      "b",
      "a",
      "d",
      "e",
    ]);
  });
});
