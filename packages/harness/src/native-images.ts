import { attachmentImageMaxPixels, OpensteerError } from "@opensteer/core";
import type { Metadata, Sharp } from "sharp";
import { readVerifiedAttachmentBytes } from "./input-projection.js";
import type { ResolvedAttachment } from "./types.js";

let decoder: Promise<typeof import("sharp")> | undefined;

/**
 * The native image decoder, loaded by the first image a process prepares.
 * Importing this package loads nothing native, so a process that never hands
 * an engine an image (the desktop app's main process) never maps libvips.
 */
function imageDecoder(): Promise<typeof import("sharp")> {
  decoder ??= import("sharp");
  return decoder;
}

/**
 * What one engine takes as given on every path a driver delivers images
 * through. Anything outside it is fitted before delivery; the engine still
 * does its own model-specific fitting afterwards.
 */
export interface NativeImageLimits {
  /** Media types the engine decodes. */
  readonly mediaTypes: readonly string[];
  /** Largest encoded image one delivery can carry, in bytes. */
  readonly maxBytes: number;
  /** Longest side the engine takes as given, in pixels. */
  readonly maxEdge?: number;
  /** Largest buffer the engine's decoder allocates: width × height × channels × bytes per sample. */
  readonly maxDecodedBytes?: number;
}

export interface PreparedNativeImage {
  readonly bytes: Buffer;
  readonly mediaType: string;
  /** False when `bytes` are the verified original. */
  readonly transformed: boolean;
}

/** Proves the native decoder loads and encodes, so a build can check what it ships. */
export async function verifyNativeImageDecoder(): Promise<void> {
  const { default: sharp } = await imageDecoder();
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "#000000" } })
    .png()
    .toBuffer();
}

/**
 * The bytes each of `count` images may take when every one travels base64
 * encoded (four characters for every three bytes) within `perImage` characters
 * of its own and `total` characters for the whole delivery.
 */
export function nativeImageBase64Budget(input: {
  readonly count: number;
  readonly perImage: number;
  readonly total: number;
}): number {
  const characters = Math.min(input.perImage, Math.floor(input.total / Math.max(1, input.count)));
  return Math.max(0, Math.floor(characters / 4) * 3);
}

/**
 * Whether the stored original can go to the engine as it is. Reads only the
 * image header, so a driver that hands the engine a path does not load bytes
 * it will not send.
 */
export async function nativeImageNeedsPreparation(
  image: ResolvedAttachment,
  limits: NativeImageLimits,
): Promise<boolean> {
  return !fits(image.attachment, await header(image.path), limits);
}

/**
 * The image as the engine should receive it: the verified original when it
 * already fits, otherwise an upright sRGB copy without photo metadata, sized
 * and encoded to fit. Failing to fit is a definite refusal naming the image.
 */
export async function prepareNativeImage(
  image: ResolvedAttachment,
  limits: NativeImageLimits,
): Promise<PreparedNativeImage> {
  const bytes = await readVerifiedAttachmentBytes(image);
  const metadata = await header(bytes);
  if (fits(image.attachment, metadata, limits))
    return { bytes, mediaType: image.attachment.mediaType, transformed: false };

  const { width, height } = metadata.autoOrient;
  const alpha = metadata.hasAlpha === true;
  let scale = Math.min(
    1,
    limits.maxEdge === undefined ? 1 : limits.maxEdge / Math.max(width, height),
    // Copies are 8-bit, with an alpha channel only when the source has one.
    limits.maxDecodedBytes === undefined
      ? 1
      : Math.sqrt(limits.maxDecodedBytes / (width * height * (alpha ? 4 : 3))),
  );
  const encodings = encodingsFor(metadata, alpha, limits.mediaTypes);
  const { default: sharp } = await imageDecoder();
  for (;;) {
    // Flooring keeps each limit an upper bound; the tolerance absorbs float
    // error so a 5712-wide photo scaled to 2000 is 2000, not 1999.
    const targetWidth = Math.max(1, Math.floor(width * scale + 1e-6));
    const targetHeight = Math.max(1, Math.floor(height * scale + 1e-6));
    for (const encoding of encodings) {
      if (Math.max(targetWidth, targetHeight) > encoding.maxEdge) continue;
      const encoded = await encoding
        .encode(
          sharp(bytes, { limitInputPixels: attachmentImageMaxPixels })
            .autoOrient()
            .resize(targetWidth, targetHeight, { fit: "fill" })
            .toColourspace("srgb"),
        )
        .toBuffer();
      if (encoded.byteLength <= limits.maxBytes)
        return { bytes: encoded, mediaType: encoding.mediaType, transformed: true };
    }
    // Smaller than this no longer shows the picture the person attached.
    if (Math.max(targetWidth, targetHeight) <= 256)
      throw new OpensteerError({
        code: "conflict",
        message: `Image ${image.attachment.name} cannot be prepared within the AI engine's ${formatBytes(limits.maxBytes)} image limit`,
      });
    scale *= 0.75;
  }
}

