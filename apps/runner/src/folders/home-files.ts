import { createHash } from "node:crypto";
import { appMaxBytes } from "@opensteer/core";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeHomeFileExportBundle,
  homeFilesExportManifestMaxBytes,
  homeFilesExportMaxBytes,
  homeFilesMaxBytes,
  homeFilesMaxFrameBytes,
  runFileNameHeader,
  runFileProofHeader,
  type RunFileTransferBinding,
  runFileTransferContentType,
  runFileTransferPath,
  type HomeDirectoryIdentity,
  type HomeFileErrorCode,
  type HomeFileRootKind,
  type HostHomeFileRequest,
  type RunnerHomeFileData,
  type RunFileTransfer,
} from "@opensteer/protocol";
import type { RunnerTransportPolicy } from "@opensteer/runner-client";
import { isNetworkPath } from "@opensteer/shared/fileHref";
import {
  NativeFsHelper,
  NativeFsHelperError,
  type NativeDirectoryIdentity,
} from "@opensteer/shared/files/native-fs-helper";
import { attachmentFileName } from "../attachments/attachment-cache.js";
import { runnerFileRequest } from "../attachments/host-http.js";

const outputImageFilenamePattern = /^[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|avif|svg)$/u;

export class HomeFilesError extends Error {
  readonly code: HomeFileErrorCode;
  readonly sizeBytes: number | undefined;

  constructor(code: HomeFileErrorCode, message: string, sizeBytes?: number) {
    super(message);
    this.name = "HomeFilesError";
    this.code = code;
    this.sizeBytes = sizeBytes;
  }
}

export type HomeFileOperationRequest = Exclude<
  HostHomeFileRequest,
  { readonly type: "host.home-files.cancel" }
>;

export function homeFileRootScope(root: string, identity: NativeDirectoryIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([root, identity]))
    .digest("base64url");
}

function encodeRootedFileKey(segments: readonly string[]): string {
  return Buffer.concat(
    segments.flatMap((segment, index) => [
      ...(index ? [Buffer.from([0])] : []),
      Buffer.from(segment, "base64url"),
    ]),
  ).toString("base64url");
}

function validateRelativeSegments(value: string): string[] {
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new HomeFilesError("bad_request", "Use a relative path inside Agent home");
  }
  return segments;
}

function mapHelperError(error: unknown): HomeFilesError {
  if (error instanceof HomeFilesError) return error;
  if (error instanceof NativeFsHelperError) {
    switch (error.code) {
      case "not-found":
        return new HomeFilesError("not_found", error.message);
      case "revision-mismatch":
      case "directory-revision-mismatch":
      case "file-revision-mismatch":
      case "root-replaced":
      case "concurrent-modification":
        return new HomeFilesError("revision_mismatch", error.message);
      case "already-exists":
      case "symlink-denied":
      case "not-regular":
      case "not-directory":
      case "cross-device":
      case "outside-workspace":
        return new HomeFilesError("conflict", error.message);
      case "invalid-request":
      case "invalid-path":
      case "invalid-root":
      case "invalid-root-policy":
        return new HomeFilesError("bad_request", error.message);
      case "file-too-large":
      case "too-large":
        return new HomeFilesError("file_too_large", error.message);
      default:
        return new HomeFilesError("unavailable", error.message);
    }
  }
  return new HomeFilesError(
    "unavailable",
    error instanceof Error && error.message
      ? error.message.slice(0, 500)
      : "Agent home file operation failed",
  );
}

export interface HomeFilesTransferClient {
  upload(
    transfer: RunFileTransfer,
    file: {
      readonly body: AsyncIterable<Uint8Array>;
      readonly size: number;
      readonly name: string;
    },
    signal: AbortSignal,
    binding: RunFileTransferBinding,
  ): Promise<void>;
  download(
    transfer: RunFileTransfer,
    maxBytes: number,
    signal: AbortSignal,
    binding: RunFileTransferBinding,
  ): Promise<Buffer>;
}

