import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { OpensteerError, type LocalWorkspaceBacking, type Workspace } from "@opensteer/core";
import type { WorkspaceLocalRequest } from "@opensteer/orchestration";
import {
  workspaceLocalFilesReadMaxBytes,
  type RunnerWorkspaceLocalResult,
} from "@opensteer/protocol";
import {
  WorkspaceDirectoryPageSchema,
  WorkspaceFileEntrySchema,
  WorkspaceFilePreviewMetadataSchema,
  workspaceDirectoryPageMaxEntries,
  workspaceFilePreviewMaxBytes,
  type WorkspaceDirectoryPage,
  type WorkspaceFileEntry,
} from "@opensteer/protocol";
import {
  WorkspaceAuthorityUnreachableError,
  requireLocalWorkspaceStorageAuthority,
  type LocalFileMetadata,
} from "@opensteer/workspace";
import {
  LocalWorkspaceFailureError,
  type RunnerStorageRegistry,
} from "../runner-local-workspace-driver.js";
import type {
  WorkspaceFileListInput,
  WorkspaceFilePreview,
  WorkspaceFilesDriver,
} from "./workspace-files-types.js";

const maximumCursorOffset = 1_000_000;
const opaqueCursorVersion = 2;
const requestTimeoutMs = 30_000;

type LocalWorkspace = Workspace & { readonly backing: LocalWorkspaceBacking };

interface DirectoryCursor {
  readonly directoryRevision: string;
  readonly offset: number;
  readonly scopeDigest: string;
  readonly version: typeof opaqueCursorVersion;
}

interface SignedDirectoryCursor extends DirectoryCursor {
  readonly signature: string;
}

/**
 * Files for local-directory Workspaces, read from the machine that holds them.
 * The Host still owns opaque keys, cursors and the public protocol shape; every
 * path decision happens on the owning Runner against its identity-bound root.
 */
export class RunnerLocalWorkspaceFilesDriver implements WorkspaceFilesDriver<LocalWorkspace> {
  readonly kind = "local-directory" as const;
  readonly #cursorSecret = randomBytes(32);
  readonly #runners: RunnerStorageRegistry;

  constructor(options: { readonly runners: RunnerStorageRegistry }) {
    this.#runners = options.runners;
  }

  async list(
    workspace: LocalWorkspace,
    input: WorkspaceFileListInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryPage> {
    assertReady(workspace);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > workspaceDirectoryPageMaxEntries
    ) {
      throw badRequest("Directory page limit is outside the supported range");
    }
    const operationSignal = signal ?? AbortSignal.timeout(requestTimeoutMs);
    operationSignal.throwIfAborted();
    const parentSegments = decodeLocalKey(input.parentKey);
    const scopeDigest = cursorScopeDigest(workspace, input.parentKey);
    const cursor = input.cursor ? parseCursor(input.cursor, this.#cursorSecret) : undefined;
    const retained = input.retainedCursor
      ? parseCursor(input.retainedCursor, this.#cursorSecret)
      : undefined;
    if (cursor) {
      if (cursor.scopeDigest !== scopeDigest) {
        throw badRequest("Directory cursor belongs to another Workspace or folder");
      }
      if (cursor.offset > maximumCursorOffset) throw badRequest("Directory cursor is too large");
    }
    if (retained) {
      if (retained.scopeDigest !== scopeDigest) {
        throw badRequest("Retained cursor belongs to another Workspace or folder");
      }
      if (cursor && retained.directoryRevision !== cursor.directoryRevision) {
        throw directoryChanged();
      }
    }

    const offset = cursor?.offset ?? 0;
    const result = await this.#request(
      workspace,
      {
        ...(cursor ? { expectedDirectoryRevision: cursor.directoryRevision } : {}),
        binding: bindingRef(workspace),
        limit: input.limit,
        offset,
        operationId: `workspace:${workspace.id}:files.list:v1`,
        pathSegmentsBase64: parentSegments.map(encodeSegment),
        requestId: randomUUID(),
        type: "host.workspace.local.files.list",
      },
      "runner.workspace.local.files.listed",
      operationSignal,
    );
    const listing = result.listing;
    if (listing.nextOffset !== offset + listing.entries.length) {
      throw new Error("The machine returned an invalid directory offset");
    }
    if (retained !== undefined && retained.directoryRevision !== listing.directoryRevision) {
      throw directoryChanged();
    }
    const entries = listing.entries.map((entry) => {
      const name = decodeSegment(entry.nameBase64);
      return WorkspaceFileEntrySchema.parse({
        executable: entry.executable,
        hidden: entry.hidden,
        key: encodeLocalKey([...parentSegments, name]),
        kind: entry.kind,
        mode: entry.mode,
        modifiedAt: entry.modifiedAt,
        name: entry.displayName,
        sizeBytes: entry.kind === "file" ? entry.sizeBytes : 0,
      });
    });
    const revision = digestPage(listing.directoryRevision, offset, entries);
    if (
      retained !== undefined &&
      input.knownRevision !== undefined &&
      input.knownRevision !== revision
    ) {
      throw directoryChanged();
    }
    return WorkspaceDirectoryPageSchema.parse({
      cursor: listing.hasMore
        ? encodeCursor(
            {
              directoryRevision: listing.directoryRevision,
              offset: listing.nextOffset,
              scopeDigest,
              version: opaqueCursorVersion,
            },
            this.#cursorSecret,
          )
        : null,
      entries,
      parentKey: input.parentKey,
      revision,
    });
  }

  async preview(
    workspace: LocalWorkspace,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview> {
    assertReady(workspace);
    const operationSignal = signal ?? AbortSignal.timeout(requestTimeoutMs);
    operationSignal.throwIfAborted();
    const segments = decodeRequiredFileKey(fileKey);
    const chunks: Uint8Array[] = [];
    let read = 0;
    let metadata: LocalFileMetadata | undefined;
    // The preview window is larger than one pull, so it is assembled from
    // consecutive ranges pinned to the revision the first one reported.
    while (read < workspaceFilePreviewMaxBytes) {
      const range = await this.#readRange(workspace, {
        ...(metadata ? { expectedFileRevision: metadata.revision } : {}),
        maxBytes: Math.min(workspaceLocalFilesReadMaxBytes, workspaceFilePreviewMaxBytes - read),
        offset: read,
        pathSegmentsBase64: segments.map(encodeSegment),
        signal: operationSignal,
      });
      metadata = range.metadata;
      const bytes = decodeBase64(range.contentBase64, range.bytesRead);
      if (bytes.byteLength === 0) break;
      chunks.push(bytes);
      read += bytes.byteLength;
      if (range.eof) break;
    }
    if (!metadata) throw new Error("The machine returned no file metadata");
    return {
      bytes: concat(chunks, read),
      metadata: previewMetadata(fileKey, metadata, read),
    };
  }

