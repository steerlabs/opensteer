import {
  attachmentImageMaxPixels,
  attachmentMaxBytes,
  detectImageMediaType,
} from "@opensteer/core";
import { formatBytes } from "../../app-model.js";

/** A chosen file as it will be reserved: named by its contents, HEIC as JPEG. */
export interface UploadFile {
  readonly file: Blob;
  readonly mediaType: string;
  readonly name: string;
}

/** A file that cannot become an upload, with the reason to show the person. */
export class UploadPreparationError extends Error {}

/**
 * Names a chosen file by its bytes and turns HEIC photos into JPEG.
 *
 * Browsers label files by name or not at all (Finder drags HEIC with an empty
 * type), and the Host refuses a label its bytes contradict. HEIC, which iPhones
 * save and no engine reads, is decoded in the page at full resolution; the
 * decoder is loaded only when such a photo arrives.
 */
export async function prepareUploadFile(
  file: Blob,
  name: string,
  declaredType: string,
): Promise<UploadFile> {
  const detected = detectImageMediaType(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  if (detected === "image/heic" || detected === "image/heif")
    return oneAtATime(() => convertHeic(file, name));
  // Named or typed as HEIC but not HEIC inside: say so, rather than let the
  // Host refuse a format the person never really had.
  if (!detected && (/^image\/hei[cf]$/iu.test(declaredType) || /\.hei[cf]$/iu.test(name)))
    throw heicUnreadable(name);
  return { file, mediaType: detected ?? declaredType, name };
}

function heicUnreadable(name: string): UploadPreparationError {
  return new UploadPreparationError(
    `${name} could not be converted from HEIC. Export it as JPEG and attach that instead.`,
  );
}

let converting: Promise<unknown> = Promise.resolve();

/** Decoding holds a whole photo in memory, so photos convert one after another. */
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = converting.then(task, task);
  converting = run.catch(() => undefined);
  return run;
}

async function convertHeic(file: Blob, name: string): Promise<UploadFile> {
  const unreadable = heicUnreadable(name);
  const oversized = (width: number, height: number) =>
    new UploadPreparationError(
      `${name} is ${width}×${height} (${((width * height) / 1_000_000).toFixed(1)} MP). The limit is ${attachmentImageMaxPixels / 1_000_000} MP.`,
    );
  // The size comes from the header, so an oversized photo is refused before
  // the decoder allocates it.
  const size = await heicImageSize(file);
  if (!size) throw unreadable;
  if (size.width * size.height > attachmentImageMaxPixels) throw oversized(size.width, size.height);
  let bitmap: ImageBitmap;
  try {
    const { heicTo } = await import("heic-to/csp");
    bitmap = await heicTo({ blob: file, type: "bitmap" });
  } catch {
    throw unreadable;
  }
  const canvas = document.createElement("canvas");
  try {
    // The decoder is the final word on size; no canvas is sized past the limit.
    if (bitmap.width * bitmap.height > attachmentImageMaxPixels)
      throw oversized(bitmap.width, bitmap.height);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw unreadable;
    context.drawImage(bitmap, 0, 0);
    for (const quality of [0.92, 0.85, 0.78, 0.7]) {
      const jpeg = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (!jpeg) throw unreadable;
      if (jpeg.size <= attachmentMaxBytes)
        return {
          file: jpeg,
          mediaType: "image/jpeg",
          name: `${name.replace(/\.(?:heic|heif)$/iu, "")}.jpg`,
        };
    }
    throw new UploadPreparationError(
      `${name} is larger than ${formatBytes(attachmentMaxBytes)} even as a JPEG.`,
    );
  } finally {
    bitmap.close();
    // Releases the canvas backing store now rather than at collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** A `meta` box holds item and property tables, never image data. */
const heicMetaMaxBytes = 16 * 1_024 * 1_024;

/**
 * The largest image an HEIF file declares, from every `ispe` property under
 * `meta` → `iprp` → `ipco`. A photo stored as a grid of tiles declares both the
 * tiles and the whole picture; the whole picture is the largest. Top-level
 * boxes are walked by their headers alone, so an `mdat` ahead of `meta` is
 * never read, and any box that overruns its parent makes the file unreadable.
 */
async function heicImageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  for (let offset = 0; offset < file.size;) {
    const header = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    const top = boxAt(header, 0, file.size - offset);
    if (!top) return null;
    if (top.type === "meta") {
      if (top.end > heicMetaMaxBytes) return null;
      const meta = new DataView(await file.slice(offset, offset + top.end).arrayBuffer());
      // `meta` is a full box: four bytes of version and flags precede its children.
      const properties = children(meta, top.start + 4, top.end)?.find(
        (child) => child.type === "iprp",
      );
      const container =
        properties &&
        children(meta, properties.start, properties.end)?.find((child) => child.type === "ipco");
      const items = container && children(meta, container.start, container.end);
      if (!items) return null;
      let largest: { width: number; height: number } | null = null;
      for (const item of items) {
        if (item.type !== "ispe") continue;
        // `ispe` is a full box: version and flags, then width and height.
        if (item.end - item.start < 12) return null;
        const width = meta.getUint32(item.start + 4);
        const height = meta.getUint32(item.start + 8);
        if (width === 0 || height === 0) return null;
        if (!largest || width * height > largest.width * largest.height)
          largest = { width, height };
      }
      return largest;
    }
    offset += top.end;
  }
  return null;
}

interface IsoBox {
  readonly type: string;
  /** Where the payload starts and where the box ends, relative to the view. */
  readonly start: number;
  readonly end: number;
}

/** Every box between `start` and `end`, or null when one overruns them. */
function children(view: DataView, start: number, end: number): IsoBox[] | null {
  const boxes: IsoBox[] = [];
  for (let offset = start; offset < end;) {
    const box = boxAt(view, offset, end);
    if (!box) return null;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

/** The ISO base media box whose header is at `offset`; it must end by `end`. */
function boxAt(view: DataView, offset: number, end: number): IsoBox | null {
  if (offset + 8 > view.byteLength) return null;
  let size = view.getUint32(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > view.byteLength) return null;
    const large = view.getBigUint64(offset + 8);
    if (large > BigInt(end - offset)) return null;
    size = Number(large);
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || offset + size > end) return null;
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  return { type, start: offset + header, end: offset + size };
}