export function createHttpHomeFilesTransferClient(
  transport: RunnerTransportPolicy,
  proof?: (
    binding: RunFileTransferBinding,
    id: string,
    method: "GET" | "PUT",
  ) => string | undefined,
): HomeFilesTransferClient {
  const headers = (
    transfer: RunFileTransfer,
    binding: RunFileTransferBinding,
    method: "GET" | "PUT",
  ) => {
    const signature = proof?.(binding, transfer.id, method);
    return {
      authorization: `Bearer ${transfer.token}`,
      ...(signature ? { [runFileProofHeader]: signature } : {}),
    };
  };
  return {
    async upload(transfer, file, signal, binding) {
      const response = await runnerFileRequest(
        transport,
        runFileTransferPath(transfer.id),
        {
          ...headers(transfer, binding, "PUT"),
          "content-type": runFileTransferContentType,
          "content-length": String(file.size),
          [runFileNameHeader]: encodeURIComponent(file.name),
        },
        signal,
        boundedStream(file.body, file.size, signal),
      );
      response.destroy();
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        throw new HomeFilesError("unavailable", "File transfer upload failed");
      }
    },
    async download(transfer, maxBytes, signal, binding) {
      const response = await runnerFileRequest(
        transport,
        runFileTransferPath(transfer.id),
        headers(transfer, binding, "GET"),
        signal,
      );
      try {
        if (response.statusCode !== 200) {
          throw new HomeFilesError("unavailable", "File transfer download failed");
        }
        const declared = Number(response.headers["content-length"]);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
          throw new HomeFilesError("file_too_large", "File transfer exceeds its byte limit");
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response) {
          signal.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > declared || total > maxBytes) {
            throw new HomeFilesError("file_too_large", "File transfer exceeded its declared size");
          }
          chunks.push(bytes);
        }
        if (total !== declared) {
          throw new HomeFilesError("unavailable", "File transfer ended before its declared size");
        }
        return Buffer.concat(chunks, total);
      } finally {
        response.destroy();
      }
    },
  };
}

/**
 * Answers Host-initiated Agent-home file operations on the hosting Runner using the
 * local root-pinned, no-follow native helper.
 */
export class HomeFilesHandler {
  readonly #helper: NativeFsHelper;
  readonly #dataDirectory: string;
  readonly #homeDirectory: string | undefined;
  readonly #transfers: HomeFilesTransferClient | undefined;
  #agentHomePath: string | undefined;

