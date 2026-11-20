import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpensteerError, type ToolOutputImageMediaType } from "@opensteer/core";
import {
  homeFilesOutputImageMaxBytes,
  type HomeFileOutputImageExtension,
} from "@opensteer/protocol";
import { noFollowFlag } from "@opensteer/shared/privateFiles";

const outputImageFilenamePattern = /^([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp|avif|svg)$/u;

function detectImageType(
  bytes: Buffer,
): readonly [ToolOutputImageMediaType, readonly HomeFileOutputImageExtension[]] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return ["image/png", ["png"]];
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return ["image/jpeg", ["jpg", "jpeg"]];
  }
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return ["image/gif", ["gif"]];
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return ["image/webp", ["webp"]];
  }
  if (
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
  ) {
    return ["image/avif", ["avif"]];
  }
  if (
    /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(
      bytes.toString("utf8", 0, Math.min(bytes.length, 1024)),
    )
  ) {
    return ["image/svg+xml", ["svg"]];
  }
  return undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function revisionFor(scope: string, sha256Hex: string): string {
  const fileRev = createHash("sha256").update(Buffer.from(sha256Hex, "hex")).digest("base64url");
  return `${scope}.${fileRev}`;
}

/**
 * Host-owned content-addressed store for tool output images published by Runners.
 * Keeps output images readable even when the Runner is offline or on another computer.
 */
export class HostOutputImageStore {
  readonly directory: string;
  readonly scope: string;

  constructor(hostDataDirectory: string) {
    this.directory = join(hostDataDirectory, "output-images");
    this.scope = createHash("sha256")
      .update(JSON.stringify(["host-output-images", this.directory]))
      .digest("base64url");
  }

  async has(sha256: string, extension: HomeFileOutputImageExtension): Promise<boolean> {
    const filename = `${sha256}.${extension}`;
    if (!outputImageFilenamePattern.test(filename)) return false;
    try {
      const handle = await open(
        join(this.directory, filename),
        constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag(),
      );
      try {
        const details = await handle.stat();
        return details.isFile() && details.size > 0;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  async store(input: {
    readonly sha256: string;
    readonly extension: HomeFileOutputImageExtension;
    readonly mediaType: ToolOutputImageMediaType;
    readonly sizeBytes: number;
    readonly stream: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const filename = `${input.sha256}.${input.extension}`;
    if (!outputImageFilenamePattern.test(filename)) {
      throw new OpensteerError({ code: "bad_request", message: "Invalid output image identifier" });
    }
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > homeFilesOutputImageMaxBytes
    ) {
      throw new OpensteerError({ code: "bad_request", message: "Output image size is invalid" });
    }
    const pendingDir = join(this.directory, "pending");
    await mkdir(pendingDir, { recursive: true, mode: 0o700 });
    const temp = join(pendingDir, `${filename}-${randomUUID()}`);
    const final = join(this.directory, filename);
    const handle = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    let total = 0;
    try {
      try {
        for await (const chunk of input.stream) {
          input.signal?.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > input.sizeBytes || total > homeFilesOutputImageMaxBytes) {
            throw new OpensteerError({
              code: "conflict",
              message: "Output image exceeded its declared size",
            });
          }
          hash.update(bytes);
          if (headBytes < 1024) {
            const slice = bytes.subarray(0, 1024 - headBytes);
            headChunks.push(slice);
            headBytes += slice.byteLength;
          }
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
            if (bytesWritten === 0) {
              throw new OpensteerError({ code: "conflict", message: "Output image write stalled" });
            }
            offset += bytesWritten;
          }
        }
        if (total !== input.sizeBytes) {
          throw new OpensteerError({
            code: "conflict",
            message: "Output image size differed from declaration",
          });
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== input.sha256) {
        throw new OpensteerError({ code: "conflict", message: "Output image checksum mismatch" });
      }
      const detected = detectImageType(Buffer.concat(headChunks, headBytes));
      if (!detected || detected[0] !== input.mediaType || !detected[1].includes(input.extension)) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Output image bytes do not match declared image type",
        });
      }
      input.signal?.throwIfAborted();
      try {
        await link(temp, final);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  async stat(
    filename: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly name: string;
    readonly sizeBytes: number;
    readonly modifiedAt: string;
    readonly revision: string;
  } | null> {
    signal?.throwIfAborted();
    const match = outputImageFilenamePattern.exec(filename);
    if (!match) return null;
    try {
      const handle = await open(
        join(this.directory, filename),
        constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag(),
      );
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.size > homeFilesOutputImageMaxBytes) return null;
        return {
          name: filename,
          sizeBytes: details.size,
          modifiedAt: details.mtime.toISOString(),
          revision: revisionFor(this.scope, match[1]!),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  async read(
    filename: string,
    options: {
      readonly maxBytes: number;
      readonly full?: boolean;
      readonly expectedRevision?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly bytes: Buffer;
    readonly metadata: {
      readonly modifiedAt: string;
      readonly revision: string;
      readonly sizeBytes: number;
    };
    readonly eof: boolean;
  }> {
    signal?.throwIfAborted();
    const match = outputImageFilenamePattern.exec(filename);
    if (!match) {
      throw new OpensteerError({ code: "not_found", message: "File unavailable" });
    }
    const sha256 = match[1]!;
    const revision = revisionFor(this.scope, sha256);
    if (options.expectedRevision && options.expectedRevision !== revision) {
      throw new OpensteerError({ code: "not_found", message: "File unavailable" });
    }
    const handle = await open(
      join(this.directory, filename),
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag(),
    ).catch(() => {
      throw new OpensteerError({ code: "not_found", message: "File unavailable" });
    });
    try {
      const details = await handle.stat();
      if (!details.isFile()) {
        throw new OpensteerError({ code: "not_found", message: "File unavailable" });
      }
      if (options.full && details.size > options.maxBytes) {
        throw new OpensteerError({
          code: "resource_exhausted",
          reason: "file-too-large",
          message: `File is ${details.size} bytes; too large to download here (limit ${options.maxBytes} bytes)`,
          details: { sizeBytes: details.size, maxBytes: options.maxBytes },
        });
      }
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let total = 0;
      let kept = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > details.size || (options.full && total > options.maxBytes)) {
          throw new OpensteerError({ code: "not_found", message: "File unavailable" });
        }
        hash.update(bytes);
        if (kept < options.maxBytes) {
          const slice = bytes.subarray(0, options.maxBytes - kept);
          chunks.push(slice);
          kept += slice.byteLength;
        }
      }
      if (total !== details.size || hash.digest("hex") !== sha256) {
        throw new OpensteerError({ code: "not_found", message: "File unavailable" });
      }
      return {
        bytes: Buffer.concat(chunks, kept),
        metadata: {
          modifiedAt: details.mtime.toISOString(),
          revision,
          sizeBytes: details.size,
        },
        eof: kept === details.size,
      };
    } finally {
      await handle.close();
    }
  }
}
