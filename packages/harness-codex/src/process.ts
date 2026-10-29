import { safeMessage } from "@opensteer/shared/safeMessage";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { delay } from "@opensteer/shared/delay";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OpensteerError } from "@opensteer/core";
import {
  spawnSupervised,
  type SupervisedProcess,
  type HarnessProcessLaunchWrapper,
} from "@opensteer/harness";
import type { CodexLaunch } from "./codex-driver.js";
import type { CodexHarnessConfig } from "./config.js";
import {
  isMethodMessage,
  isResponseMessage,
  parseCodexMessage,
  protocolError,
  requestKey,
  requireObject,
  type CodexMethodMessage,
  type CodexResponseMessage,
  type JsonObject,
  type JsonRpcId,
} from "./protocol.js";

interface PendingRequest {
  readonly method: string;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: unknown) => void;
  readonly timeout?: NodeJS.Timeout;
}

export interface CodexStdioClientOptions {
  readonly appServerArgs?: readonly string[];
  readonly config: CodexHarnessConfig;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly launch: CodexLaunch;
  readonly onFailure: (error: OpensteerError) => void;
  readonly onMethodMessage: (message: CodexMethodMessage) => void;
  readonly signal: AbortSignal;
  /**
   * Present only for a Run's own app-server. Sign-in, sign-out, and inspection
   * run Runner-side and are never wrapped.
   */
  readonly wrapProcessLaunch?: HarnessProcessLaunchWrapper;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class CodexStdioClient {
  readonly #abortSignal: AbortSignal;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #process: SupervisedProcess;
  readonly #config: CodexHarnessConfig;
  readonly #exit: Promise<ProcessExit>;
  readonly #onFailure: CodexStdioClientOptions["onFailure"];
  readonly #onMethodMessage: CodexStdioClientOptions["onMethodMessage"];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #spawned: Promise<void>;
  readonly #stderr: ByteTail;
  readonly #stderrSecrets: readonly string[];
  readonly #stdoutTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  #closing = false;
  #abortListener: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #failure: OpensteerError | undefined;
  #nextRequestId = 1;
  #queuedWriteBytes = 0;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(options: CodexStdioClientOptions) {
    this.#abortSignal = options.signal;
    this.#config = options.config;
    this.#onFailure = options.onFailure;
    this.#onMethodMessage = options.onMethodMessage;
    this.#stderr = new ByteTail(options.config.maxStderrBytes);
    this.#stderrSecrets = Object.entries(options.environment)
      .filter(([name, value]) => credentialNamePattern.test(name) && value.length >= 4)
      .map(([, value]) => value)
      .sort((left, right) => right.length - left.length);
    const launch = {
      args: [
        ...options.launch.arguments,
        ...(options.appServerArgs ?? []),
        "app-server",
        "--stdio",
      ],
      cwd: options.cwd,
      environment: options.environment,
      executable: options.launch.executable,
    };
    // The wrapper runs last so the Runner's sandbox sees the complete command:
    // every provider flag, the working directory, and the environment it must
    // carry into the sandbox are already in place.
    const wrapped = options.wrapProcessLaunch ? options.wrapProcessLaunch(launch) : launch;
    this.#process = spawnSupervised({
      executable: wrapped.executable,
      args: wrapped.args,
      cwd: wrapped.cwd,
      environment: wrapped.environment,
    });
    this.#child = this.#process.child;

    this.#spawned = new Promise<void>((resolve, reject) => {
      this.#child.once("spawn", resolve);
      this.#child.once("error", reject);
    });
    this.#exit = new Promise<ProcessExit>((resolve) => {
      this.#child.once("close", (code, signal) => {
        resolve({ code, signal });
        if (this.#closing || this.#failure) return;
        const stderr = this.#stderrDiagnostic();
        this.#fail(
          new OpensteerError({
            code: "harness_error",
            details: { code, signal, ...(stderr ? { stderr } : {}) },
            message: `Codex app-server exited unexpectedly (${formatExit(code, signal)})`,
          }),
        );
      });
    });
    this.#child.on("error", (error) => {
      this.#fail(toCodexProcessError(error, "Codex app-server process error"));
    });
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = this.#readStderr();
    if (options.signal.aborted) void this.close(0);
    else {
      this.#abortListener = () => void this.close();
      options.signal.addEventListener("abort", this.#abortListener, { once: true });
    }
  }

  static async start(options: CodexStdioClientOptions): Promise<CodexStdioClient> {
    for (const name of ["CODEX_HOME", "CODEX_SQLITE_HOME"] as const) {
      const configuredHome = options.environment[name];
      if (configuredHome) {
        await mkdir(resolve(options.cwd, configuredHome), { mode: 0o700, recursive: true });
      }
    }
    const client = new CodexStdioClient(options);
    try {
      await withTimeout(client.#spawned, options.config.startupTimeoutMs, {
        timeoutError: () =>
          new OpensteerError({
            code: "timeout",
            message: "Timed out while spawning Codex app-server",
            retryable: true,
          }),
      });
      client.#assertUsable();
      return client;
    } catch (error) {
      client.#fail(toCodexProcessError(error, "Failed to spawn Codex app-server"));
      await client.close(0);
      throw client.#failure ?? error;
    }
  }

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  stderrText(): string {
    return this.#stderr.toBuffer().toString("utf8").trim();
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.#config.requestTimeoutMs,
  ): Promise<unknown> {
    return await this.#request(method, params, timeoutMs);
  }

  /** Waits for provider startup under the client's lifecycle instead of an RPC deadline. */
  async lifecycleRequest(method: string, params: unknown): Promise<unknown> {
    return await this.#request(method, params);
  }

  async #request(method: string, params: unknown, timeoutMs?: number | null): Promise<unknown> {
    this.#assertUsable();
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = requestKey(id);
    let pending: PendingRequest | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout =
        timeoutMs === undefined || timeoutMs === null
          ? undefined
          : setTimeout(() => {
              const current = this.#pending.get(key);
              if (current !== pending) return;
              const stderr = this.#stderrDiagnostic();
              const error = new OpensteerError({
                code: "timeout",
                details: { method, timeoutMs, ...(stderr ? { stderr } : {}) },
                message: `Codex app-server request ${method} timed out after ${timeoutMs}ms`,
                retryable: true,
              });
              this.#fail(error);
            }, timeoutMs);
      timeout?.unref();
      pending = { method, reject, resolve, ...(timeout ? { timeout } : {}) };
      this.#pending.set(key, pending);
    });

    try {
      await this.#write({ id, method, params });
    } catch (error) {
      const current = this.#pending.get(key);
      if (current) {
        if (current.timeout) clearTimeout(current.timeout);
        this.#pending.delete(key);
        current.reject(error);
      }
    }
    return response;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.#assertUsable();
    await this.#write({ method, params });
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.#assertUsable();
    await this.#write({ id, result });
  }

  async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    this.#assertUsable();
    await this.#write({
      error: { code, ...(data === undefined ? {} : { data }), message },
      id,
    });
  }

  close(graceMs = this.#config.shutdownGraceMs): Promise<void> {
    this.#closePromise ??= this.#close(graceMs);
    return this.#closePromise;
  }

  async #close(graceMs: number): Promise<void> {
    this.#closing = true;
    if (this.#abortListener) {
      this.#abortSignal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = undefined;
    }
    this.#rejectPending(
      new OpensteerError({ code: "harness_error", message: "Codex app-server connection closed" }),
    );
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    if (graceMs > 0) await Promise.race([this.#exit, delay(graceMs)]);
    await this.#process.terminate(graceMs === 0 ? 0 : 2_000);
    await this.#process.exited;
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask, this.#writeTail]);
  }

  async #readStdout(): Promise<void> {
    try {
      const framer = new JsonLineFramer(this.#config.maxProtocolLineBytes);
      for await (const chunk of this.#child.stdout) {
        for (const line of framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          this.#processLine(line);
        }
      }
      const finalLine = framer.finish();
      if (finalLine) this.#processLine(finalLine);
    } catch (error) {
      this.#fail(toCodexProcessError(error, "Codex app-server stdout failed"));
    }
  }

  async #readStderr(): Promise<void> {
    try {
      for await (const chunk of this.#child.stderr) {
        this.#stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (error) {
      this.#fail(toCodexProcessError(error, "Codex app-server stderr failed"));
    }
  }

  #processLine(line: Buffer): void {
    const message = parseCodexMessage(line);
    if (isMethodMessage(message)) {
      this.#onMethodMessage(message);
      return;
    }
    if (isResponseMessage(message)) this.#resolveResponse(message);
  }

  #resolveResponse(message: CodexResponseMessage): void {
    const key = requestKey(message.id);
    const pending = this.#pending.get(key);
    if (!pending) throw protocolError(`Codex app-server returned an unknown response id ${key}`);
    this.#pending.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);
    if ("error" in message && message.error !== undefined) {
      pending.reject(rpcError(pending.method, message.error));
      return;
    }
    pending.resolve(message.result);
  }

  async #write(message: JsonObject): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (data.byteLength > this.#config.maxProtocolLineBytes) {
      const error = protocolError(
        `Outbound Codex app-server message exceeded ${this.#config.maxProtocolLineBytes} bytes`,
      );
      this.#fail(error);
      throw error;
    }
    if (this.#queuedWriteBytes + data.byteLength > this.#config.maxWriteBufferBytes) {
      const error = protocolError(
        `Codex app-server write buffer exceeded ${this.#config.maxWriteBufferBytes} bytes`,
      );
      this.#fail(error);
      throw error;
    }
    this.#queuedWriteBytes += data.byteLength;
    const write = this.#writeTail.then(async () => {
      this.#assertUsable();
      await writeBuffer(this.#child, data);
    });
    this.#writeTail = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      const harnessError = toCodexProcessError(error, "Failed to write to Codex app-server");
      this.#fail(harnessError);
      throw harnessError;
    } finally {
      this.#queuedWriteBytes -= data.byteLength;
    }
  }

  #assertUsable(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Codex app-server connection is closing",
      });
    }
  }

  #fail(error: OpensteerError): void {
    if (this.#failure || this.#closing) return;
    this.#failure = error;
    this.#rejectPending(error);
    try {
      this.#onFailure(error);
    } finally {
      void this.#process.terminate(0).catch(() => undefined);
    }
  }

  #rejectPending(error: unknown): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(error);
    }
  }

  #stderrDiagnostic(): string {
    let stderr = this.stderrText();
    if (!stderr) return "";
    for (const secret of this.#stderrSecrets) {
      stderr = stderr.replaceAll(secret, "[REDACTED]");
      const prefixEnd = stderr.search(/[\s,;]+/u);
      const prefix = prefixEnd < 0 ? stderr : stderr.slice(0, prefixEnd);
      if (prefix.length >= 4 && prefix.length < secret.length && secret.endsWith(prefix)) {
        stderr = `[REDACTED]${stderr.slice(prefix.length)}`;
      }
    }
    const redacted = safeMessage(new Error(stderr), stderrSafeMessageOptions);
    const bounded = new ByteTail(this.#config.maxStderrBytes);
    bounded.append(Buffer.from(redacted, "utf8"));
    return bounded.toBuffer().toString("utf8").trim();
  }
}

