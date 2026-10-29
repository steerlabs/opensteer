import {
  LocalDirectoryListingSchema,
  LocalFileMetadataSchema,
  localFilesMaximumReadBytes,
} from "@opensteer/workspace";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Transform, type Readable } from "node:stream";
import { z } from "zod";

const maxHelperRequestBytes = 2 * 1_024 * 1_024;
const maxHelperResponseBytes = 2 * 1_024 * 1_024;
const maxHelperStderrBytes = 64 * 1_024;
const defaultHelperTimeoutMilliseconds = 30_000;
const nativeFilesMaximumReadBytes = localFilesMaximumReadBytes;

export type NativeFilesystemRootPolicy = "isolated-mount" | "managed-local";

const FileEntrySchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.enum(["directory", "file", "other", "symlink"]),
});
const ListResultSchema = z.strictObject({
  entries: z.array(FileEntrySchema).max(2_000),
  truncated: z.boolean(),
});
const ReadResultSchema = z.strictObject({
  contentBase64: z.string().max(1_500_000),
  path: z.string().min(1).max(4_096),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(1 * 1_024 * 1_024),
});
const SearchResultSchema = z.strictObject({
  matches: z
    .array(
      z.strictObject({
        line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        path: z.string().min(1).max(4_096),
        // The Go helper caps at 2,000 Unicode scalars; astral scalars occupy
        // two JavaScript UTF-16 code units.
        text: z.string().max(4_000),
      }),
    )
    .max(500),
  scannedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1_024 * 1_024),
  truncated: z.boolean(),
});
const WriteResultSchema = z.strictObject({
  bytesWritten: z
    .number()
    .int()
    .nonnegative()
    .max(1 * 1_024 * 1_024),
  durability: z.enum(["sync-uncertain", "synced"]),
  path: z.string().min(1).max(4_096),
});
const ReplaceResultSchema = z.strictObject({
  durability: z.enum(["sync-uncertain", "synced"]),
  occurrencesReplaced: z
    .number()
    .int()
    .positive()
    .max(1 * 1_024 * 1_024),
  path: z.string().min(1).max(4_096),
});
export const NativeDirectoryIdentitySchema = z.strictObject({
  fileId: z.string().regex(/^(?:0|[1-9][0-9]*|[a-f0-9]{32})$/u),
  kind: z.enum(["posix", "windows"]),
  volumeId: z.string().regex(/^(0|[1-9][0-9]*)$/u),
});
export type NativeDirectoryIdentity = z.infer<typeof NativeDirectoryIdentitySchema>;
const EnsureRootResultSchema = z.strictObject({
  created: z.boolean(),
  identity: NativeDirectoryIdentitySchema,
});
type NativeEnsureRootResult = z.infer<typeof EnsureRootResultSchema>;
export const NativeFileMetadataSchema = LocalFileMetadataSchema;
export type NativeFileMetadata = z.infer<typeof NativeFileMetadataSchema>;
export const NativeFilesListResultSchema = LocalDirectoryListingSchema;
type NativeFilesListResult = z.infer<typeof NativeFilesListResultSchema>;
const NativeFilesReadRangeResultSchema = z.strictObject({
  bytesRead: z.number().int().nonnegative().max(nativeFilesMaximumReadBytes),
  contentBase64: z.string().max(700_000),
  eof: z.boolean(),
  metadata: NativeFileMetadataSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const NativeFilesDownloadMetadataSchema = z.strictObject({
  length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  metadata: NativeFileMetadataSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export interface NativeFileDownload {
  readonly length: number;
  readonly metadata: NativeFileMetadata;
  readonly offset: number;
  readonly stream: Readable;
}
const ProbeResultSchema = z.strictObject({
  binaryIdentity: z.literal("opensteer-native-fs"),
  binaryVersion: z.literal("1.6.0"),
  containment: z.enum(["linux-openat2", "posix-openat-nofollow", "windows-nt-relative-noreparse"]),
  platform: z.enum(["darwin", "linux", "windows"]),
});
const ResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    binaryIdentity: z.literal("opensteer-native-fs"),
    binaryVersion: z.literal("1.6.0"),
    containment: ProbeResultSchema.shape.containment,
    error: z.strictObject({
      code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      message: z.string().min(1).max(500),
    }),
    ok: z.literal(false),
    platform: ProbeResultSchema.shape.platform,
  }),
  z.strictObject({
    binaryIdentity: z.literal("opensteer-native-fs"),
    binaryVersion: z.literal("1.6.0"),
    containment: ProbeResultSchema.shape.containment,
    ok: z.literal(true),
    platform: ProbeResultSchema.shape.platform,
    result: z.unknown(),
  }),
]);