async function header(input: string | Buffer): Promise<Metadata> {
  const { default: sharp } = await imageDecoder();
  // A header read decodes no pixels; the Host has already bounded the size.
  return sharp(input, { limitInputPixels: false }).metadata();
}

function fits(
  attachment: ResolvedAttachment["attachment"],
  metadata: Metadata,
  limits: NativeImageLimits,
): boolean {
  const { width, height } = metadata;
  if (!width || !height) return false;
  const bytesPerSample = metadata.depth === "uchar" || metadata.depth === "char" ? 1 : 2;
  return (
    limits.mediaTypes.includes(attachment.mediaType) &&
    attachment.sizeBytes <= limits.maxBytes &&
    (limits.maxEdge === undefined || Math.max(width, height) <= limits.maxEdge) &&
    (limits.maxDecodedBytes === undefined ||
      width * height * metadata.channels * bytesPerSample <= limits.maxDecodedBytes) &&
    // Engines and providers disagree on EXIF rotation and CMYK, so an image
    // needing either is delivered as the upright sRGB picture the person saw.
    (metadata.orientation === undefined || metadata.orientation === 1) &&
    metadata.space !== "cmyk"
  );
}

interface Encoding {
  readonly mediaType: string;
  /** The longest side the format can hold. */
  readonly maxEdge: number;
  readonly encode: (image: Sharp) => Sharp;
}

/**
 * The encodings to try at one size, best first: lossless PNG keeps
 * screenshots and transparency exact, then one lossy ladder. A translucent
 * image stays translucent (WebP) unless the engine reads neither format.
 */
function encodingsFor(
  metadata: Metadata,
  alpha: boolean,
  accepted: readonly string[],
): readonly Encoding[] {
  const qualities = [90, 80, 70, 60];
  const png: Encoding = {
    mediaType: "image/png",
    maxEdge: 2 ** 31 - 1,
    encode: (image) => image.png(),
  };
  const webp = qualities.map((quality): Encoding => ({
    mediaType: "image/webp",
    maxEdge: 16_383,
    encode: (image) => image.webp({ quality }),
  }));
  const jpeg = qualities.map((quality): Encoding => ({
    mediaType: "image/jpeg",
    // libjpeg-turbo's JPEG_MAX_DIMENSION, below the format's own 65535.
    maxEdge: 65_500,
    // JPEG has no alpha; a translucent source is shown over white.
    encode: (image) => image.flatten({ background: "#ffffff" }).jpeg({ quality }),
  }));
  const usable = (encodings: readonly Encoding[]) =>
    encodings.filter((encoding) => accepted.includes(encoding.mediaType));
  const [preferred, other] = alpha ? [webp, jpeg] : [jpeg, webp];
  const ladder = usable(preferred).length > 0 ? usable(preferred) : usable(other);
  return alpha || metadata.format === "png" || ladder.length === 0
    ? [...usable([png]), ...ladder]
    : ladder;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1_024))} KiB`;
}