  /**
   * Downloads pull one bounded range per consumer read. Nothing is buffered
   * ahead, so backpressure reaches the owning machine and the Host's membership
   * revalidation still runs between chunks.
   */
  async download(
    workspace: LocalWorkspace,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    assertReady(workspace);
    const operationSignal = signal ?? AbortSignal.timeout(requestTimeoutMs);
    operationSignal.throwIfAborted();
    const segments = decodeRequiredFileKey(fileKey).map(encodeSegment);
    const first = await this.#readRange(workspace, {
      maxBytes: workspaceLocalFilesReadMaxBytes,
      offset: 0,
      pathSegmentsBase64: segments,
      signal: operationSignal,
    });
    const metadata = first.metadata;
    let pending: Uint8Array | undefined = decodeBase64(first.contentBase64, first.bytesRead);
    let offset = pending.byteLength;
    let done = first.eof || offset >= metadata.sizeBytes;
    const readRange = (nextOffset: number) =>
      this.#readRange(workspace, {
        expectedFileRevision: metadata.revision,
        maxBytes: workspaceLocalFilesReadMaxBytes,
        offset: nextOffset,
        pathSegmentsBase64: segments,
        signal: operationSignal,
      });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (pending === undefined) {
              if (done) {
                controller.close();
                return;
              }
              const range = await readRange(offset);
              const bytes = decodeBase64(range.contentBase64, range.bytesRead);
              offset += bytes.byteLength;
              done = range.eof || bytes.byteLength === 0 || offset >= metadata.sizeBytes;
              if (bytes.byteLength === 0) {
                controller.close();
                return;
              }
              pending = bytes;
            }
            const next = pending;
            pending = undefined;
            controller.enqueue(next);
          } catch (error) {
            controller.error(error);
          }
        },
      },
      // Every pull must correspond to downstream demand; nothing is fetched from
      // the owning machine on speculation.
      { highWaterMark: 0 },
    );
    return new Response(body, { headers: contentHeaders(fileKey, metadata) });
  }

  async #readRange(
    workspace: LocalWorkspace,
    input: {
      readonly expectedFileRevision?: string;
      readonly maxBytes: number;
      readonly offset: number;
      readonly pathSegmentsBase64: readonly string[];
      readonly signal: AbortSignal;
    },
  ): Promise<Extract<RunnerWorkspaceLocalResult, { type: "runner.workspace.local.files.read" }>> {
    return this.#request(
      workspace,
      {
        ...(input.expectedFileRevision === undefined
          ? {}
          : { expectedFileRevision: input.expectedFileRevision }),
        binding: bindingRef(workspace),
        maxBytes: input.maxBytes,
        offset: input.offset,
        operationId: `workspace:${workspace.id}:files.read:v1`,
        pathSegmentsBase64: [...input.pathSegmentsBase64],
        requestId: randomUUID(),
        type: "host.workspace.local.files.read",
      },
      "runner.workspace.local.files.read",
      input.signal,
    );
  }

  async #request<Type extends RunnerWorkspaceLocalResult["type"]>(
    workspace: LocalWorkspace,
    request: WorkspaceLocalRequest,
    expected: Type,
    signal: AbortSignal,
  ): Promise<Extract<RunnerWorkspaceLocalResult, { readonly type: Type }>> {
    let result: RunnerWorkspaceLocalResult;
    try {
      result = await this.#runners.requestWorkspaceLocal(
        workspace.backing.ownerEnvironmentId,
        request,
        signal,
      );
    } catch (error) {
      throw translateRunnerReadError(error);
    }
    if (result.type === "runner.workspace.local.error") {
      throw translateRunnerReadError(new LocalWorkspaceFailureError(result.error));
    }
    if (result.type !== expected) {
      throw new Error("The machine answered a different Workspace files question");
    }
    return result as Extract<RunnerWorkspaceLocalResult, { readonly type: Type }>;
  }
}

