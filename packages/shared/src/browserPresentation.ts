export interface BrowserFrameRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export const browserCropCue = {
  size: 24,
  radius: 15,
  right: "linear-gradient(to right, transparent, rgba(8, 8, 8, 0.6))",
  bottom: "linear-gradient(to bottom, transparent, rgba(8, 8, 8, 0.6))",
} as const;

export function browserFrameContentRect(
  container: BrowserFrameRect,
  rasterWidth: number,
  rasterHeight: number,
  capture?: { readonly width: number; readonly height: number },
  align: "top" | "center" = "top",
  allowUpscale = false,
): BrowserFrameRect | null {
  const region = capture ?? { width: rasterWidth, height: rasterHeight };
  if (
    ![
      container.width,
      container.height,
      rasterWidth,
      rasterHeight,
      region.width,
      region.height,
    ].every((value) => Number.isFinite(value) && value > 0)
  )
    return null;
  const scale = Math.min(
    capture && !allowUpscale ? 1 : Infinity,
    container.width / region.width,
    container.height / region.height,
  );
  const width = region.width * scale;
  const height = region.height * scale;
  return {
    width,
    height,
    left: container.left + (container.width - width) / 2,
    top: container.top + (align === "center" ? (container.height - height) / 2 : 0),
  };
}

/**
 * Corner radii, clockwise from top left, for a picture at `rect` in `container`.
 * A corner is round only where the picture floats free of the container on
 * both of its sides; where the picture meets an edge, such as the toolbar
 * above it, it stays square and joins that edge without a notch.
 */
export function browserFrameCornerRadii(
  container: BrowserFrameRect,
  rect: BrowserFrameRect,
): readonly [number, number, number, number] {
  const top = rect.top - container.top >= 1;
  const left = rect.left - container.left >= 1;
  const right = container.left + container.width - (rect.left + rect.width) >= 1;
  const bottom = container.top + container.height - (rect.top + rect.height) >= 1;
  const r = browserCropCue.radius;
  return [
    top && left ? r : 0,
    top && right ? r : 0,
    bottom && right ? r : 0,
    bottom && left ? r : 0,
  ];
}

/** Choose the smallest supported raster density that covers the displayed pixels. */
export function browserRasterDensity(
  displayedWidth: number,
  contentWidth: number,
  devicePixelRatio: number,
): 0.75 | 1 | 1.25 | 1.5 | 2 {
  if (
    ![displayedWidth, contentWidth, devicePixelRatio].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return 2;
  const required = (displayedWidth * devicePixelRatio) / contentWidth;
  return ([0.75, 1, 1.25, 1.5, 2] as const).find((density) => density >= required) ?? 2;
}