export interface NativeFilesystem {
  directoryIdentity(
    input: { readonly path: string; readonly root: string },
    signal: AbortSignal,
  ): Promise<NativeDirectoryIdentity>;
  ensureDirectory(
    input: { readonly path: string; readonly resume: boolean; readonly root: string },
    signal: AbortSignal,
  ): Promise<NativeDirectoryIdentity>;
  ensureRoot(
    input: { readonly root: string },
    signal: AbortSignal,
  ): Promise<NativeEnsureRootResult>;
  list(
    input: {
      readonly maxDepth: number;
      readonly maxEntries: number;
      readonly path: string;
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<z.infer<typeof ListResultSchema>>;
  preflight(root: string, signal: AbortSignal): Promise<z.infer<typeof ProbeResultSchema>>;
  read(
    input: { readonly path: string; readonly root: string },
    signal: AbortSignal,
  ): Promise<{ readonly content: Buffer; readonly path: string; readonly size: number }>;
  replace(
    input: {
      readonly newText: string;
      readonly oldText: string;
      readonly path: string;
      readonly replaceAll: boolean;
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReplaceResultSchema>>;
  search(
    input: {
      readonly caseSensitive: boolean;
      readonly maxEntries: number;
      readonly maxResults: number;
      readonly path: string;
      readonly query: string;
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<z.infer<typeof SearchResultSchema>>;
  write(
    input: { readonly content: string; readonly path: string; readonly root: string },
    signal: AbortSignal,
  ): Promise<z.infer<typeof WriteResultSchema>>;
}

/** Host Files read plane. Every operation is rooted in a registry-persisted identity. */
export interface NativeWorkspaceFilesAuthority {
  filesList(
    input: {
      readonly expectedDirectoryRevision?: string;
      readonly expectedRootIdentity: NativeDirectoryIdentity;
      readonly limit: number;
      readonly offset: number;
      readonly pathSegmentsBase64: readonly string[];
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<NativeFilesListResult>;
  filesReadRange(
    input: {
      readonly expectedFileRevision?: string;
      readonly expectedRootIdentity: NativeDirectoryIdentity;
      readonly maxBytes: number;
      readonly offset: number;
      readonly pathSegmentsBase64: readonly string[];
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly bytes: Buffer;
    readonly bytesRead: number;
    readonly eof: boolean;
    readonly metadata: NativeFileMetadata;
    readonly offset: number;
  }>;
  filesDownload(
    input: {
      readonly expectedFileRevision?: string;
      readonly expectedRootIdentity: NativeDirectoryIdentity;
      /** Zero means the whole file only when offset is also zero. */
      readonly length: number;
      readonly offset: number;
      readonly pathSegmentsBase64: readonly string[];
      readonly root: string;
    },
    signal: AbortSignal,
  ): Promise<NativeFileDownload>;
}

export class NativeFsHelper implements NativeFilesystem, NativeWorkspaceFilesAuthority {
  readonly #binary: string;
  readonly #rootPolicy: NativeFilesystemRootPolicy;
  readonly #timeoutMilliseconds: number;

  constructor(options: {
    readonly binary: string;
    readonly rootPolicy?: NativeFilesystemRootPolicy;
    readonly timeoutMilliseconds?: number;
  }) {
    if (!isAbsolute(options.binary)) {
      throw new Error("Native filesystem helper path must be absolute");
    }
    this.#binary = options.binary;
    this.#rootPolicy = options.rootPolicy ?? "isolated-mount";
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? defaultHelperTimeoutMilliseconds;
    if (
      !Number.isSafeInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds < 100 ||
      this.#timeoutMilliseconds > 120_000
    ) {
      throw new Error("Native filesystem helper timeout is invalid");
    }
  }

  async preflight(root: string, signal: AbortSignal) {
    const result = await this.#request({ operation: "probe", root }, ProbeResultSchema, signal);
    const expected =
      process.platform === "linux"
        ? { containment: "linux-openat2", platform: "linux" }
        : process.platform === "darwin"
          ? { containment: "posix-openat-nofollow", platform: "darwin" }
          : process.platform === "win32"
            ? { containment: "windows-nt-relative-noreparse", platform: "windows" }
            : undefined;
    if (
      !expected ||
      result.containment !== expected.containment ||
      result.platform !== expected.platform
    ) {
      throw new Error("Native filesystem containment is unavailable on this platform");
    }
    return result;
  }

  async directoryIdentity(
    input: Parameters<NativeFilesystem["directoryIdentity"]>[0],
    signal: AbortSignal,
  ) {
    const identity = await this.#request(
      { ...input, operation: "directory-identity" },
      NativeDirectoryIdentitySchema,
      signal,
    );
    assertNativeIdentityPlatform(identity);
    return identity;
  }

  async ensureDirectory(
    input: Parameters<NativeFilesystem["ensureDirectory"]>[0],
    signal: AbortSignal,
  ) {
    const identity = await this.#request(
      { ...input, operation: "ensure-directory" },
      NativeDirectoryIdentitySchema,
      signal,
    );
    assertNativeIdentityPlatform(identity);
    return identity;
  }

  async ensureRoot(input: Parameters<NativeFilesystem["ensureRoot"]>[0], signal: AbortSignal) {
    const result = await this.#request(
      { ...input, operation: "ensure-root" },
      EnsureRootResultSchema,
      signal,
    );
    assertNativeIdentityPlatform(result.identity);
    return result;
  }

  list(input: Parameters<NativeFilesystem["list"]>[0], signal: AbortSignal) {
    return this.#request({ ...input, operation: "list" }, ListResultSchema, signal);
  }

  filesList(input: Parameters<NativeWorkspaceFilesAuthority["filesList"]>[0], signal: AbortSignal) {
    return this.#request(
      { ...input, operation: "files-list" },
      NativeFilesListResultSchema,
      signal,
    );
  }

  async filesReadRange(
    input: Parameters<NativeWorkspaceFilesAuthority["filesReadRange"]>[0],
    signal: AbortSignal,
  ) {
    const result = await this.#request(
      { ...input, operation: "files-read-range" },
      NativeFilesReadRangeResultSchema,
      signal,
    );
    const bytes = Buffer.from(result.contentBase64, "base64");
    if (
      bytes.byteLength !== result.bytesRead ||
      bytes.toString("base64") !== result.contentBase64
    ) {
      throw new Error("Native filesystem helper returned an invalid Files read result");
    }
    return {
      bytes,
      bytesRead: result.bytesRead,
      eof: result.eof,
      metadata: result.metadata,
      offset: result.offset,
    };
  }

  async filesDownload(
    input: Parameters<NativeWorkspaceFilesAuthority["filesDownload"]>[0],
    signal: AbortSignal,
  ): Promise<NativeFileDownload> {
    signal.throwIfAborted();
    await assertTrustedHelperExecutable(this.#binary);
    const encoded = encodeHelperRequest(
      { ...input, operation: "files-download" },
      this.#rootPolicy,
    );
    const result = await executeStreamingHelper({
      binary: this.#binary,
      input: encoded,
      resultSchema: NativeFilesDownloadMetadataSchema,
      signal,
      timeoutMilliseconds: this.#timeoutMilliseconds,
    });
    return { ...result.metadata, stream: result.stream };
  }

  async read(input: Parameters<NativeFilesystem["read"]>[0], signal: AbortSignal) {
    const result = await this.#request({ ...input, operation: "read" }, ReadResultSchema, signal);
    const content = Buffer.from(result.contentBase64, "base64");
    if (content.byteLength !== result.size || content.toString("base64") !== result.contentBase64) {
      throw new Error("Native filesystem helper returned an invalid read result");
    }
    return { content, path: result.path, size: result.size };
  }

  replace(input: Parameters<NativeFilesystem["replace"]>[0], signal: AbortSignal) {
    return this.#request({ ...input, operation: "replace" }, ReplaceResultSchema, signal);
  }

  search(input: Parameters<NativeFilesystem["search"]>[0], signal: AbortSignal) {
    return this.#request({ ...input, operation: "search" }, SearchResultSchema, signal);
  }

  write(input: Parameters<NativeFilesystem["write"]>[0], signal: AbortSignal) {
    return this.#request({ ...input, operation: "write" }, WriteResultSchema, signal);
  }

  async #request<Result>(
    request: Record<string, unknown>,
    resultSchema: z.ZodType<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    signal.throwIfAborted();
    await assertTrustedHelperExecutable(this.#binary);
    const encoded = encodeHelperRequest(request, this.#rootPolicy);
    const response = await executeHelper({
      binary: this.#binary,
      input: encoded,
      signal,
      timeoutMilliseconds: this.#timeoutMilliseconds,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.toString("utf8"));
    } catch {
      throw new Error("Native filesystem helper returned invalid JSON");
    }
    const envelope = ResponseEnvelopeSchema.parse(parsed);
    const expected = expectedNativePlatform();
    if (envelope.containment !== expected.containment || envelope.platform !== expected.platform) {
      throw new Error("Native filesystem containment is unavailable on this platform");
    }
    if (!envelope.ok) throw new NativeFsHelperError(envelope.error.code, envelope.error.message);
    return resultSchema.parse(envelope.result);
  }
}

function expectedNativePlatform(): {
  readonly containment: "linux-openat2" | "posix-openat-nofollow" | "windows-nt-relative-noreparse";
  readonly platform: "darwin" | "linux" | "windows";
} {
  if (process.platform === "linux") {
    return { containment: "linux-openat2", platform: "linux" };
  }
  if (process.platform === "darwin") {
    return { containment: "posix-openat-nofollow", platform: "darwin" };
  }
  if (process.platform === "win32") {
    return { containment: "windows-nt-relative-noreparse", platform: "windows" };
  }
  throw new Error("Native filesystem containment is unavailable on this platform");
}

function assertNativeIdentityPlatform(identity: NativeDirectoryIdentity): void {
  const expectedKind = process.platform === "win32" ? "windows" : "posix";
  if (identity.kind !== expectedKind) {
    throw new Error("Native filesystem helper returned an identity for another platform");
  }
}

export class NativeFsHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "NativeFsHelperError";
  }
}

function executeHelper(input: {
  readonly binary: string;
  readonly input: Buffer;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(input.binary, [], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingTermination: Error | undefined;
    let killFallback: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      input.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const terminate = (error: Error): void => {
      if (settled || pendingTermination) return;
      pendingTermination = error;
      child.kill("SIGKILL");
      killFallback = setTimeout(() => finish(error), 1_000);
      killFallback.unref();
    };
    const abort = (): void =>
      terminate(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Native filesystem operation was aborted"),
      );
    const timeout = setTimeout(
      () => terminate(new Error("Native filesystem helper timed out")),
      input.timeoutMilliseconds,
    );
    timeout.unref();
    child.once("error", () => finish(new Error("Native filesystem helper could not be started")));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxHelperResponseBytes) {
        terminate(new Error("Native filesystem helper response exceeds its byte limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxHelperStderrBytes) {
        terminate(new Error("Native filesystem helper stderr exceeds its byte limit"));
      }
      // Helper stderr is deliberately never reflected into Runs, logs, or errors.
    });
    child.once("close", (code, processSignal) => {
      if (pendingTermination) {
        finish(pendingTermination);
        return;
      }
      if (code !== 0 || processSignal) {
        finish(new Error("Native filesystem helper exited unexpectedly"));
        return;
      }
      finish(undefined, Buffer.concat(stdout, stdoutBytes));
    });
    child.stdin.on("error", () => terminate(new Error("Native filesystem helper input failed")));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(input.input);
  });
}

function encodeHelperRequest(
  request: Record<string, unknown>,
  rootPolicy: NativeFilesystemRootPolicy,
): Buffer {
  const encoded = Buffer.from(JSON.stringify({ ...request, rootPolicy }), "utf8");
  if (encoded.byteLength > maxHelperRequestBytes) {
    throw new Error("Native filesystem helper request exceeds its byte limit");
  }
  return encoded;
}

function executeStreamingHelper<Result extends { readonly length: number }>(input: {
  readonly binary: string;
  readonly input: Buffer;
  readonly resultSchema: z.ZodType<Result>;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<{ readonly metadata: Result; readonly stream: Readable }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, [], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const headerChunks: Buffer[] = [];
    let headerBytes = 0;
    let headerSettled = false;
    let body: Transform | undefined;
    let bodyBytes = 0;
    let stderrBytes = 0;
    let terminated = false;
    let idleTimer: NodeJS.Timeout;

    const cleanup = (): void => {
      clearTimeout(idleTimer);
      input.signal.removeEventListener("abort", abort);
    };
    const rejectBeforeHeader = (error: Error): void => {
      if (headerSettled) {
        body?.destroy(error);
        return;
      }
      headerSettled = true;
      reject(error);
    };
    const terminate = (error: Error): void => {
      if (terminated) return;
      terminated = true;
      child.kill("SIGKILL");
      rejectBeforeHeader(error);
    };
    const refreshIdleTimeout = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => terminate(new Error("Native filesystem helper stream timed out")),
        input.timeoutMilliseconds,
      );
      idleTimer.unref();
    };
    const abort = (): void =>
      terminate(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Native filesystem operation was aborted"),
      );
    const beginBody = (line: Buffer, remainder: Buffer): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8"));
      } catch {
        terminate(new Error("Native filesystem helper returned an invalid stream header"));
        return;
      }
      let envelope: z.infer<typeof ResponseEnvelopeSchema>;
      try {
        envelope = ResponseEnvelopeSchema.parse(parsed);
      } catch {
        terminate(new Error("Native filesystem helper returned an invalid stream envelope"));
        return;
      }
      const expected = expectedNativePlatform();
      if (
        envelope.containment !== expected.containment ||
        envelope.platform !== expected.platform
      ) {
        terminate(new Error("Native filesystem containment is unavailable on this platform"));
        return;
      }
      if (!envelope.ok) {
        terminate(new NativeFsHelperError(envelope.error.code, envelope.error.message));
        return;
      }
      let metadata: Result;
      try {
        metadata = input.resultSchema.parse(envelope.result);
      } catch {
        terminate(new Error("Native filesystem helper returned invalid stream metadata"));
        return;
      }
      child.stdout.pause();
      child.stdout.removeListener("data", readHeader);
      body = new Transform({
        destroy(error, callback) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          callback(error);
        },
        transform(chunk: Buffer, _encoding, callback) {
          bodyBytes += chunk.byteLength;
          if (bodyBytes > metadata.length) {
            callback(new Error("Native filesystem helper stream exceeds its declared length"));
            child.kill("SIGKILL");
            return;
          }
          callback(null, chunk);
        },
        flush(callback) {
          callback(
            bodyBytes === metadata.length
              ? undefined
              : new Error("Native filesystem helper stream ended before its declared length"),
          );
        },
      });
      headerSettled = true;
      resolve({ metadata, stream: body });
      if (remainder.byteLength > 0) body.write(remainder);
      child.stdout.pipe(body, { end: false });
      child.stdout.on("data", refreshIdleTimeout);
      child.stdout.resume();
    };
    const readHeader = (chunk: Buffer): void => {
      refreshIdleTimeout();
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        headerBytes += chunk.byteLength;
        if (headerBytes > 64 * 1_024) {
          terminate(new Error("Native filesystem helper stream header exceeds its byte limit"));
          return;
        }
        headerChunks.push(chunk);
        return;
      }
      const prefix = chunk.subarray(0, newline);
      headerBytes += prefix.byteLength;
      if (headerBytes > 64 * 1_024) {
        terminate(new Error("Native filesystem helper stream header exceeds its byte limit"));
        return;
      }
      headerChunks.push(prefix);
      beginBody(Buffer.concat(headerChunks, headerBytes), chunk.subarray(newline + 1));
    };

    refreshIdleTimeout();
    child.once("error", () =>
      terminate(new Error("Native filesystem helper could not be started")),
    );
    child.stdout.on("data", readHeader);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxHelperStderrBytes) {
        terminate(new Error("Native filesystem helper stderr exceeds its byte limit"));
      }
    });
    child.once("close", (code, processSignal) => {
      cleanup();
      if (!headerSettled) {
        rejectBeforeHeader(new Error("Native filesystem helper exited before stream metadata"));
        return;
      }
      if (code !== 0 || processSignal || terminated) {
        body?.destroy(new Error("Native filesystem helper stream exited unexpectedly"));
        return;
      }
      body?.end();
    });
    child.stdin.on("error", () => terminate(new Error("Native filesystem helper input failed")));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(input.input);
  });
}

async function assertTrustedHelperExecutable(binary: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(binary);
  } catch {
    throw new Error("Native filesystem helper executable is unavailable");
  }
  const processUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o111) === 0) ||
    (process.platform !== "win32" && (stat.mode & 0o022) !== 0) ||
    (process.platform !== "win32" &&
      processUid !== undefined &&
      stat.uid !== 0 &&
      stat.uid !== processUid)
  ) {
    throw new Error("Native filesystem helper executable is not trusted");
  }
}
