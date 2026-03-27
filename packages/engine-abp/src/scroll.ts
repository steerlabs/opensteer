import { createBrowserCoreError } from "@opensteer/browser-core";

export interface AbpScrollSegment {
  readonly delta_px: number;
  readonly direction: "x" | "y";
}

export function buildAbpScrollSegments(delta: {
  readonly x: number;
  readonly y: number;
}): readonly AbpScrollSegment[] {
  const { x, y } = delta;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw createBrowserCoreError(
      "invalid-argument",
      `ABP scroll deltas must be finite numbers, received (${String(x)}, ${String(y)})`,
    );
  }

  const segments: AbpScrollSegment[] = [];
  if (x !== 0) {
    segments.push({
      delta_px: x,
      direction: "x",
    });
  }
  if (y !== 0) {
    segments.push({
      delta_px: y,
      direction: "y",
    });
  }
  if (segments.length === 0) {
    throw createBrowserCoreError(
      "invalid-argument",
      "ABP scroll requires at least one non-zero delta",
    );
  }
  return segments;
}
