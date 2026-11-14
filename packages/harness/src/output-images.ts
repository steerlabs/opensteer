import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isNetworkPath } from "@opensteer/shared/markdownImages";
import { readBounded } from "@opensteer/shared/privateFiles";
import { join } from "node:path";
import {
  createToolOutput,
  normalizeToolOutput,
  type ToolOutputImage,
  type ToolOutputImageMediaType,
} from "@opensteer/core";

export const toolImageMaxBytes = 10 * 1024 * 1024;
/** Engine-saved files (image generation) may be larger than inline tool images. */
export const savedImageMaxBytes = 32 * 1024 * 1024;
export interface ToolImageStore {
  put(data: string, mediaType: string): ToolOutputImage;
  /** Copy an engine-saved image file in; undefined when it is unreadable, too large or not an image. */
  putFile?(path: string): Promise<ToolOutputImage | undefined>;
  readonly directory?: string;
}

function imageType(bytes: Buffer): [ToolOutputImageMediaType, string] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return ["image/png", "png"];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["image/jpeg", "jpg"];
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return ["image/gif", "gif"];
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return ["image/webp", "webp"];
  if (
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
  )
    return ["image/avif", "avif"];
  if (
    /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(
      bytes.toString("utf8", 0, Math.min(bytes.length, 1024)),
    )
  )
    return ["image/svg+xml", "svg"];
  return undefined;
}

/** Synchronous writes keep provider event ordering intact before any text normalization. */
export function createToolImageStore(
  dataDirectory: string,
  maxBytes = 1024 ** 3,
): ToolImageStore & { prune(): void } {
  const directory = join(dataDirectory, "images");
  // Nothing touches the disk until the first image, so Runner start stays fast.
  let writes = 0;
  const prune = (): void => {
    if (!existsSync(directory)) return;
    const files = readdirSync(directory)
      .filter((name) => /^[a-f0-9]{64}\.(png|jpg|webp|gif|avif|svg)$/.test(name))
      .map((name) => {
        const path = join(directory, name);
        const stat = statSync(path);
        return { path, size: stat.size, time: stat.mtimeMs };
      })
      .sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= maxBytes) break;
      unlinkSync(file.path);
      total -= file.size;
    }
  };
  const save = (bytes: Buffer, type: [ToolOutputImageMediaType, string]): ToolOutputImage => {
    if (writes === 0) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${createHash("sha256").update(bytes).digest("hex")}.${type[1]}`);
    if (!existsSync(path)) {
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      if (writes++ % 16 === 0) prune();
    }
    return { path, mediaType: type[0] };
  };
  return {
    directory,
    prune,
    async putFile(path) {
      if (isNetworkPath(path)) return undefined;
      try {
        // Nonblocking, so a FIFO an engine names cannot stall the Run's events.
        const handle = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > savedImageMaxBytes) return undefined;
          const bytes = await readBounded(handle, savedImageMaxBytes, () => new Error("too large"));
          const type = imageType(bytes);
          return type ? save(bytes, type) : undefined;
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    },
    put(data, mediaType) {
      if (data.length > Math.ceil(toolImageMaxBytes / 3) * 4) throw new Error("too large");
      if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw new Error("invalid encoding");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > toolImageMaxBytes) throw new Error("too large");
      const type = imageType(bytes);
      if (!type || type[0] !== mediaType) throw new Error("invalid image");
      return save(bytes, type);
    },
  };
}

export function extractToolOutputImages(
  value: unknown,
  store: ToolImageStore | undefined,
): { value: unknown; images: ToolOutputImage[] } {
  const images: ToolOutputImage[] = [];
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const block = value as Record<string, unknown>;
    const source =
      block.source && typeof block.source === "object"
        ? (block.source as Record<string, unknown>)
        : block;
    const mediaType = source.media_type ?? source.mimeType ?? source.mime ?? block.mediaType;
    const url = typeof block.url === "string" ? block.url : undefined;
    const image =
      block.type === "image" ||
      ((block.type === "file" || block.type === "attachment") &&
        ((typeof mediaType === "string" && mediaType.startsWith("image/")) ||
          url?.startsWith("data:image/")));
    if (image) {
      let data = source.data;
      let mime = mediaType;
      if (url?.startsWith("data:")) {
        const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
        mime = match?.[1];
        data = match?.[2];
      }
      let marker = "[image]";
      try {
        if (images.length >= 8) throw new Error("limit reached");
        if (!store || typeof data !== "string" || typeof mime !== "string")
          throw new Error("unavailable");
        images.push(store.put(data, mime));
      } catch (error) {
        const reason =
          error instanceof Error &&
          ["too large", "invalid encoding", "invalid image", "limit reached"].includes(
            error.message,
          )
            ? error.message
            : "unavailable";
        marker = `[image omitted: ${reason}]`;
      }
      return { type: "text", text: marker };
    }
    return Object.fromEntries(Object.entries(block).map(([key, child]) => [key, visit(child)]));
  }
  return { value: visit(value), images };
}

export function toolOutputWithImages(
  value: unknown,
  store: ToolImageStore | undefined,
  supplemental?: unknown,
) {
  const extracted = extractToolOutputImages(value, store);
  if (supplemental !== undefined) {
    const extra = extractToolOutputImages(supplemental, store);
    for (const image of extra.images)
      if (
        extracted.images.length < 8 &&
        !extracted.images.some((existing) => existing.path === image.path)
      )
        extracted.images.push(image);
  }
  const normalized = normalizeToolOutput(extracted.value);
  return {
    ...createToolOutput(normalized.text, extracted.images),
    ...(normalized.truncation ? { truncation: normalized.truncation } : {}),
  };
}
