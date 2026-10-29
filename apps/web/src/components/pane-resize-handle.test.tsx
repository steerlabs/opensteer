import { describe, expect, it } from "vitest";
import {
  paneSizeFromKey,
  paneSizeFromPointer,
  readPersistedPaneSize,
  type PaneSizeRange,
} from "./pane-resize-handle.js";

const range: PaneSizeRange = { defaultValue: 288, max: 440, min: 224, step: 16 };

describe("PaneResizeHandle", () => {
  it("resizes panes in the direction of their anchored edge", () => {
    expect(
      paneSizeFromPointer({
        clientX: 360,
        max: 440,
        min: 224,
        side: "left",
        startSize: 288,
        startX: 300,
      }),
    ).toBe(348);
    expect(
      paneSizeFromPointer({
        clientX: 240,
        max: 960,
        min: 320,
        side: "right",
        startSize: 430,
        startX: 300,
      }),
    ).toBe(490);
  });

  it("clamps pointer and keyboard resizing to the active range", () => {
    expect(
      paneSizeFromPointer({
        clientX: 900,
        max: range.max,
        min: range.min,
        side: "left",
        startSize: range.defaultValue,
        startX: 0,
      }),
    ).toBe(range.max);
    expect(
      paneSizeFromKey({ key: "Home", max: 960, min: 320, side: "right", step: 24, value: 430 }),
    ).toBe(320);
    expect(
      paneSizeFromKey({
        key: "ArrowLeft",
        max: 960,
        min: 320,
        side: "right",
        step: 24,
        value: 430,
      }),
    ).toBe(454);
    expect(
      paneSizeFromKey({ key: "Escape", max: 960, min: 320, side: "right", step: 24, value: 430 }),
    ).toBeNull();
  });

  it("loads only finite positive persisted widths", () => {
    expect(readPersistedPaneSize("pane", range, { getItem: () => "372" })).toBe(372);
    expect(readPersistedPaneSize("pane", range, { getItem: () => "999" })).toBe(range.max);
    expect(readPersistedPaneSize("pane", range, { getItem: () => "not-a-number" })).toBe(
      range.defaultValue,
    );
  });
});
