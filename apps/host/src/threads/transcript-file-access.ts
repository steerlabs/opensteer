import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpensteerError,
  attachmentMaxBytes,
  type ExecutionNodeId,
  type ThreadId,
  type ToolOutputImage,
  type UserId,
} from "@opensteer/core";
import {
  type FileResource,
  type FileSource,
  transcriptFileContentMaxBytes,
} from "@opensteer/protocol";
import { isNetworkPath } from "@opensteer/shared/fileHref";
import type { AttachmentService } from "../attachments/attachment-service.js";
import type { AgentHomeFiles } from "./agent-home-files.js";
import type { HostOutputImageStore } from "./host-output-images.js";
import {
  fileTooLarge,
  fileUnavailable,
  rootedFileKey,
  rootedFileSegments,
} from "./rooted-file-reader.js";

export type FileActor = { userId: UserId; sessionId: string };
export type FileContext = { userId: UserId; threadId: ThreadId | null };
export type ResolvedTranscriptFile = {
  resource: FileResource;
  name: string;
  sizeBytes: number;
  mediaType: string;
};
type OutputImage = Pick<ToolOutputImage, "path" | "mediaType"> & { id: string };

const outputImageFilenamePattern = /^[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|avif|svg)$/u;
const types: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};
export const transcriptMediaType = (name: string) =>
  types[path.extname(name).toLowerCase()] ?? "application/octet-stream";

function privateReadError(error: unknown, signal?: AbortSignal): never {
  signal?.throwIfAborted();
  if (error instanceof OpensteerError && error.code === "resource_exhausted") throw error;
  throw fileUnavailable();
}

function remoteBasename(filePath: string): string {
  const parts = filePath.split(/[/\\]/u);
  return parts.at(-1) ?? "";
}

function isAbsoluteAnyPlatform(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(filePath);
}

/** Sole admission policy for personal transcript files and media. Locators confer no authority. */
export class TranscriptFileAccess {
  readonly options: {
    home: AgentHomeFiles;
    attachments: AttachmentService;
    outputImageStore: HostOutputImageStore;
    admit: (context: FileContext) => Promise<boolean>;
    outputImages: (input: {
      ownerId: UserId;
      threadId: ThreadId;
      paths: readonly string[];
    }) => Promise<readonly OutputImage[]>;
    outputImage: (input: {
      ownerId: UserId;
      threadId: ThreadId;
      imageId: string;
      nodeId?: ExecutionNodeId;
    }) => Promise<OutputImage | null>;
  };
  constructor(options: TranscriptFileAccess["options"]) {
    this.options = options;
  }

  async admit(context: FileContext) {
    try {
      if (!(await this.options.admit(context))) throw fileUnavailable();
    } catch (e) {
      if (e instanceof OpensteerError && ["forbidden", "not_found"].includes(e.code))
        throw fileUnavailable();
      throw e;
    }
  }

