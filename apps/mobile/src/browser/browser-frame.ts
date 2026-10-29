import type { BrowserFrameView } from "@opensteer/client/host";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";

/** Keep data-URI construction below the Host client's own 8 MiB frame limit. */
export const mobileBrowserFrameMaxBytes = 8 * 1_024 * 1_024;

export interface MobileBrowserFrame {
  readonly key: string;
  readonly uri: string;
}

/**
 * Where a touch lands on the drawn picture, as the input targeted control
 * accepts: that picture's geometry revision, and no modifier keys. A picture
 * without a geometry revision cannot be aimed at, so it takes no touch.
 */
export function mobileBrowserPoint(input: {
  readonly frame: BrowserFrameView | null;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}) {
  const { frame, width, height } = input;
  if (frame === null || width <= 0 || height <= 0) return null;
  const { geometryRevision } = frame.header;
  if (geometryRevision === undefined) return null;
  const rect = browserFrameContentRect(
    { left: 0, top: 0, width, height },
    frame.header.rasterWidth,
    frame.header.rasterHeight,
    frame.header.capture,
    "center",
  );
  if (!rect) return null;
  const x = (input.x - rect.left) / rect.width;
  const y = (input.y - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return {
    geometryRevision,
    ...(frame.header.capture ? { captureRevision: frame.header.capture.revision } : {}),
    modifiers: [],
    surfaceId: frame.header.surfaceId,
    viewportWidth: frame.header.viewportWidth,
    viewportHeight: frame.header.viewportHeight,
    x,
    y,
  };
}

/**
 * Turns only the current surface's newest validated frame into an Image source.
 * Returning null is intentional: an old tab must never remain visible while the
 * selected tab is waiting for its first frame.
 */
export function mobileBrowserFrame(
  frame: BrowserFrameView | null,
  activeSurfaceId: string | null,
  active: boolean,
): MobileBrowserFrame | null {
  if (!active || !frame || !activeSurfaceId || frame.header.surfaceId !== activeSurfaceId) {
    return null;
  }
  if (frame.data.byteLength < 1 || frame.data.byteLength > mobileBrowserFrameMaxBytes) return null;

  const bytes = new Uint8Array(frame.data);
  const base64Url = encodeBase64Url(bytes);
  const base64 = base64Url.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return {
    key: mobileBrowserFrameKey(frame),
    uri: `data:image/${frame.header.encoding};base64,${base64}${padding}`,
  };
}

/**
 * One delivery of a picture. A resubscribed Watch feed can redeliver the
 * runtime's same frame ID; only its token tells that delivery apart, and each
 * delivery needs its own acknowledgement.
 */
export function mobileBrowserFrameKey(frame: BrowserFrameView): string {
  const key = `${frame.header.surfaceId}:${frame.header.frameId}`;
  return frame.header.watchToken ? `${key}:${frame.header.watchToken}` : key;
}

/**
 * Starts one decode only when the native Image slot is free. While it is busy,
 * callers retain no converted intermediates; after it completes they call this
 * with the frame store's then-current value, naturally taking the latest.
 */
export function nextMobileBrowserDecode(input: {
  readonly active: boolean;
  readonly activeSurfaceId: string | null;
  /**
   * The delivery the view last finished with — shown, or dropped because it
   * could not be decoded — which is never decoded again.
   */
  readonly settledFrameKey: string | null;
  readonly frame: BrowserFrameView | null;
  readonly inFlightFrameKey: string | null;
}): MobileBrowserFrame | null {
  if (input.inFlightFrameKey) return null;
  if (
    input.frame &&
    input.frame.header.surfaceId === input.activeSurfaceId &&
    mobileBrowserFrameKey(input.frame) === input.settledFrameKey
  ) {
    return null;
  }
  return mobileBrowserFrame(input.frame, input.activeSurfaceId, input.active);
}
