import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentIdSchema,
  AttachmentSchema,
  ReadyAttachmentSchema,
  attachmentImageMaxPixels,
  attachmentMaxBytes,
  attachmentNativeImageMediaTypes,
  attachmentUploadLifetimeMs,
  OpensteerError,
  type Attachment,
  type ReadyAttachment,
  type UserId,
} from "@opensteer/core";
import { AttachmentStore, type AttachmentRow } from "@opensteer/database";
import sharp from "sharp";
import { RunCapabilityTokenService } from "../agents/run-capability.js";

export class RunAttachmentsTokenService extends RunCapabilityTokenService<"opensteer-run-attachments"> {
  constructor(options: {
    readonly authorizer: ConstructorParameters<typeof RunCapabilityTokenService>[0]["authorizer"];
    readonly lifetimeSeconds?: number;
    readonly tokens: ConstructorParameters<typeof RunCapabilityTokenService>[0]["tokens"];
  }) {
    super({ ...options, audience: "opensteer-run-attachments" });
  }
}

function attachmentView(row: AttachmentRow): Attachment {
  return AttachmentSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    uploaderId: row.uploaderId,
    name: row.name,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    kind: row.kind,
    width: row.width,
    height: row.height,
    state: row.state,
    messageId: row.messageId,
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

function readyView(row: AttachmentRow): ReadyAttachment {
  return ReadyAttachmentSchema.parse(attachmentView(row));
}

function unavailable(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "Attachment bytes are unavailable or damaged",
  });
}

/** Canonical originals live on the Host data volume and never use user filenames as paths. */
export class AttachmentService {
  readonly #directory: string;
  readonly #store: AttachmentStore;
  readonly #runTokens: RunAttachmentsTokenService;

  constructor(input: {
    readonly dataDirectory: string;
    readonly store: AttachmentStore;
    readonly runTokens: RunAttachmentsTokenService;
  }) {
    this.#directory = join(input.dataDirectory, "attachments");
    this.#store = input.store;
    this.#runTokens = input.runTokens;
  }