function bindingRef(workspace: LocalWorkspace) {
  return {
    bindingId: workspace.backing.bindingId,
    generation: workspace.backing.generation,
    ownerEnvironmentId: workspace.backing.ownerEnvironmentId,
    storageAuthorityId: requireLocalWorkspaceStorageAuthority(workspace.backing),
    workspaceId: workspace.id,
  } as const;
}

function decodeBase64(value: string, expectedBytes: number): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedBytes) {
    throw new Error("The machine returned a byte count that does not match its payload");
  }
  return bytes;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function encodeLocalKey(segments: readonly Buffer[]): string {
  const encoded: Buffer[] = [];
  for (const [index, segment] of segments.entries()) {
    assertLocalSegment(segment);
    if (index > 0) encoded.push(Buffer.from([0]));
    encoded.push(segment);
  }
  return Buffer.concat(encoded).toString("base64url");
}

function decodeLocalKey(key: string): Buffer[] {
  if (key === "") return [];
  let decoded: Buffer;
  try {
    decoded = Buffer.from(key, "base64url");
    if (decoded.toString("base64url") !== key) throw new Error("non-canonical key");
  } catch (error) {
    throw badRequest("File key is invalid", error);
  }
  const segments: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= decoded.length; index += 1) {
    if (index === decoded.length || decoded[index] === 0) {
      const segment = decoded.subarray(start, index);
      assertLocalSegment(segment);
      segments.push(segment);
      start = index + 1;
    }
  }
  return segments;
}

function decodeRequiredFileKey(key: string): Buffer[] {
  const segments = decodeLocalKey(key);
  if (segments.length === 0) throw badRequest("A file key is required");
  return segments;
}

function assertLocalSegment(segment: Buffer): void {
  if (
    segment.length === 0 ||
    segment.equals(Buffer.from(".")) ||
    segment.equals(Buffer.from("..")) ||
    segment.includes(0) ||
    segment.includes(0x2f)
  ) {
    throw badRequest("File key is invalid");
  }
}

function encodeSegment(segment: Buffer): string {
  assertLocalSegment(segment);
  return segment.toString("base64url");
}

function decodeSegment(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("The machine returned a non-canonical entry name");
  }
  assertLocalSegment(decoded);
  return decoded;
}

function digestPage(
  directoryRevision: string,
  offset: number,
  entries: readonly WorkspaceFileEntry[],
): string {
  return createHash("sha256")
    .update(directoryRevision)
    .update("\0")
    .update(String(offset))
    .update("\0")
    .update(JSON.stringify(entries))
    .digest("base64url");
}

function cursorScopeDigest(workspace: LocalWorkspace, parentKey: string): string {
  return createHash("sha256")
    .update(workspace.id)
    .update("\0")
    .update(workspace.backing.bindingId)
    .update("\0")
    .update(String(workspace.backing.generation))
    .update("\0")
    .update(requireLocalWorkspaceStorageAuthority(workspace.backing))
    .update("\0")
    .update(parentKey)
    .digest("base64url")
    .slice(0, 22);
}

