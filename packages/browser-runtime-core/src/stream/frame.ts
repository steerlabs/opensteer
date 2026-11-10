import { encodeFrameEnvelope, decodeFrameEnvelope } from "@opensteer/browser-core/bytes";
import {
  BrowserBinaryFrameHeaderSchema,
  type BrowserBinaryFrameHeader,
} from "@opensteer/protocol/browser";
import { BrowserRuntimeError } from "../errors.js";

export interface BrowserFrame {
  data: Buffer;
  header: BrowserBinaryFrameHeader;
}

export function encodeBrowserFrame(frame: BrowserFrame): Buffer {
  const encoded = encodeFrameEnvelope(
    BrowserBinaryFrameHeaderSchema.parse(frame.header),
    frame.data,
  );
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

export function decodeBrowserFrame(envelope: Buffer): BrowserFrame {
  try {
    const decoded = decodeFrameEnvelope(envelope);
    return {
      data: Buffer.from(
        decoded.payload.buffer,
        decoded.payload.byteOffset,
        decoded.payload.byteLength,
      ),
      header: BrowserBinaryFrameHeaderSchema.parse(decoded.header),
    };
  } catch (error) {
    throw new BrowserRuntimeError("bad_message", "The binary browser frame is invalid.", {
      cause: error,
    });
  }
}

export function readImageDimensions(
  data: Buffer,
  encoding: BrowserBinaryFrameHeader["encoding"],
): { height: number; width: number } | null {
  if (encoding === "png") return readPngDimensions(data);
  if (encoding === "jpeg") return readJpegDimensions(data);
  return null;
}

/**
 * A picture of a page of this size, to within a pixel, in any raster. Scaling
 * rounds each side of a true picture by under a raster pixel, which moves this
 * product by at most the sum of the page's sides; a picture of a page one CSS
 * pixel off on each side moves it by at most the sum of the raster's.
 */
export function rasterShowsSize(
  raster: { readonly height: number; readonly width: number },
  page: { readonly height: number; readonly width: number },
): boolean {
  return (
    Math.abs(raster.width * page.height - raster.height * page.width) <=
    page.width + page.height + raster.width + raster.height
  );
}

function readPngDimensions(data: Buffer): { height: number; width: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.byteLength < 24 || !data.subarray(0, 8).equals(signature)) return null;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return validDimensions(width, height) ? { height, width } : null;
}

function readJpegDimensions(data: Buffer): { height: number; width: number } | null {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= data.byteLength) {
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.byteLength) return null;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.byteLength) return null;
    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return validDimensions(width, height) ? { height, width } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 32_768 && height <= 32_768;
}
