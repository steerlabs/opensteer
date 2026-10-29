import type { BrowserFrameView } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  mobileBrowserFrame,
  mobileBrowserFrameMaxBytes,
  mobileBrowserPoint,
  nextMobileBrowserDecode,
} from "./browser-frame.js";

function frame(overrides: Partial<BrowserFrameView["header"]> = {}): BrowserFrameView {
  return {
    data: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
    header: {
      encoding: "jpeg",
      frameId: 7,
      geometryRevision: 3,
      rasterHeight: 600,
      rasterWidth: 800,
      surfaceId: BrowserSurfaceIdSchema.parse("surface-a"),
      viewportHeight: 600,
      viewportWidth: 800,
      ...overrides,
    },
  };
}

describe("mobileBrowserFrame", () => {
  it("maps page touches through contain scaling and excludes letterboxing or missing layout", () => {
    const input = { frame: frame(), width: 400, height: 600, x: 200, y: 300 };
    expect(mobileBrowserPoint(input)).toEqual({
      geometryRevision: 3,
      modifiers: [],
      x: 0.5,
      y: 0.5,
      viewportWidth: 800,
      viewportHeight: 600,
      surfaceId: "surface-a",
    });
    expect(
      mobileBrowserPoint({ ...input, frame: frame({ geometryRevision: undefined }) }),
    ).toBeNull();
    expect(mobileBrowserPoint({ ...input, y: 10 })).toBeNull();
    expect(mobileBrowserPoint({ ...input, x: -1 })).toBeNull();
    expect(mobileBrowserPoint({ ...input, width: 0 })).toBeNull();
    expect(mobileBrowserPoint({ ...input, frame: null })).toBeNull();
  });

  it("maps a cropped picture and echoes the revisions of that picture", () => {
    const picture = frame({
      viewportWidth: 1600,
      viewportHeight: 1000,
      rasterWidth: 1600,
      rasterHeight: 1200,
      geometryRevision: 7,
      capture: { width: 800, height: 600, revision: 9 },
    });
    expect(mobileBrowserPoint({ frame: picture, width: 400, height: 600, x: 200, y: 300 })).toEqual(
      {
        surfaceId: "surface-a",
        viewportWidth: 1600,
        viewportHeight: 1000,
        geometryRevision: 7,
        captureRevision: 9,
        modifiers: [],
        x: 0.5,
        y: 0.5,
      },
    );
    expect(
      mobileBrowserPoint({ frame: picture, width: 400, height: 600, x: 200, y: 10 }),
    ).toBeNull();
  });

  it("builds a standard-base64 native image source", () => {
    expect(mobileBrowserFrame(frame(), "surface-a", true)).toEqual({
      key: "surface-a:7",
      uri: "data:image/jpeg;base64,/9j/",
    });
  });

  it("clears frames when hidden or when the selected surface changes", () => {
    expect(mobileBrowserFrame(frame(), "surface-a", false)).toBeNull();
    expect(mobileBrowserFrame(frame(), "surface-b", true)).toBeNull();
    expect(mobileBrowserFrame(frame(), null, true)).toBeNull();
  });

  it("pads partial base64 groups and keeps the declared image format", () => {
    const oneByte = { ...frame({ encoding: "png" }), data: Uint8Array.of(255).buffer };
    const twoBytes = { ...frame(), data: Uint8Array.of(255, 216).buffer };
    expect(mobileBrowserFrame(oneByte, "surface-a", true)?.uri).toBe("data:image/png;base64,/w==");
    expect(mobileBrowserFrame(twoBytes, "surface-a", true)?.uri).toBe(
      "data:image/jpeg;base64,/9g=",
    );
  });

  it("rejects an image above the mobile conversion bound", () => {
    const oversized = {
      ...frame(),
      data: new ArrayBuffer(mobileBrowserFrameMaxBytes + 1),
    };
    expect(mobileBrowserFrame(oversized, "surface-a", true)).toBeNull();
  });
});

describe("nextMobileBrowserDecode", () => {
  it("keeps at most one decode in flight and skips the frame the view finished with", () => {
    expect(
      nextMobileBrowserDecode({
        active: true,
        activeSurfaceId: "surface-a",
        settledFrameKey: null,
        frame: frame({ frameId: 8 }),
        inFlightFrameKey: "surface-a:7",
      }),
    ).toBeNull();
    expect(
      nextMobileBrowserDecode({
        active: true,
        activeSurfaceId: "surface-a",
        settledFrameKey: "surface-a:7",
        frame: frame(),
        inFlightFrameKey: null,
      }),
    ).toBeNull();
  });

  it("takes the latest store frame once the decode slot is free", () => {
    expect(
      nextMobileBrowserDecode({
        active: true,
        activeSurfaceId: "surface-a",
        settledFrameKey: "surface-a:7",
        frame: frame({ frameId: 10 }),
        inFlightFrameKey: null,
      })?.key,
    ).toBe("surface-a:10");
  });
});