  /** Validates syntax and decodes legacy `file://` URLs without expanding `~/` on the Host. */
  async normalizeImageSource(source: FileSource): Promise<FileSource> {
    if (source.kind !== "path") return source;
    let value = source.path;
    if (/^file:/iu.test(value)) {
      if (
        value
          .replace(/%2e/giu, ".")
          .split(/[/\\]/u)
          .some((p) => p === "." || p === "..")
      )
        throw fileUnavailable();
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        (url.hostname && url.hostname !== "localhost")
      )
        throw fileUnavailable();
      // fileURLToPath is the only decoding boundary, for legacy image URLs only.
      value = fileURLToPath(url, { windows: /^\/[A-Za-z]:\//u.test(url.pathname) });
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[/\\]/iu.test(value))
      throw fileUnavailable();
    if (
      /\p{Cc}/u.test(value) ||
      isNetworkPath(value) ||
      value.split(/[/\\]/u).some((p) => p === "..")
    )
      throw fileUnavailable();
    // Preserve `~/` and relative paths so the hosting Runner expands them against its own home.
    return { kind: "path", path: value };
  }

  async resolveMany(sources: readonly FileSource[], context: FileContext, signal?: AbortSignal) {
    await this.admit(context);
    signal?.throwIfAborted();
    const candidateImagePaths = sources.flatMap((s) => {
      if (s.kind !== "path" || !isAbsoluteAnyPlatform(s.path)) return [];
      const name = remoteBasename(s.path);
      return outputImageFilenamePattern.test(name) ? [s.path] : [];
    });
    const images =
      context.threadId && candidateImagePaths.length
        ? await this.options.outputImages({
            ownerId: context.userId,
            threadId: context.threadId,
            paths: [...new Set(candidateImagePaths)],
          })
        : [];
    return Promise.all(sources.map((s) => this.#resolve(s, context, images, signal)));
  }

  async resolve(source: FileSource, context: FileContext, signal?: AbortSignal) {
    return (await this.resolveMany([source], context, signal))[0] ?? null;
  }

  async #resolve(
    source: FileSource,
    context: FileContext,
    images: readonly OutputImage[],
    signal?: AbortSignal,
  ): Promise<ResolvedTranscriptFile | null> {
    try {
      signal?.throwIfAborted();
      if (source.kind === "attachment") {
        const a = await this.options.attachments.get(source.attachmentId, context.userId);
        if (
          a.state !== "ready" ||
          !a.sha256 ||
          (!a.messageId && new Date(a.expiresAt).getTime() <= Date.now())
        )
          return null;
        return {
          resource: { kind: "attachment", attachmentId: a.id, revision: a.sha256 },
          name: a.name,
          sizeBytes: a.sizeBytes,
          mediaType: a.mediaType,
        };
      }
      if (source.kind === "transcript-image") {
        if (!context.threadId) return null;
        const image = await this.options.outputImage({
          ownerId: context.userId,
          threadId: context.threadId,
          imageId: source.imageId,
          ...(source.nodeId ? { nodeId: source.nodeId } : {}),
        });
        return image ? await this.#resolveImage(image, source.nodeId, signal) : null;
      }
      if (context.threadId) {
        const image = images.find((i) => i.path === source.path);
        if (image) return await this.#resolveImage(image, undefined, signal);
      }
      const f = await this.options.home.resolvePath(
        source.path,
        { allowRelative: true, allowTilde: true },
        signal,
      );
      return {
        resource: { kind: "home", key: f.key, revision: f.revision },
        name: f.name,
        sizeBytes: f.sizeBytes,
        mediaType: transcriptMediaType(f.name),
      };
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof OpensteerError) return null;
      throw e;
    }
  }

  async #resolveImage(
    image: OutputImage,
    nodeId: ExecutionNodeId | undefined,
    signal?: AbortSignal,
  ): Promise<ResolvedTranscriptFile> {
    const name = remoteBasename(image.path);
    if (outputImageFilenamePattern.test(name)) {
      const hostStored = await this.options.outputImageStore.stat(name, signal);
      if (hostStored) {
        return {
          name: hostStored.name,
          sizeBytes: hostStored.sizeBytes,
          resource: {
            kind: "output-image" as const,
            imageId: image.id,
            ...(nodeId ? { nodeId } : {}),
            revision: hostStored.revision,
          },
          mediaType: image.mediaType,
        };
      }
      // Legacy output image recorded before Host-owned publishing: fetch through the hosting Runner.
      const key = rootedFileKey([Buffer.from(name).toString("base64url")]);
      const probe = await this.options.home.read(
        key,
        { maxBytes: 1, root: "output-images" },
        signal,
      );
      return {
        name,
        sizeBytes: probe.metadata.sizeBytes,
        resource: {
          kind: "output-image" as const,
          imageId: image.id,
          ...(nodeId ? { nodeId } : {}),
          revision: probe.metadata.revision,
        },
        mediaType: image.mediaType,
      };
    }
    const f = await this.options.home.resolveAbsolutePath(image.path, signal);
    return {
      name: f.name,
      sizeBytes: f.sizeBytes,
      resource: {
        kind: "output-image" as const,
        imageId: image.id,
        ...(nodeId ? { nodeId } : {}),
        revision: f.revision,
      },
      mediaType: image.mediaType,
    };
  }