function encodeCursor(cursor: DirectoryCursor, secret: Uint8Array): string {
  return Buffer.from(
    JSON.stringify({ ...cursor, signature: cursorSignature(cursor, secret) }),
    "utf8",
  ).toString("base64url");
}

function parseCursor(value: string, secret: Uint8Array): DirectoryCursor {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value || decoded.byteLength > 512) {
      throw new Error("invalid cursor encoding");
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<SignedDirectoryCursor>;
    if (
      parsed.version !== opaqueCursorVersion ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset === undefined ||
      parsed.offset < 0 ||
      parsed.offset > maximumCursorOffset ||
      typeof parsed.directoryRevision !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed.directoryRevision) ||
      typeof parsed.scopeDigest !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/u.test(parsed.scopeDigest) ||
      typeof parsed.signature !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/u.test(parsed.signature)
    ) {
      throw new Error("invalid cursor shape");
    }
    const cursor: DirectoryCursor = {
      directoryRevision: parsed.directoryRevision,
      offset: parsed.offset,
      scopeDigest: parsed.scopeDigest,
      version: opaqueCursorVersion,
    };
    const supplied = Buffer.from(parsed.signature, "base64url");
    const expected = Buffer.from(cursorSignature(cursor, secret), "base64url");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("invalid cursor signature");
    }
    return cursor;
  } catch (error) {
    throw badRequest("Directory cursor is invalid", error);
  }
}

function cursorSignature(cursor: DirectoryCursor, secret: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(cursor))
    .digest("base64url")
    .slice(0, 22);
}

function previewMetadata(
  fileKey: string,
  metadata: LocalFileMetadata,
  bytesRead: number,
): WorkspaceFilePreview["metadata"] {
  return WorkspaceFilePreviewMetadataSchema.parse({
    contentType: contentTypeForKey(fileKey),
    etag: `"${metadata.revision}"`,
    modifiedAt: metadata.modifiedAt,
    sizeBytes: metadata.sizeBytes,
    truncated: metadata.sizeBytes > bytesRead,
  });
}

function contentHeaders(fileKey: string, metadata: LocalFileMetadata): Headers {
  const headers = new Headers({
    "content-length": String(metadata.sizeBytes),
    "content-type": contentTypeForKey(fileKey),
    etag: `"${metadata.revision}"`,
  });
  if (metadata.modifiedAt) {
    headers.set("last-modified", new Date(metadata.modifiedAt).toUTCString());
  }
  return headers;
}

function contentTypeForKey(fileKey: string): string {
  const name = decodeLocalKey(fileKey).at(-1)?.toString("utf8").toLowerCase() ?? "";
  const extension = path.extname(name);
  if (
    [
      ".c",
      ".cc",
      ".cpp",
      ".css",
      ".go",
      ".h",
      ".hpp",
      ".html",
      ".java",
      ".js",
      ".jsx",
      ".md",
      ".mjs",
      ".py",
      ".rs",
      ".sh",
      ".ts",
      ".tsx",
      ".txt",
      ".yaml",
      ".yml",
    ].includes(extension)
  ) {
    return "text/plain; charset=utf-8";
  }
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function assertReady(workspace: Workspace): void {
  if (workspace.status !== "ready") {
    throw unavailable(workspace.storageIssue?.message ?? "Workspace storage is not ready");
  }
}

function badRequest(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({ cause, code: "bad_request", message });
}

function unavailable(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({ cause, code: "workspace_unavailable", message, retryable: true });
}

function directoryChanged(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "The Workspace directory changed while it was being read",
    retryable: true,
  });
}

function translateRunnerReadError(error: unknown): OpensteerError {
  if (error instanceof OpensteerError) return error;
  if (error instanceof WorkspaceAuthorityUnreachableError) {
    return unavailable("The computer holding this Workspace is not reachable right now", error);
  }
  if (error instanceof LocalWorkspaceFailureError) {
    switch (error.failure.code) {
      case "not-found":
        return new OpensteerError({ code: "not_found", message: "File not found" });
      case "concurrent-modification":
        return new OpensteerError({
          cause: error,
          code: "conflict",
          message: "The Workspace entry changed while it was being read",
          retryable: true,
        });
      case "invalid-path":
      case "invalid-request":
      case "not-directory":
      case "not-regular":
      case "outside-workspace":
      case "symlink-denied":
      case "unsafe-parent":
        return badRequest(error.failure.message, error);
      default:
        return unavailable(error.failure.message, error);
    }
  }
  return unavailable("Workspace files are temporarily unavailable", error);
}
