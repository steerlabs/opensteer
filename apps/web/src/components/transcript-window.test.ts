import { describe, expect, it } from "vitest";
import type { TranscriptGroup } from "@opensteer/client/host";
import {
  transcriptPinnedTail,
  transcriptRowOf,
  transcriptWindow,
  transcriptWindowMinimum,
  type TranscriptSegment,
} from "./transcript-window.js";

const keys = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const measured = (rows: readonly string[], size = 100) => new Map(rows.map((key) => [key, size]));
const drawn = (segments: readonly TranscriptSegment[], rows: readonly string[]) =>
  segments.flatMap((segment) =>
    segment.kind === "rows" ? rows.slice(segment.from, segment.to) : [],
  );
const gaps = (segments: readonly TranscriptSegment[]) =>
  segments.flatMap((segment) => (segment.kind === "gap" ? [segment.height] : []));
const window = (rows: readonly string[], top: number | null, keep: readonly string[] = []) =>
  transcriptWindow({
    keys: rows,
    sizes: measured(rows),
    top,
    height: 500,
    overscan: 500,
    keep: new Set(keep),
  });

describe("transcriptWindow", () => {
  it("draws every row of a short conversation", () => {
    const rows = keys(transcriptWindowMinimum);
    expect(window(rows, 0)).toEqual([{ kind: "rows", from: 0, to: rows.length }]);
  });

  it("opens at the tail with the newest rows drawn and the rest one measured gap", () => {
    const rows = keys(200);
    const segments = window(rows, null);
    // The viewport's 5 rows and 5 more above it; the pinned tail is inside them.
    expect(drawn(segments, rows)).toEqual(rows.slice(190));
    expect(gaps(segments)).toEqual([190 * 100]);
    expect(drawn(segments, rows)).toEqual(
      expect.arrayContaining(rows.slice(-transcriptPinnedTail)),
    );
  });

  it("draws around the viewport mid-conversation and keeps the active tail", () => {
    const rows = keys(200);
    const segments = window(rows, 10_000);
    expect(drawn(segments, rows)).toEqual([...rows.slice(95, 110), ...rows.slice(196)]);
    expect(gaps(segments)).toEqual([95 * 100, 86 * 100]);
  });

  it("keeps a jump target drawn far from the viewport, with the row above it", () => {
    const rows = keys(200);
    const segments = window(rows, null, ["r20"]);
    expect(drawn(segments, rows).slice(0, 2)).toEqual(["r19", "r20"]);
    expect(gaps(segments)[0]).toBe(19 * 100);
  });

  it("keeps a held anchor drawn when an earlier page lands above it", () => {
    const before = keys(100);
    // The reader held r50 at the top of the viewport when the page was asked for.
    const after = [...keys(40, "e"), ...before];
    const segments = transcriptWindow({
      keys: after,
      sizes: measured(before),
      top: 5_000,
      height: 500,
      overscan: 500,
      keep: new Set(["r50"]),
    });
    const shown = drawn(segments, after);
    expect(shown).toEqual(expect.arrayContaining(["r49", "r50"]));
    // The gap in front of the anchor is what the page's rows are expected to take, so the
    // scroller can move by the anchor's own measured offset.
    const anchor = segments.findIndex(
      (segment) => segment.kind === "rows" && after.slice(segment.from, segment.to).includes("r50"),
    );
    const above = segments.slice(0, anchor).reduce((total, segment) => {
      if (segment.kind === "gap") return total + segment.height;
      return total + (segment.to - segment.from) * 100;
    }, 0);
    expect(above).toBe((40 + 49) * 100);
  });

  it("counts an unmeasured row as the average measured one", () => {
    const rows = keys(100);
    const sizes = measured(rows.slice(0, 50), 300);
    const segments = transcriptWindow({
      keys: rows,
      sizes,
      top: null,
      height: 600,
      overscan: 600,
      keep: new Set(),
    });
    expect(gaps(segments)).toEqual([50 * 300 + 46 * 300]);
  });
});

describe("transcriptRowOf", () => {
  const message = (id: string) => ({ id, kind: "message" }) as never;
  const rows: { key: string; group: TranscriptGroup }[] = [
    { key: "m1", group: { key: "m1", kind: "message", entry: message("message-1") } },
    {
      key: "turn:run-1",
      group: {
        key: "turn:run-1",
        kind: "turn",
        turn: {
          run: null,
          runId: "run-1",
          reply: message("reply-1"),
          work: [message("step-1"), message("reply-1")],
          assignments: [],
        },
      },
    },
  ];
  it("names the row a jump target is drawn in", () => {
    expect(transcriptRowOf(rows, "message-1")).toBe("m1");
    expect(transcriptRowOf(rows, "step-1")).toBe("turn:run-1");
    expect(transcriptRowOf(rows, "reply-1")).toBe("turn:run-1");
    expect(transcriptRowOf(rows, "elsewhere")).toBeNull();
  });
});
