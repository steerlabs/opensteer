import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { isNetworkPath } from "@opensteer/shared/fileHref";
import { fileURLToPath } from "node:url";
import {
  OpensteerError,
  attachmentMaxBytes,
  type Sequence,
  type ThreadId,
  type UserId,
  type ToolOutputImage,
} from "@opensteer/core";
import {
  type FileResource,
  type FileSource,
  transcriptFileContentMaxBytes,
} from "@opensteer/protocol";
import type { AttachmentService } from "../attachments/attachment-service.js";
import type { AgentHomeFiles } from "./agent-home-files.js";
import {
  RootedFileReader,
  absoluteFileKey,
  fileUnavailable,
  fileTooLarge,
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
type OutputImage = ToolOutputImage & { sequence: Sequence; index: number };
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

/** Sole admission policy for personal transcript files and media. Locators confer no authority. */
export class TranscriptFileAccess {
  readonly #images: RootedFileReader;
  readonly options: {
    home: AgentHomeFiles;
    attachments: AttachmentService;
    imagesRoot: string;
    helperPath: string | undefined;
    admit: (context: FileContext) => Promise<boolean>;
    outputImages: (input: {
      ownerId: UserId;
      threadId: ThreadId;
      paths: readonly string[];
    }) => Promise<readonly OutputImage[]>;
    outputImage: (input: {
      ownerId: UserId;
      threadId: ThreadId;
      sequence: Sequence;
      index: number;
    }) => Promise<ToolOutputImage | null>;
    homeDirectory?: string;
  };
  constructor(options: TranscriptFileAccess["options"]) {
    this.options = options;
    this.#images = new RootedFileReader({
      root: async () => options.imagesRoot,
      helperPath: options.helperPath,
    });
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
      value = fileURLToPath(url);
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[/\\]/iu.test(value))
      throw fileUnavailable();
    if (
      /\p{Cc}/u.test(value) ||
      (process.platform !== "win32" && value.includes("\\")) ||
      isNetworkPath(value) ||
      value.split(/[/\\]/u).some((p) => p === "..")
    )
      throw fileUnavailable();
    if (value.startsWith("~/"))
      value = path.join(this.options.homeDirectory ?? homedir(), value.slice(2));
    else if (!path.isAbsolute(value))
      value = path.join((await this.options.home.options.agentHome()).path, value);
    return { kind: "path", path: path.normalize(value) };
  }
  #managedKey(file: string) {
    const key = absoluteFileKey(this.options.imagesRoot, file);
    if (
      path.dirname(file) !== this.options.imagesRoot ||
      !/^[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|avif|svg)$/u.test(path.basename(file))
    )
      throw fileUnavailable();
    return key;
  }
  async resolveMany(sources: readonly FileSource[], context: FileContext, signal?: AbortSignal) {
    await this.admit(context);
    signal?.throwIfAborted();
    const paths = sources.flatMap((s) => {
      if (s.kind !== "path") return [];
      try {
        this.#managedKey(s.path);
        return [s.path];
      } catch {
        return [];
      }
    });
    const images =
      context.threadId && paths.length
        ? await this.options.outputImages({
            ownerId: context.userId,
            threadId: context.threadId,
            paths: [...new Set(paths)],
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
      let managed = false;
      try {
        this.#managedKey(source.path);
        managed = true;
      } catch {
        /* home containment still applies */
      }
      if (managed) {
        const image = images.find((i) => i.path === source.path);
        if (!image || !context.threadId) return null;
        const f = await this.#images.resolveAbsolutePath(source.path, signal);
        return {
          name: f.name,
          sizeBytes: f.sizeBytes,
          resource: {
            kind: "output-image",
            sequence: image.sequence,
            index: image.index,
            revision: f.revision,
          },
          mediaType: image.mediaType,
        };
      }
      const f = await this.options.home.resolveAbsolutePath(source.path, signal);
      return {
        resource: { kind: "home", key: f.key, revision: f.revision },
        name: f.name,
        sizeBytes: f.sizeBytes,
        mediaType: transcriptMediaType(f.name),
      };
    } catch (e) {
      signal?.throwIfAborted();
      if (
        e instanceof OpensteerError ||
        (e instanceof Error && (e.name === "NativeFsHelperError" || "code" in e))
      )
        return null;
      throw e;
    }
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
    let reader: Pick<AgentHomeFiles, "read" | "readContent"> = this.options.home;
    let key: string, name: string, mediaType: string;
    if (resource.kind === "home") {
      key = resource.key;
      try {
        name = Buffer.from(rootedFileSegments(key).at(-1)!, "base64url").toString();
      } catch {
        throw fileUnavailable();
      }
      mediaType = transcriptMediaType(name);
    } else {
      if (!context.threadId) throw fileUnavailable();
      const image = await this.options.outputImage({
        ownerId: context.userId,
        threadId: context.threadId,
        sequence: resource.sequence,
        index: resource.index,
      });
      if (!image) throw fileUnavailable();
      key = this.#managedKey(image.path);
      name = path.basename(image.path);
      mediaType = image.mediaType;
      reader = this.#images;
    }
    try {
      const result = options.full
        ? await reader.readContent(
            key,
            { expectedRevision: resource.revision, maxBytes: options.maxBytes },
            signal,
          )
        : await reader.read(
            key,
            {
              expectedRevision: resource.revision,
              maxBytes: Math.min(options.maxBytes, 512 * 1024),
            },
            signal,
          );
      if (
        resource.kind === "output-image" &&
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
  close() {
    this.#images.close();
  }
}
