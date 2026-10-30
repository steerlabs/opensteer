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