const credentialNamePattern =
  /(?:API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/iu;

const stderrSafeMessageOptions = {
  fallback: "Codex app-server stderr was unavailable",
  maximumLength: Number.MAX_SAFE_INTEGER,
  redactions: [
    { pattern: /Bearer\s+\S+/giu, replacement: "Bearer [REDACTED]" },
    { pattern: /os_secret_[A-Za-z0-9_-]+/gu, replacement: "[OPAQUE_CREDENTIAL]" },
  ],
} as const;

class JsonLineFramer {
  readonly #maxLineBytes: number;
  #fragments: Buffer[] = [];
  #pendingBytes = 0;

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        this.#append(chunk.subarray(start));
        break;
      }
      this.#append(chunk.subarray(start, newline));
      const line = this.#takeLine();
      if (line.byteLength > 0) lines.push(stripCarriageReturn(line));
      start = newline + 1;
    }
    return lines;
  }

  finish(): Buffer | undefined {
    if (this.#pendingBytes === 0) return undefined;
    return stripCarriageReturn(this.#takeLine());
  }

  #append(fragment: Buffer): void {
    if (fragment.byteLength === 0) return;
    this.#pendingBytes += fragment.byteLength;
    if (this.#pendingBytes > this.#maxLineBytes) {
      throw protocolError(`Codex app-server line exceeded ${this.#maxLineBytes} bytes`);
    }
    this.#fragments.push(fragment);
  }

  #takeLine(): Buffer {
    const line =
      this.#fragments.length === 1
        ? (this.#fragments[0] ?? Buffer.alloc(0))
        : Buffer.concat(this.#fragments, this.#pendingBytes);
    this.#fragments = [];
    this.#pendingBytes = 0;
    return line;
  }
}

class ByteTail {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.byteLength >= this.#maxBytes) {
      this.#chunks.length = 0;
      const tail = Buffer.from(chunk.subarray(chunk.byteLength - this.#maxBytes));
      this.#chunks.push(tail);
      this.#bytes = tail.byteLength;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#maxBytes) {
      const first = this.#chunks[0];
      if (!first) break;
      const excess = this.#bytes - this.#maxBytes;
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.byteLength;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#bytes);
  }
}

function stripCarriageReturn(line: Buffer): Buffer {
  return line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
}

function rpcError(method: string, value: unknown): OpensteerError {
  const object = requireObject(value, `Codex app-server ${method} error`);
  const message = typeof object.message === "string" ? object.message : "Unknown JSON-RPC error";
  const code = typeof object.code === "number" ? object.code : undefined;
  return new OpensteerError({
    code: code === -32001 ? "timeout" : "harness_error",
    details: { method, rpcCode: code, rpcData: object.data },
    message: `Codex app-server ${method} failed: ${message}`,
    retryable: code === -32001,
  });
}

/**
 * Not the shared normalization: a launch that cannot find the executable is
 * the one process failure this driver reports as a missing Codex install
 * rather than as a harness fault, because inspection turns that into
 * "unavailable" instead of an error.
 */
function toCodexProcessError(error: unknown, fallback: string): OpensteerError {
  if (error instanceof OpensteerError) return error;
  return new OpensteerError({
    cause: error,
    code:
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
        ? "not_found"
        : "harness_error",
    message: error instanceof Error ? `${fallback}: ${error.message}` : fallback,
  });
}

async function writeBuffer(child: ChildProcessWithoutNullStreams, data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return "unknown status";
}