  constructor(options: {
    readonly dataDirectory: string;
    readonly helperBinary: string;
    readonly transport?: RunnerTransportPolicy;
    readonly transfers?: HomeFilesTransferClient;
    readonly homeDirectory?: string;
    readonly agentHomePath?: string;
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#homeDirectory = options.homeDirectory;
    this.#agentHomePath = options.agentHomePath;
    this.#transfers =
      options.transfers ??
      (options.transport ? createHttpHomeFilesTransferClient(options.transport) : undefined);
    this.#helper = new NativeFsHelper({
      binary: options.helperBinary,
      rootPolicy: "managed-local",
      timeoutMilliseconds: 60_000,
    });
  }

  async initializeAgentHome(
    canonicalPath: string,
    signal: AbortSignal,
  ): Promise<HomeDirectoryIdentity> {
    const identity = await this.#helper.directoryIdentity(
      { root: canonicalPath, path: "." },
      signal,
    );
    this.#agentHomePath = canonicalPath;
    return identity;
  }

  async handle(
    request: HomeFileOperationRequest,
    signal: AbortSignal,
  ): Promise<RunnerHomeFileData> {
    signal.throwIfAborted();
    try {
      switch (request.type) {
        case "host.home-files.list":
          return await this.#list(request, signal);
        case "host.home-files.read":
          return await this.#read(request, signal);
        case "host.home-files.resolve":
          return await this.#resolve(request, signal);
        case "host.home-files.download":
          return await this.#download(request, signal);
        case "host.home-files.write":
          return await this.#write(request, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      throw mapHelperError(error);
    }
  }

  async #pinRoot(rootKind: HomeFileRootKind, signal: AbortSignal) {
    const root =
      rootKind === "output-images" ? join(this.#dataDirectory, "images") : this.#agentHomePath;
    if (!root) {
      throw new HomeFilesError("unavailable", "Agent home is not ready on this computer");
    }
    const expectedRootIdentity = await this.#helper.directoryIdentity({ root, path: "." }, signal);
    const rootScope = homeFileRootScope(root, expectedRootIdentity);
    return { root, expectedRootIdentity, rootScope };
  }

  #assertOutputImageSegment(rootKind: HomeFileRootKind, segments: readonly string[]): void {
    if (rootKind !== "output-images") return;
    if (segments.length !== 1) {
      throw new HomeFilesError("bad_request", "Output image path must be a single file name");
    }
    const name = Buffer.from(segments[0]!, "base64url").toString("utf8");
    if (!outputImageFilenamePattern.test(name)) {
      throw new HomeFilesError("bad_request", "Invalid output image name");
    }
  }

  async #list(
    request: Extract<HomeFileOperationRequest, { readonly type: "host.home-files.list" }>,
    signal: AbortSignal,
  ): Promise<Extract<RunnerHomeFileData, { readonly kind: "list" }>> {
    const { root, expectedRootIdentity, rootScope } = await this.#pinRoot("agent-home", signal);
    if (request.expectedRootScope && request.expectedRootScope !== rootScope)
      throw new HomeFilesError("revision_mismatch", "Root identity no longer matches");
    const listing = await this.#helper.filesList(
      {
        root,
        expectedRootIdentity,
        pathSegmentsBase64: request.pathSegmentsBase64,
        limit: request.limit,
        offset: request.offset,
        ...(request.expectedDirectoryRevision
          ? { expectedDirectoryRevision: request.expectedDirectoryRevision }
          : {}),
      },
      signal,
    );
    const entries = [...listing.entries];
    let hasMore = listing.hasMore;
    let nextOffset = listing.nextOffset;
    while (
      entries.length > 1 &&
      Buffer.byteLength(
        JSON.stringify({
          directoryRevision: listing.directoryRevision,
          entries,
          hasMore,
          nextOffset,
        }),
        "utf8",
      ) > homeFilesMaxFrameBytes
    ) {
      entries.pop();
      hasMore = true;
      nextOffset = request.offset + entries.length;
    }
    return {
      kind: "list",
      listing: {
        directoryRevision: listing.directoryRevision,
        entries,
        hasMore,
        nextOffset,
      },
      rootScope,
    };
  }

  async #read(
    request: Extract<HomeFileOperationRequest, { readonly type: "host.home-files.read" }>,
    signal: AbortSignal,
  ): Promise<Extract<RunnerHomeFileData, { readonly kind: "read" }>> {
    const rootKind = request.root ?? "agent-home";
    this.#assertOutputImageSegment(rootKind, request.pathSegmentsBase64);
    const { root, expectedRootIdentity, rootScope } = await this.#pinRoot(rootKind, signal);
    if (request.expectedRootScope && request.expectedRootScope !== rootScope) {
      throw new HomeFilesError("revision_mismatch", "Root identity no longer matches");
    }
    const result = await this.#helper.filesReadRange(
      {
        root,
        expectedRootIdentity,
        pathSegmentsBase64: request.pathSegmentsBase64,
        offset: request.offset,
        maxBytes: request.maxBytes,
        ...(request.expectedFileRevision
          ? { expectedFileRevision: request.expectedFileRevision }
          : {}),
      },
      signal,
    );
    return {
      kind: "read",
      bytesRead: result.bytesRead,
      contentBase64: result.bytes.toString("base64"),
      eof: result.eof,
      metadata: result.metadata,
      offset: result.offset,
      rootScope,
    };
  }

  async #resolve(
    request: Extract<HomeFileOperationRequest, { readonly type: "host.home-files.resolve" }>,
    signal: AbortSignal,
  ): Promise<Extract<RunnerHomeFileData, { readonly kind: "resolve" }>> {
    const { root, expectedRootIdentity, rootScope } = await this.#pinRoot("agent-home", signal);
    const allowRelative = request.allowRelative === true;
    const allowTilde = request.allowTilde === true;
    let value = request.path;
    if (/^file:/iu.test(value)) {
      if (
        value
          .replace(/%2e/giu, ".")
          .split(/[/\\]/u)
          .some((part) => part === "." || part === "..")
      ) {
        throw new HomeFilesError("not_found", "File unavailable");
      }
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new HomeFilesError("not_found", "File unavailable");
      }
      if (
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        (url.hostname && url.hostname !== "localhost")
      ) {
        throw new HomeFilesError("not_found", "File unavailable");
      }
      try {
        value = fileURLToPath(url);
      } catch {
        throw new HomeFilesError("not_found", "File unavailable");
      }
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[/\\]/iu.test(value)) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    if (
      /\p{Cc}/u.test(value) ||
      (process.platform !== "win32" && value.includes("\\")) ||
      isNetworkPath(value) ||
      value.split(/[/\\]/u).some((part) => part === "..")
    ) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    let expanded = false;
    if (value.startsWith("~/")) {
      if (!allowTilde) throw new HomeFilesError("not_found", "File unavailable");
      value = join(this.#homeDirectory ?? homedir(), value.slice(2));
      expanded = true;
    } else if (!isAbsolute(value)) {
      if (!allowRelative) throw new HomeFilesError("not_found", "File unavailable");
      value = join(root, value);
      expanded = true;
    } else if (!allowRelative && value.split(/[/\\]/u).some((part) => part === ".")) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    const candidate = expanded || allowRelative ? normalize(value) : value;
    if (!isAbsolute(candidate) || isNetworkPath(candidate)) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    const rawParts = rel.split(sep);
    if (rawParts.some((part) => !part || part === "." || part === "..")) {
      throw new HomeFilesError("not_found", "File unavailable");
    }
    const segments = rawParts.map((part) => Buffer.from(part).toString("base64url"));
    const key = encodeRootedFileKey(segments);
    const probe = await this.#helper.filesReadRange(
      {
        root,
        expectedRootIdentity,
        pathSegmentsBase64: segments,
        offset: 0,
        maxBytes: 1,
      },
      signal,
    );
    return {
      kind: "resolve",
      key,
      metadata: probe.metadata,
      name: basename(candidate),
      rootScope,
    };
  }

  async #download(
    request: Extract<HomeFileOperationRequest, { readonly type: "host.home-files.download" }>,
    signal: AbortSignal,
  ): Promise<Extract<RunnerHomeFileData, { readonly kind: "download" }>> {
    if (!this.#transfers) {
      throw new HomeFilesError("unavailable", "File transfer transport is unavailable");
    }
    const rootKind = request.root ?? "agent-home";
    this.#assertOutputImageSegment(rootKind, request.pathSegmentsBase64);
    const { root, expectedRootIdentity, rootScope } = await this.#pinRoot(rootKind, signal);
    if (request.expectedRootScope && request.expectedRootScope !== rootScope) {
      throw new HomeFilesError("revision_mismatch", "Root identity no longer matches");
    }
    const maxBytes = Math.min(
      request.maxBytes ?? homeFilesMaxBytes,
      request.purpose === "app-html" ? appMaxBytes : homeFilesMaxBytes,
    );
    const download = await this.#helper.filesDownload(
      {
        root,
        expectedRootIdentity,
        pathSegmentsBase64: request.pathSegmentsBase64,
        offset: 0,
        length: 0,
        ...(request.expectedFileRevision
          ? { expectedFileRevision: request.expectedFileRevision }
          : {}),
      },
      signal,
    );
    try {
      if (download.length > maxBytes) {
        download.stream.destroy();
        throw new HomeFilesError(
          "file_too_large",
          `File is ${download.length} bytes; limit is ${maxBytes} bytes`,
          download.length,
        );
      }
      const rawName = Buffer.from(request.pathSegmentsBase64.at(-1)!, "base64url").toString("utf8");
      await this.#transfers.upload(
        request.transfer,
        {
          body: download.stream,
          name: attachmentFileName(rawName),
          size: download.length,
        },
        signal,
        request,
      );
      return {
        kind: "download",
        length: download.length,
        metadata: download.metadata,
        rootScope,
      };
    } finally {
      download.stream.destroy();
    }
  }

  async #write(
    request: Extract<HomeFileOperationRequest, { readonly type: "host.home-files.write" }>,
    signal: AbortSignal,
  ): Promise<Extract<RunnerHomeFileData, { readonly kind: "write" }>> {
    if (!this.#transfers) {
      throw new HomeFilesError("unavailable", "File transfer transport is unavailable");
    }
    validateRelativeSegments(request.directory);
    const { root, expectedRootIdentity, rootScope } = await this.#pinRoot("agent-home", signal);
    const maxBytes = Math.min(request.maxBytes, homeFilesExportMaxBytes);
    const bundleBytes = await this.#transfers.download(
      request.transfer,
      4 + homeFilesExportManifestMaxBytes + maxBytes,
      signal,
      request,
    );
    let bundle: ReturnType<typeof decodeHomeFileExportBundle>;
    try {
      bundle = decodeHomeFileExportBundle(bundleBytes, maxBytes);
    } catch (error) {
      throw new HomeFilesError(
        "bad_request",
        error instanceof Error ? error.message : "Invalid export bundle",
      );
    }
    if (bundle.directory !== request.directory) {
      throw new HomeFilesError("bad_request", "Export directory does not match transfer manifest");
    }
    const entries = bundle.files.map((file) => ({
      bytes: file.bytes,
      segments: validateRelativeSegments(file.path),
    }));
    await this.#helper.createDirectory(
      { root, path: request.directory, expectedRootIdentity },
      signal,
    );
    const created = new Set([request.directory]);
    for (const { segments, bytes } of entries) {
      let parent = request.directory;
      for (const segment of segments.slice(0, -1)) {
        parent += "/" + segment;
        if (!created.has(parent)) {
          await this.#helper.createDirectory({ root, path: parent, expectedRootIdentity }, signal);
          created.add(parent);
        }
      }
      await this.#helper.writeBinary(
        {
          root,
          path: parent + "/" + segments.at(-1)!,
          contentBase64: Buffer.from(bytes).toString("base64"),
          expectedRootIdentity,
        },
        signal,
      );
    }
    return {
      kind: "write",
      filesWritten: entries.length,
      rootScope,
    };
  }
}

async function* boundedStream(
  body: AsyncIterable<Uint8Array>,
  size: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (size > homeFilesMaxBytes) {
    throw new HomeFilesError("file_too_large", "File exceeds maximum transfer size", size);
  }
  let total = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > size || total > homeFilesMaxBytes) {
      throw new HomeFilesError("conflict", "File size changed during transfer");
    }
    yield chunk;
  }
  signal.throwIfAborted();
  if (total !== size) {
    throw new HomeFilesError("unavailable", "File transfer was incomplete");
  }
}
