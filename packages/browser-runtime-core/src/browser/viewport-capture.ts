import { browserFrameFits } from "@opensteer/browser-core/frame-limits";
import { BrowserRuntimeError } from "../errors.js";
import type { PageSize } from "./surface-ledger.js";

/** A region of the visual viewport in CSS pixels, returned at `scale` image pixels per CSS pixel. */
export interface ViewportClip {
  readonly height: number;
  readonly scale: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface ViewportCaptureRequest {
  readonly clip?: ViewportClip;
  readonly format: "jpeg" | "png" | "webp";
  /** The size the ledger gave the page, before its page scale. */
  readonly layout: PageSize;
  /** What the page's zoom and visual viewport multiply a CSS pixel by. */
  readonly pageScale: number;
  /** Only jpeg and webp have one. */
  readonly quality?: number;
}

export interface ViewportCapture {
  /** Present when a person's view shows less of the page than its size; sizes are CSS pixels. */
  readonly cropped?: { readonly page: PageSize; readonly visible: PageSize };
  /** The base64 image. */
  readonly data: string;
}

interface BitmapRegion {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface ViewportCapturePlan {
  readonly output: PageSize;
  readonly source: BitmapRegion;
}

/**
 * Maps a surface bitmap showing `visible` CSS pixels to the image an agent
 * gets, whose pixel (x, y) is where an input at (x, y) lands. The bitmap's own
 * size is the only density used: a window can move between displays mid-capture.
 */
export function viewportCapturePlan(
  bitmap: PageSize,
  visible: PageSize,
  clip: ViewportClip | undefined,
): ViewportCapturePlan {
  const region = clip ?? { x: 0, y: 0, ...visible, scale: 1 };
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > visible.width ||
    region.y + region.height > visible.height
  )
    throw new BrowserRuntimeError(
      "bad_message",
      `The screenshot clip lies outside the ${visible.width}×${visible.height} the page shows now. Scroll the region into view and capture again.`,
    );
  const output = {
    height: Math.max(1, Math.round(region.height * region.scale)),
    width: Math.max(1, Math.round(region.width * region.scale)),
  };
  if (!browserFrameFits(output.width, output.height))
    throw new BrowserRuntimeError(
      "bad_message",
      `A ${output.width}×${output.height} screenshot is too large. Lower the clip's scale or size.`,
    );
  const horizontal = bitmap.width / visible.width;
  const vertical = bitmap.height / visible.height;
  // Fractional: rounding the source to whole bitmap pixels would shift a resampled region.
  return {
    output,
    source: {
      height: region.height * vertical,
      width: region.width * horizontal,
      x: region.x * horizontal,
      y: region.y * vertical,
    },
  };
}

/**
 * A script that crops, resizes and encodes an image with Chromium's own codecs,
 * for an engine without them. Run it in a private page, never the agent's.
 */
export function viewportImageScript(
  data: string,
  { output, source }: ViewportCapturePlan,
  { format, quality }: Pick<ViewportCaptureRequest, "format" | "quality">,
): string {
  return `(async ({ data, output, source, type, quality }) => {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(output.width, output.height);
    canvas.getContext("2d").drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, output.width, output.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type, quality });
    const encoded = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let at = 0; at < encoded.length; at += 8192)
      binary += String.fromCharCode(...encoded.subarray(at, at + 8192));
    return btoa(binary);
  })(${JSON.stringify({
    data,
    output,
    source,
    type: `image/${format}`,
    ...(quality === undefined ? {} : { quality: quality / 100 }),
  })})`;
}
