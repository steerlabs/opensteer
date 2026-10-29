import type { PrivateFilesystem } from "@opensteer/client/connections";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const helperBinaryVersion = "1.6.0";
const maxRequestBytes = 3 * 1_024 * 1_024;
const maxResponseBytes = 3 * 1_024 * 1_024;
const maxStderrBytes = 64 * 1_024;
const defaultTimeoutMilliseconds = 30_000;
export const maxDesktopPrivateFileBytes = 1 * 1_024 * 1_024;

const NativeDirectoryIdentitySchema = z.strictObject({
  fileId: z.string().regex(/^(?:0|[1-9][0-9]*|[a-f0-9]{32})$/u),
  kind: z.enum(["posix", "windows"]),
  volumeId: z.string().regex(/^(0|[1-9][0-9]*)$/u),
});
export type NativeDesktopPrivateRootIdentity = z.infer<typeof NativeDirectoryIdentitySchema>;

const ContainmentSchema = z.enum([
  "linux-openat2",
  "posix-openat-nofollow",
  "windows-nt-relative-noreparse",
]);
const PlatformSchema = z.enum(["darwin", "linux", "windows"]);
const ResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    binaryIdentity: z.literal("opensteer-native-fs"),
    binaryVersion: z.literal(helperBinaryVersion),
    containment: ContainmentSchema,
    error: z.strictObject({
      code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      message: z.string().min(1).max(500),
    }),
    ok: z.literal(false),
    platform: PlatformSchema,
  }),
  z.strictObject({
    binaryIdentity: z.literal("opensteer-native-fs"),
    binaryVersion: z.literal(helperBinaryVersion),
    containment: ContainmentSchema,
    ok: z.literal(true),
    platform: PlatformSchema,
    result: z.unknown(),
  }),
]);
const RootResultSchema = z.strictObject({
  created: z.boolean(),
  identity: NativeDirectoryIdentitySchema,
});
const MutationResultSchema = z.strictObject({ changed: z.boolean() });
const ReadResultSchema = z.strictObject({
  contentBase64: z.string().max(3_000_000),
  size: z.number().int().nonnegative().max(maxDesktopPrivateFileBytes),
});
const EmptyResultSchema = z.strictObject({ empty: z.boolean() });

export class DesktopPrivateFilesystemError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopPrivateFilesystemError";
    this.code = code;
  }
}

/**
 * The shared `PrivateFilesystem` port, plus the two operations only this
 * application has: the containment root identity the helper binary verifies
 * every call against, and the synchronous variant startup needs before
 * Electron may create helper processes.
 */
export interface DesktopPrivateFilesystem extends PrivateFilesystem {
  readonly rootIdentity: NativeDesktopPrivateRootIdentity;
  ensureDirectorySync(path: string): void;
  readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null>;
}

export function openDesktopPrivateFilesystemSync(options: {
  readonly binary: string;
  readonly root: string;
  readonly timeoutMs?: number;
}): DesktopPrivateFilesystem {
  const root = resolve(options.root);
  if (!isAbsolute(options.binary) || !isAbsolute(root)) {
    throw new TypeError("Desktop private filesystem requires absolute helper and root paths.");
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMilliseconds;
  const initialized = RootResultSchema.parse(
    invokeSync(
      options.binary,
      { operation: "desktop-ensure-root", root, rootPolicy: "desktop-private" },
      timeoutMs,
    ),
  );
  return new NativeDesktopPrivateFilesystem({
    binary: options.binary,
    root,
    rootIdentity: initialized.identity,
    timeoutMs,
  });
}

export async function openDesktopPrivateFilesystem(options: {
  readonly binary: string;
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<DesktopPrivateFilesystem> {
  const root = resolve(options.root);
  if (!isAbsolute(options.binary) || !isAbsolute(root)) {
    throw new TypeError("Desktop private filesystem requires absolute helper and root paths.");
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMilliseconds;
  const initialized = RootResultSchema.parse(
    await invoke(
      options.binary,
      { operation: "desktop-ensure-root", root, rootPolicy: "desktop-private" },
      timeoutMs,
      options.signal,
    ),
  );
  return new NativeDesktopPrivateFilesystem({
    binary: options.binary,
    root,
    rootIdentity: initialized.identity,
    timeoutMs,
  });
}

class NativeDesktopPrivateFilesystem implements DesktopPrivateFilesystem {
  readonly #binary: string;
  readonly root: string;
  readonly rootIdentity: NativeDesktopPrivateRootIdentity;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly binary: string;
    readonly root: string;
    readonly rootIdentity: NativeDesktopPrivateRootIdentity;
    readonly timeoutMs: number;
  }) {
    this.#binary = options.binary;
    this.root = options.root;
    this.rootIdentity = NativeDirectoryIdentitySchema.parse(options.rootIdentity);
    this.#timeoutMs = options.timeoutMs;
  }

  async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    MutationResultSchema.parse(
      await this.#invoke("desktop-ensure-directory", this.#relative(path, true), {}, signal),
    );
  }

  ensureDirectorySync(path: string): void {
    MutationResultSchema.parse(
      invokeSync(
        this.#binary,
        {
          expectedRootIdentity: this.rootIdentity,
          operation: "desktop-ensure-directory",
          path: this.#relative(path, true),
          root: this.root,
          rootPolicy: "desktop-private",
        },
        this.#timeoutMs,
      ),
    );
  }

  async readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
    boundedFileBytes(maxBytes);
    try {
      const result = ReadResultSchema.parse(
        await this.#invoke("desktop-read-file", this.#relative(path), { maxBytes }, signal),
      );
      const content = Buffer.from(result.contentBase64, "base64");
      if (content.byteLength !== result.size) {
        throw new Error("Desktop private filesystem returned inconsistent file content.");
      }
      return content;
    } catch (error) {
      if (error instanceof DesktopPrivateFilesystemError && error.code === "not-found") {
        return null;
      }
      throw error;
    }
  }

  async fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = MutationResultSchema.parse(
      await this.#invoke("desktop-file-exists", this.#relative(path), {}, signal),
    );
    return result.changed;
  }

  async writeFileExclusive(
    path: string,
    content: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#write("desktop-create-file", path, content, signal);
  }

  async writeFileAtomic(
    path: string,
    content: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#write("desktop-replace-file", path, content, signal);
  }

  async removeFile(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = MutationResultSchema.parse(
      await this.#invoke("desktop-remove-file", this.#relative(path), {}, signal),
    );
    return result.changed;
  }

  async directoryEmpty(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = EmptyResultSchema.parse(
      await this.#invoke("desktop-directory-empty", this.#relative(path, true), {}, signal),
    );
    return result.empty;
  }

  async #write(
    operation: "desktop-create-file" | "desktop-replace-file",
    path: string,
    value: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    const content = bufferOf(value);
    boundedFileBytes(content.byteLength);
    MutationResultSchema.parse(
      await this.#invoke(
        operation,
        this.#relative(path),
        { content: content.toString("base64") },
        signal,
      ),
    );
  }

  #invoke(
    operation: string,
    path: string,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return invoke(
      this.#binary,
      {
        ...input,
        expectedRootIdentity: this.rootIdentity,
        operation,
        path,
        root: this.root,
        rootPolicy: "desktop-private",
      },
      this.#timeoutMs,
      signal,
    );
  }

  #relative(candidate: string, allowRoot = false): string {
    const resolved = resolve(candidate);
    const value = relative(this.root, resolved);
    if (value === "" && allowRoot) return ".";
    if (
      value === "" ||
      value === ".." ||
      value.startsWith(`..${sep}`) ||
      isAbsolute(value) ||
      value.includes("\0")
    ) {
      throw new Error("Desktop private path is outside its initialized root.");
    }
    return value.split(sep).join("/");
  }
}

