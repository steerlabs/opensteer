import { describe, expect, it } from "vitest";
import {
  BrowserVideoFrameHeaderSchema,
  decodeBrowserVideoFrame,
  encodeBrowserVideoFrame,
  browserVideoCounter,
  browserVideoRootPoint,
} from "./browser-video.js";
import { TargetedBrowserClientMessageSchema } from "./browser.js";
import { browserVideoTestHeader } from "./browser-video.test-support.js";

describe("certified browser video wire", () => {
  it("round trips an immutable certificate and binary AU in the common envelope", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65]);
    const decoded = decodeBrowserVideoFrame(
      encodeBrowserVideoFrame(browserVideoTestHeader, payload),
    );
    expect(decoded.header).toEqual(browserVideoTestHeader);
    expect(decoded.payload).toEqual(payload);
    expect(Object.isFrozen(decoded.header.presentation.rasterCrop)).toBe(true);
  });
  it("rejects noncanonical, unsafe and overflowing producer counters without rounding", () => {
    for (const value of ["01", "-1", "1.0", "9007199254740992", "18446744073709551616"])
      expect(() => browserVideoCounter(value)).toThrow();
    expect(browserVideoCounter("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("bounds geometry and maps the captured raster without document offsets", () => {
    expect(browserVideoRootPoint(browserVideoTestHeader, { x: 64, y: 64 })).toEqual({
      x: 50,
      y: 50,
    });
    expect(() => browserVideoRootPoint(browserVideoTestHeader, { x: 0, y: 0 })).toThrow();
    for (const patch of [
      { width: 4096 },
      { width: 127 },
      {
        presentation: {
          ...browserVideoTestHeader.presentation,
          rasterCrop: { x: 0.5, y: 0, width: 100, height: 100 },
        },
      },
      {
        presentation: {
          ...browserVideoTestHeader.presentation,
          rasterCrop: { x: 100, y: 0, width: 100, height: 100 },
        },
      },
    ])
      expect(
        BrowserVideoFrameHeaderSchema.safeParse({ ...browserVideoTestHeader, ...patch }).success,
      ).toBe(false);
  });
});

it("admits H.264 scrolling on the existing targeted input lane", () => {
  expect(
    TargetedBrowserClientMessageSchema.safeParse({
      type: "input.wheel",
      surfaceId: "tab",
      geometryRevision: browserVideoTestHeader.geometryRevision,
      viewportWidth: 100,
      viewportHeight: 100,
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: 50,
      modifiers: [],
    }).success,
  ).toBe(true);
});