  async read(
    resource: FileResource,
    context: FileContext,
    options: { maxBytes: number; full?: boolean },
    signal?: AbortSignal,
  ) {
    await this.admit(context);
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > transcriptFileContentMaxBytes
    )
      throw fileUnavailable();
    if (resource.kind === "attachment") {
      try {
        const a = await this.options.attachments.get(resource.attachmentId, context.userId);
        if (a.state !== "ready" || a.sha256 !== resource.revision) throw fileUnavailable();
        const cap = Math.min(options.maxBytes, attachmentMaxBytes);
        if (options.full && a.sizeBytes > cap) throw fileTooLarge(a.sizeBytes, cap);
        const result = options.full
          ? await this.options.attachments.contentForUser(a.id, context.userId, signal)
          : await this.options.attachments.previewForUser(a.id, context.userId, cap, signal);
        if (result.metadata.etag !== `"sha256-${resource.revision}"`) throw fileUnavailable();
        return {
          ...result,
          bytes: Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes),
          name: a.name,
          mediaType: a.mediaType,
        };
      } catch (e) {
        privateReadError(e, signal);
      }
    }
    if (resource.kind === "home") {
      const key = resource.key;
      let name: string;
      try {
        name = Buffer.from(rootedFileSegments(key).at(-1)!, "base64url").toString();
      } catch {
        throw fileUnavailable();
      }
      const mediaType = transcriptMediaType(name);
      try {
        const result = options.full
          ? await this.options.home.readContent(
              key,
              { expectedRevision: resource.revision, maxBytes: options.maxBytes },
              signal,
            )
          : await this.options.home.read(
              key,
              {
                expectedRevision: resource.revision,
                maxBytes: Math.min(options.maxBytes, 512 * 1024),
              },
              signal,
            );
        return {
          bytes: result.bytes,
          name,
          mediaType,
          metadata: {
            contentType: mediaType,
            etag: `"${resource.revision}"`,
            modifiedAt: result.metadata.modifiedAt,
            sizeBytes: result.metadata.sizeBytes,
            truncated: !result.eof,
          },
        };
      } catch (e) {
        privateReadError(e, signal);
      }
    }
    if (!context.threadId) throw fileUnavailable();
    const image = await this.options.outputImage({
      ownerId: context.userId,
      threadId: context.threadId,
      imageId: resource.imageId,
      ...(resource.nodeId ? { nodeId: resource.nodeId } : {}),
    });
    if (!image) throw fileUnavailable();
    const name = remoteBasename(image.path);
    const mediaType = image.mediaType;
    try {
      if (
        outputImageFilenamePattern.test(name) &&
        resource.revision.startsWith(`${this.options.outputImageStore.scope}.`)
      ) {
        const result = await this.options.outputImageStore.read(
          name,
          {
            expectedRevision: resource.revision,
            ...(options.full ? { full: true } : {}),
            maxBytes: options.full ? options.maxBytes : Math.min(options.maxBytes, 512 * 1024),
          },
          signal,
        );
        return {
          bytes: result.bytes,
          name,
          mediaType,
          metadata: {
            contentType: mediaType,
            etag: `"${resource.revision}"`,
            modifiedAt: result.metadata.modifiedAt,
            sizeBytes: result.metadata.sizeBytes,
            truncated: !result.eof,
          },
        };
      }
      const isManagedImage = outputImageFilenamePattern.test(name);
      const key = isManagedImage
        ? rootedFileKey([Buffer.from(name).toString("base64url")])
        : (await this.options.home.resolveAbsolutePath(image.path, signal)).key;
      const root = isManagedImage ? ("output-images" as const) : ("agent-home" as const);
      const result = options.full
        ? await this.options.home.readContent(
            key,
            { expectedRevision: resource.revision, maxBytes: options.maxBytes, root },
            signal,
          )
        : await this.options.home.read(
            key,
            {
              expectedRevision: resource.revision,
              maxBytes: Math.min(options.maxBytes, 512 * 1024),
              root,
            },
            signal,
          );
      if (
        isManagedImage &&
        options.full &&
        createHash("sha256").update(result.bytes).digest("hex") !== name.split(".")[0]
      )
        throw fileUnavailable();
      return {
        bytes: result.bytes,
        name,
        mediaType,
        metadata: {
          contentType: mediaType,
          etag: `"${resource.revision}"`,
          modifiedAt: result.metadata.modifiedAt,
          sizeBytes: result.metadata.sizeBytes,
          truncated: !result.eof,
        },
      };
    } catch (e) {
      privateReadError(e, signal);
    }
  }

  close() {}
}
