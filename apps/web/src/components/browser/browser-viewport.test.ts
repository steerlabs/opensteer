import { describe, expect, it } from "vitest";
import type { BrowserFrameView } from "@opensteer/client/host";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";
import {
  browserViewportSize,
  normalizedBrowserFramePoint,
  mappedBrowserCaret,
} from "./browser-viewport.js";

describe("browserFrameContentRect", () => {
  it("keeps a stable browser frame at the top, centred across, preserving its aspect ratio", () => {
    expect(
      browserFrameContentRect({ height: 650, left: 10, top: 20, width: 430 }, 1_280, 720),
    ).toEqual({
      height: 241.875,
      left: 10,
      top: 20,
      width: 430,
    });
    const horizontalLetterbox = browserFrameContentRect(
      { height: 300, left: 0, top: 0, width: 960 },
      1_280,
      720,
    );
    expect(horizontalLetterbox?.height).toBe(300);
    expect(horizontalLetterbox?.left).toBeCloseTo(213.333_333);
    expect(horizontalLetterbox?.top).toBe(0);
    expect(horizontalLetterbox?.width).toBeCloseTo(533.333_333);
  });

  it("fits a native region once and never enlarges its DIPs", () => {
    const capture = { width: 800, height: 600 };
    expect(
      browserFrameContentRect({ left: 10, top: 20, width: 400, height: 250 }, 1600, 1200, capture),
    ).toEqual({
      left: 10 + (400 - 800 * (250 / 600)) / 2,
      top: 20,
      width: 800 * (250 / 600),
      height: 250,
    });
    expect(
      browserFrameContentRect({ left: 0, top: 0, width: 1200, height: 900 }, 1600, 1200, capture),
    ).toEqual({
      left: 200,
      top: 0,
      width: 800,
      height: 600,
    });
  });

  it("allows a preview to enlarge a small native region without changing main-view fitting", () => {
    const stage = { left: 0, top: 0, width: 400, height: 300 };
    const capture = { width: 200, height: 100 };
    expect(browserFrameContentRect(stage, 400, 200, capture, "top", true)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
    });
    expect(browserFrameContentRect(stage, 400, 200, capture)).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 100,
    });
  });

  it("rejects missing container or frame geometry", () => {
    expect(
      browserFrameContentRect({ height: 0, left: 0, top: 0, width: 430 }, 1_280, 720),
    ).toBeNull();
    expect(
      browserFrameContentRect({ height: 650, left: 0, top: 0, width: 430 }, 0, 720),
    ).toBeNull();
  });
});

describe("explicit browser Fit geometry", () => {
  it("rounds the panel's content box to integer CSS pixels", () => {
    expect(browserViewportSize({ height: 719.51, width: 1_279.49 })).toEqual({
      height: 720,
      width: 1_279,
    });
    expect(browserViewportSize({ height: 0, width: 800 })).toBeNull();
    expect(browserViewportSize({ height: Number.NaN, width: 800 })).toBeNull();
    expect(browserViewportSize({ height: 5_000, width: 8_000 })).toBeNull();
  });
});

describe("normalizedBrowserFramePoint", () => {
  const frame: BrowserFrameView = {
    data: new ArrayBuffer(0),
    header: {
      encoding: "jpeg",
      frameId: 4,
      rasterHeight: 720,
      rasterWidth: 1_280,
      surfaceId: "surface-1" as BrowserFrameView["header"]["surfaceId"],
      viewportHeight: 900,
      viewportWidth: 1_600,
    },
  };

  it("maps through the painted frame and carries its authoritative viewport geometry", () => {
    expect(
      normalizedBrowserFramePoint(
        { height: 360, left: 100, top: 50, width: 640 },
        frame,
        420,
        230,
        false,
      ),
    ).toEqual({
      surfaceId: "surface-1",
      viewportHeight: 900,
      viewportWidth: 1_600,
      x: 0.5,
      y: 0.5,
    });
  });

  it("drops a point outside the painted frame unless a drag asks it to be clamped", () => {
    const outside = { height: 360, left: 100, top: 50, width: 640 } as const;
    expect(normalizedBrowserFramePoint(outside, frame, 20, 230, false)).toBeNull();
    expect(normalizedBrowserFramePoint(outside, frame, 20, 230, true)).toMatchObject({
      x: 0,
      y: 0.5,
    });
    expect(normalizedBrowserFramePoint(outside, null, 420, 230, true)).toBeNull();
  });
});

describe("remote caret through the presented frame", () => {
  it("maps viewport coordinates through the actual crop and rejects off-crop carets", () => {
    const picture: BrowserFrameView = {
      data: new ArrayBuffer(0),
      header: {
        encoding: "jpeg",
        frameId: 1,
        surfaceId:
          "srf_00000000-0000-4000-8000-000000000001" as BrowserFrameView["header"]["surfaceId"],
        rasterWidth: 400,
        rasterHeight: 300,
        viewportWidth: 800,
        viewportHeight: 600,
        capture: { width: 400, height: 300, revision: 1 },
      },
    };
    const rect = { left: 0, top: 0, width: 400, height: 300 };
    expect(mappedBrowserCaret(rect, picture, { x: 0.25, y: 0.25, height: 0.02 })).toEqual({
      left: 200,
      top: 150,
      height: 12,
    });
    expect(mappedBrowserCaret(rect, picture, { x: 0.75, y: 0.25, height: 0.02 })).toBeNull();
  });
});
