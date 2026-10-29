export const browserFrameLimits = Object.freeze({
  maxDevicePixelRatio: 4,
  maxHeight: 4_320,
  maxPhysicalPixels: 16_777_216,
  maxWidth: 7_680,
});

/**
 * The size a Browser Session's pages start at before a person's view gives
 * it one: the Browser panel's page area as measured in the desktop app's
 * default 1360×820 window, where the panel is as wide as the conversation
 * beside it allows and its toolbar and tab strip take 91 px of its height.
 * Opening the panel there leaves the page as it is.
 */
export const defaultBrowserViewport = Object.freeze({ height: 729, width: 709 });

export function browserFrameFits(width: number, height: number, devicePixelRatio = 1): boolean {
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > browserFrameLimits.maxWidth ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > browserFrameLimits.maxHeight ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    devicePixelRatio > browserFrameLimits.maxDevicePixelRatio
  ) {
    return false;
  }
  // A fractional scale factor gives a fractional area; Chromium rounds the
  // raster, so only the bound matters.
  return width * height * devicePixelRatio ** 2 <= browserFrameLimits.maxPhysicalPixels;
}