  async reserve(input: Parameters<AttachmentStore["reserve"]>[0]): Promise<Attachment> {
    // Refused before any bytes move: no upload of this type could be accepted.
    if (input.mediaType.startsWith("image/") && !isNativeImageMediaType(input.mediaType))
      throw unsupportedImageType(input.mediaType);
    return attachmentView(await this.#store.reserve(input));
  }

  async get(attachmentId: string, userId: UserId): Promise<Attachment> {
    return attachmentView(
      await this.#store.getForUser(AttachmentIdSchema.parse(attachmentId), userId),
    );
  }

  async upload(input: {
    readonly attachmentId: string;
    readonly userId: UserId;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<Attachment> {
    const id = AttachmentIdSchema.parse(input.attachmentId);
    const row = await this.#store.getForUser(id, input.userId);
    if (row.uploaderId !== input.userId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the uploader can complete this attachment",
      });
    if (row.state === "deleting" || row.messageId)
      throw new OpensteerError({ code: "conflict", message: "Upload is no longer active" });
    await mkdir(join(this.#directory, "originals"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#directory, "pending"), { recursive: true, mode: 0o700 });
    const temp = join(this.#directory, "pending", `${id}-${randomUUID()}`);
    const final = this.#path(id);
    const file = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      try {
        for await (const chunk of input.body) {
          if (input.signal?.aborted)
            throw new OpensteerError({ code: "conflict", message: "Upload was interrupted" });
          size += chunk.byteLength;
          if (size > row.sizeBytes || size > attachmentMaxBytes)
            throw new OpensteerError({
              code: "conflict",
              message: "Upload size differs from reservation",
            });
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
            if (bytesWritten === 0) throw unavailable();
            offset += bytesWritten;
          }
        }
        if (size !== row.sizeBytes)
          throw new OpensteerError({
            code: "conflict",
            message: "Upload size differs from reservation",
          });
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hash.digest("hex");
      const decoded = await inspectImage(temp, row.mediaType);
      const completed = await this.#store.complete({
        attachmentId: id,
        uploaderId: input.userId,
        sha256,
        kind: decoded.kind,
        width: decoded.width,
        height: decoded.height,
        install: async () => {
          try {
            await link(temp, final);
          } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            // A row still marked uploading can only have an orphan from a
            // crashed/rolled-back finalization. The row lock keeps this safe.
            await unlink(final);
            await link(temp, final);
          }
          const originals = await open(join(this.#directory, "originals"), "r");
          try {
            await originals.sync();
          } finally {
            await originals.close();
          }
        },
      });
      await this.#verifiedContent(completed);
      return attachmentView(completed);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async discard(attachmentId: string, userId: UserId): Promise<void> {
    const id = AttachmentIdSchema.parse(attachmentId);
    await this.#store.discard({ attachmentId: id, uploaderId: userId });
    await rm(this.#path(id), { force: true });
    await this.#store.removeDeleting(id);
  }

  async recoverDeleting(): Promise<void> {
    for (;;) {
      const rows = await this.#store.listDeleting(100);
      if (rows.length === 0) break;
      for (const row of rows) {
        await rm(this.#path(row.id), { force: true });
        await this.#store.removeDeleting(row.id);
      }
    }
  }

  async collectGarbage(): Promise<void> {
    await this.#store.expireUnbound(100);
    await this.recoverDeleting();
    const pending = join(this.#directory, "pending");
    await mkdir(pending, { recursive: true, mode: 0o700 });
    for (const name of await readdir(pending)) {
      if (!/^att_[0-9a-f-]{36}-[0-9a-f-]{36}$/u.test(name)) continue;
      const path = join(pending, name);
      const file = await stat(path).catch(() => null);
      if (file?.isFile() && Date.now() - file.mtimeMs > attachmentUploadLifetimeMs) {
        await rm(path, { force: true });
      }
    }
    const originals = join(this.#directory, "originals");
    await mkdir(originals, { recursive: true, mode: 0o700 });
    for (const name of await readdir(originals)) {
      if (!AttachmentIdSchema.safeParse(name).success) continue;
      const path = join(originals, name);
      const file = await stat(path).catch(() => null);
      if (!file?.isFile() || Date.now() - file.mtimeMs <= attachmentUploadLifetimeMs) continue;
      if (!(await this.#store.get(name))) await rm(path, { force: true });
    }
  }

  async contentForUser(
    attachmentId: string,
    userId: UserId,
  ): Promise<{ readonly bytes: Uint8Array; readonly metadata: ContentMetadata }> {
    const row = await this.#store.getForUser(AttachmentIdSchema.parse(attachmentId), userId);
    return this.#verifiedContent(row);
  }

  async listForRun(
    token: string,
    after: string | null,
  ): Promise<{
    readonly attachments: readonly ReadyAttachment[];
    readonly nextCursor: string | null;
  }> {
    const claims = await this.#runTokens.authenticate(token);
    const rows = await this.#store.listForRun({
      after,
      limit: 100,
      runId: claims.runId,
      threadId: claims.threadId,
    });
    return {
      attachments: rows.map(readyView),
      nextCursor: rows.length === 100 ? rows[99]!.id : null,
    };
  }

  async contentForRun(
    token: string,
    attachmentId: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly metadata: ContentMetadata }> {
    const claims = await this.#runTokens.authenticate(token);
    const row = await this.#store.getForRun({
      attachmentId: AttachmentIdSchema.parse(attachmentId),
      runId: claims.runId,
      threadId: claims.threadId,
    });
    return this.#verifiedContent(row);
  }

  async #verifiedContent(
    row: AttachmentRow,
  ): Promise<{ readonly bytes: Uint8Array; readonly metadata: ContentMetadata }> {
    if (row.state !== "ready" || !row.sha256) throw unavailable();
    let bytes: Buffer;
    try {
      const info = await stat(this.#path(row.id));
      if (!info.isFile() || info.size !== row.sizeBytes) throw unavailable();
      bytes = await readFile(this.#path(row.id));
    } catch {
      throw unavailable();
    }
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw unavailable();
    return {
      bytes,
      metadata: {
        contentType: row.mediaType,
        etag: `"sha256-${row.sha256}"`,
        modifiedAt: row.createdAt.toISOString(),
        sizeBytes: row.sizeBytes,
        truncated: false,
      },
    };
  }

  #path(id: string): string {
    return join(this.#directory, "originals", AttachmentIdSchema.parse(id));
  }
}

type ContentMetadata = {
  readonly contentType: string;
  readonly etag: string;
  readonly modifiedAt: string;
  readonly sizeBytes: number;
  readonly truncated: false;
};

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNativeImageMediaType(mediaType: string): boolean {
  return (attachmentNativeImageMediaTypes as readonly string[]).includes(mediaType);
}

function unsupportedImageType(mediaType: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: `This image type (${mediaType}) is not supported. Use PNG, JPEG, or WebP.`,
  });
}

function damagedImage(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "This image could not be read. It may be damaged or incomplete.",
  });
}

/**
 * Checks an uploaded image from its header outward, so an oversized or
 * mislabeled file is refused before any pixel is decoded, and a file that
 * passes is proven to decode completely.
 */
async function inspectImage(
  path: string,
  mediaType: string,
): Promise<{
  readonly kind: "image" | "file";
  readonly width: number | null;
  readonly height: number | null;
}> {
  if (!mediaType.startsWith("image/")) return { kind: "file", width: null, height: null };
  if (!isNativeImageMediaType(mediaType)) throw unsupportedImageType(mediaType);
  // A header read decodes no pixels; sharp's own default pixel limit would
  // otherwise report an oversized image as unreadable instead of oversized.
  const metadata = await sharp(path, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw damagedImage();
    });
  const contained =
    metadata.format === "jpeg"
      ? "image/jpeg"
      : metadata.format === "svg"
        ? "image/svg+xml"
        : `image/${metadata.format}`;
  if (contained !== mediaType)
    throw new OpensteerError({
      code: "conflict",
      message: `This file is labeled ${mediaType} but contains ${contained} data.`,
    });
  if ((metadata.pages ?? 1) > 1 || (mediaType === "image/png" && (await pngIsAnimated(path))))
    throw new OpensteerError({
      code: "conflict",
      message: "Animated images are not supported. Use a single-frame PNG, JPEG, or WebP.",
    });
  // The upright size is what every viewer and engine sees.
  const { width, height } = metadata.autoOrient;
  if (!width || !height) throw damagedImage();
  if (width * height > attachmentImageMaxPixels)
    throw new OpensteerError({
      code: "conflict",
      message: `This image is ${width}×${height} (${((width * height) / 1_000_000).toFixed(1)} MP). The limit is ${attachmentImageMaxPixels / 1_000_000} MP.`,
    });
  try {
    await sharp(path, { failOn: "error", limitInputPixels: attachmentImageMaxPixels })
      .resize(1, 1)
      .toBuffer();
  } catch {
    throw damagedImage();
  }
  return { kind: "image", width, height };
}

/**
 * Whether a PNG announces animation. APNG adds an `acTL` chunk before the first
 * `IDAT`; decoders without APNG support show only the first frame, which would
 * hand an engine a different picture than the one the person chose.
 */
async function pngIsAnimated(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const size = (await file.stat()).size;
    for (let offset = 8; offset + 8 <= size;) {
      const { bytesRead } = await file.read(header, 0, 8, offset);
      if (bytesRead !== 8) return false;
      const type = header.toString("latin1", 4, 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      offset += 12 + header.readUInt32BE(0);
    }
    return false;
  } finally {
    await file.close();
  }
}