async function invoke(
  binary: string,
  request: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const serialized = Buffer.from(JSON.stringify(request), "utf8");
  if (serialized.byteLength > maxRequestBytes) {
    throw new Error("Desktop private filesystem request exceeds its byte limit.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Desktop private filesystem helper timed out.")),
    timeoutMs,
  );
  timeout.unref?.();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const result = await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const child = spawn(binary, [], {
        env: {},
        shell: false,
        signal: controller.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        child.kill();
        rejectPromise(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxResponseBytes) {
          fail(new Error("Desktop private filesystem response exceeds its byte limit."));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= maxStderrBytes) stderr.push(chunk);
      });
      child.once("error", (error) => fail(error));
      child.once("close", (code, closeSignal) => {
        if (failed) return;
        if (controller.signal.aborted) {
          fail(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("Desktop private filesystem request was cancelled."),
          );
          return;
        }
        if (code !== 0) {
          fail(
            new Error(
              `Desktop private filesystem helper failed (${closeSignal ?? `exit ${String(code)}`}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
          return;
        }
        try {
          const envelope = ResponseEnvelopeSchema.parse(
            JSON.parse(Buffer.concat(stdout).toString("utf8")),
          );
          if (!envelope.ok) {
            rejectPromise(
              new DesktopPrivateFilesystemError(envelope.error.code, envelope.error.message),
            );
            return;
          }
          resolvePromise(envelope.result);
        } catch (error) {
          rejectPromise(
            new Error("Desktop private filesystem helper returned an invalid response.", {
              cause: error,
            }),
          );
        }
      });
      child.stdin.on("error", (error) => fail(error));
      child.stdin.end(serialized);
    });
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function invokeSync(
  binary: string,
  request: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): unknown {
  const serialized = Buffer.from(JSON.stringify(request), "utf8");
  if (serialized.byteLength > maxRequestBytes) {
    throw new Error("Desktop private filesystem request exceeds its byte limit.");
  }
  const result = spawnSync(binary, [], {
    encoding: "buffer",
    env: {},
    input: serialized,
    killSignal: "SIGKILL",
    maxBuffer: maxResponseBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error("Desktop private filesystem helper timed out.", { cause: result.error });
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.subarray(0, maxStderrBytes).toString("utf8").trim();
    throw new Error(
      `Desktop private filesystem helper failed (${result.signal ?? `exit ${String(result.status)}`}): ${stderr}`,
    );
  }
  try {
    const envelope = ResponseEnvelopeSchema.parse(JSON.parse(result.stdout.toString("utf8")));
    if (!envelope.ok) {
      throw new DesktopPrivateFilesystemError(envelope.error.code, envelope.error.message);
    }
    return envelope.result;
  } catch (error) {
    if (error instanceof DesktopPrivateFilesystemError) throw error;
    throw new Error("Desktop private filesystem helper returned an invalid response.", {
      cause: error,
    });
  }
}

function bufferOf(value: Uint8Array | string): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function boundedFileBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxDesktopPrivateFileBytes) {
    throw new TypeError("Desktop private file byte bound is invalid.");
  }
  return value;
}
