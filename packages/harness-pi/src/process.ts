import { safeMessage } from "@opensteer/shared/safeMessage";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { OpensteerError } from "@opensteer/core";
import { finished } from "node:stream/promises";
import {
  collectStreamText,
  spawnSupervised,
  type HarnessProcessLaunchWrapper,
} from "@opensteer/harness";
import type { PiHarnessConfig } from "./config.js";
import {
  PiLineFramer,
  isResponse,
  optionalString,
  parsePiMessage,
  protocolError,
  type JsonObject,
  type PiMessage,
} from "./protocol.js";

interface PendingCommand {
  readonly command: string;
  readonly reject: (error: unknown) => void;
  readonly resolve: (message: PiMessage) => void;
  timeout?: NodeJS.Timeout;
}

export interface PiLaunch {
  /** The Runner's own verified Node, never `process.execPath`: the desktop app hosts the Runner inside Electron. */
  readonly nodeExecutable: string;
  /** The staged `dist/bundle/cli.js` the catalog's `script` runtime names. */
  readonly executable: string;
}

export interface PiRpcClientOptions {
  readonly args: readonly string[];
  readonly config: PiHarnessConfig;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly launch: PiLaunch;
  readonly onEvent: (event: PiMessage) => void;
  readonly onFailure: (error: OpensteerError) => void;
  readonly signal: AbortSignal;
  /**
   * Present only for a Run's own Pi process. Sign-in, sign-out, inspection and
   * the catalog read run Runner-side and are never wrapped.
   */
  readonly wrapProcessLaunch?: HarnessProcessLaunchWrapper;
}

/**
 * One `pi --mode rpc` process, framed the way Pi documents it.
 *
 * Pi has no handshake: the process is usable the moment it is spawned and the
 * first command's response proves it (pi-facts §1 measured 176 ms from spawn to
 * the first response). What has to be watched for instead is Pi's one silent
 * failure: resuming a session recorded under another working directory makes it
 * print a y/N fork prompt on **stderr** and exit **0** with no protocol output
 * at all (pi-facts §1, §3, risk 5). `exitedWithoutProtocolOutput` is that exact
 * signature, and the driver turns it into a hard failure rather than a fork.
 */
export class PiRpcClient {
  readonly #config: PiHarnessConfig;
  readonly #onEvent: PiRpcClientOptions["onEvent"];
  readonly #onFailure: PiRpcClientOptions["onFailure"];
  readonly #pending = new Map<string, PendingCommand>();
  readonly #process: ReturnType<typeof spawnSupervised>;
  readonly #secrets: readonly string[];
  readonly #stdoutTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #abortSignal: AbortSignal;
  #abortListener: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #failure: OpensteerError | undefined;
  #nextCommandId = 1;
  #protocolLines = 0;
  #queuedWriteBytes = 0;
  #stderr = "";
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(options: PiRpcClientOptions) {
    this.#config = options.config;
    this.#onEvent = options.onEvent;
    this.#onFailure = options.onFailure;
    this.#abortSignal = options.signal;
    this.#secrets = Object.entries(options.environment)
      .filter(([name, value]) => credentialNamePattern.test(name) && value.length >= 8)
      .map(([, value]) => value)
      .sort((left, right) => right.length - left.length);
    const launch = {
      args: [options.launch.executable, "--mode", "rpc", ...options.args],
      cwd: options.cwd,
      environment: options.environment,
      executable: options.launch.nodeExecutable,
    };
    // The wrapper runs last so the Runner's sandbox sees the complete command:
    // every provider flag, the working directory, and the environment it must
    // carry into the sandbox are already in place.
    const wrapped = options.wrapProcessLaunch ? options.wrapProcessLaunch(launch) : launch;
    this.#process = spawnSupervised({
      args: wrapped.args,
      cwd: wrapped.cwd,
      environment: wrapped.environment,
      executable: wrapped.executable,
      // Bounds what stderr may retain. The protocol stream is read from the
      // child directly instead of through this budget: silently dropping
      // protocol bytes past a byte count would desynchronize the session.
      maxOutputBytes: options.config.maxStderrBytes,
    });
    this.#process.child.once("error", (error) => {
      this.#fail(toPiProcessError(error, "Pi process error"));
    });
    void this.#process.exited.then(({ code, signal }) => {
      if (this.#closing || this.#failure) return;
      this.#fail(
        new OpensteerError({
          code: "harness_error",
          details: {
            code,
            protocolLines: this.#protocolLines,
            signal,
            ...(this.stderrText() ? { stderr: this.stderrDiagnostic() } : {}),
          },
          message: `Pi exited unexpectedly (${formatExit(code, signal)})`,
        }),
      );
    });
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = this.#readStderr();
    if (options.signal.aborted) void this.close(0);
    else {
      this.#abortListener = () => void this.close();
      options.signal.addEventListener("abort", this.#abortListener, { once: true });
    }
  }

  static start(options: PiRpcClientOptions): PiRpcClient {
    return new PiRpcClient(options);
  }

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  /** The cwd/session mismatch signature: a clean exit that never spoke the protocol. */
  get exitedWithoutProtocolOutput(): boolean {
    return this.#protocolLines === 0 && this.#process.child.exitCode === 0;
  }

  get exited(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
    return this.#process.exited;
  }

  stderrText(): string {
    return this.#stderr.trim();
  }

  stderrDiagnostic(): string {
    let stderr = this.stderrText();
    if (!stderr) return "";
    for (const secret of this.#secrets) stderr = stderr.replaceAll(secret, "[REDACTED]");
    return safeMessage(new Error(stderr), stderrSafeMessageOptions);
  }

  /**
   * Sends one command and resolves with Pi's `response` line. A `success:false`
   * response is a refusal the caller usually has to read (a model that is not
   * available, a prompt sent while the agent is streaming), so it is returned
   * rather than thrown; `requireOk` turns it into an error where a refusal has
   * no meaning.
   */
  async command(
    type: string,
    params: JsonObject = {},
    timeoutMs: number | null = this.#config.requestTimeoutMs,
  ): Promise<PiMessage> {
    this.#assertUsable();
    const id = `os-${this.#nextCommandId}`;
    this.#nextCommandId += 1;
    let pending: PendingCommand | undefined;
    const response = new Promise<PiMessage>((resolve, reject) => {
      pending = { command: type, reject, resolve };
      if (timeoutMs !== null) {
        const timeout = setTimeout(() => {
          if (this.#pending.get(id) !== pending) return;
          this.#fail(
            new OpensteerError({
              code: "timeout",
              details: { command: type, timeoutMs },
              message: `Pi did not answer ${type} within ${timeoutMs}ms`,
              retryable: true,
            }),
          );
        }, timeoutMs);
        timeout.unref?.();
        pending.timeout = timeout;
      }
      this.#pending.set(id, pending);
    });
    try {
      await this.send({ ...params, id, type });
    } catch (error) {
      const current = this.#pending.get(id);
      if (current) {
        if (current.timeout) clearTimeout(current.timeout);
        this.#pending.delete(id);
        current.reject(error);
      }
    }
    return response;
  }

  /** The same, for a command whose refusal the driver has no way to act on. */
  async requireOk(
    type: string,
    params: JsonObject = {},
    timeoutMs: number | null = this.#config.requestTimeoutMs,
  ): Promise<PiMessage> {
    const response = await this.command(type, params, timeoutMs);
    if (response.success !== true) {
      throw protocolError(`Pi refused ${type}: ${optionalString(response.error) ?? "no reason"}`);
    }
    return response;
  }

  /** Writes one client message that expects no response (`extension_ui_response`). */
  async send(message: JsonObject): Promise<void> {
    this.#assertUsable();
    const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (data.byteLength > this.#config.maxProtocolLineBytes) {
      const error = protocolError(
        `Outbound Pi message exceeded ${this.#config.maxProtocolLineBytes} bytes`,
      );
      this.#fail(error);
      throw error;
    }
    if (this.#queuedWriteBytes + data.byteLength > this.#config.maxWriteBufferBytes) {
      const error = protocolError(
        `Pi write buffer exceeded ${this.#config.maxWriteBufferBytes} bytes`,
      );
      this.#fail(error);
      throw error;
    }
    this.#queuedWriteBytes += data.byteLength;
    const write = this.#writeTail.then(async () => {
      this.#assertUsable();
      await this.#writeBuffer(data);
    });
    this.#writeTail = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      const failure = toPiProcessError(error, "Failed to write to Pi");
      this.#fail(failure);
      throw failure;
    } finally {
      this.#queuedWriteBytes -= data.byteLength;
    }
  }

  /**
   * Waits for Pi to exit. Closing stdin is Pi's documented graceful shutdown
   * and it exits 0; the supervisor's process-group termination is the fallback
   * for a process that ignores it (pi-facts §12).
   */
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
      new OpensteerError({ code: "harness_error", message: "Pi RPC connection closed" }),
    );
    const stdin = this.#process.child.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
    if (graceMs > 0) {
      await Promise.race([
        this.#process.exited,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        }),
      ]);
    }
    await this.#process.terminate(0);
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask, this.#writeTail]);
  }

  async #readStdout(): Promise<void> {
    const stdout = this.#process.child.stdout;
    if (!stdout) return;
    try {
      const framer = new PiLineFramer(this.#config.maxProtocolLineBytes, isRunEcho);
      for await (const chunk of stdout) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        for (const line of framer.push(buffer)) this.#processLine(line);
      }
      const trailing = framer.finish();
      if (trailing) this.#processLine(trailing);
    } catch (error) {
      this.#fail(toPiProcessError(error, "Pi stdout failed"));
    }
  }

  async #readStderr(): Promise<void> {
    try {
      for await (const chunk of this.#process.stderr) {
        this.#stderr += chunk.toString("utf8");
      }
    } catch (error) {
      this.#fail(toPiProcessError(error, "Pi stderr failed"));
    }
  }

  #processLine(line: Buffer): void {
    let message: PiMessage;
    try {
      message = parsePiMessage(line);
    } catch (error) {
      this.#fail(toPiProcessError(error, "Pi emitted an unreadable protocol line"));
      return;
    }
    this.#protocolLines += 1;
    if (isResponse(message)) {
      const id = optionalString(message.id);
      if (!id) {
        this.#fail(protocolError("Pi answered a command without echoing its id"));
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        this.#fail(protocolError(`Pi answered an unknown command id ${id}`));
        return;
      }
      this.#pending.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve(message);
      return;
    }
    try {
      this.#onEvent(message);
    } catch (error) {
      this.#fail(toPiProcessError(error, "Pi event handling failed"));
    }
  }

  async #writeBuffer(data: Buffer): Promise<void> {
    const stdin = this.#process.child.stdin;
    if (!stdin) throw new Error("Pi stdin is unavailable");
    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #assertUsable(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing) {
      throw new OpensteerError({ code: "harness_error", message: "Pi RPC connection is closing" });
    }
  }

  #fail(error: OpensteerError): void {
    if (this.#failure || this.#closing) return;
    this.#failure = error;
    this.#rejectPending(error);
    try {
      this.#onFailure(error);
    } finally {
      void this.#process.terminate(0);
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
}

/**
 * Runs one short-lived Pi process to completion and returns what it printed.
 * Inspection, the catalog read and the version check all need exactly this and
 * nothing of the session machinery.
 */
export async function runPiCommand(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly launch: PiLaunch;
  readonly maxOutputBytes?: number;
  readonly signal: AbortSignal;
  /** Written to the process before its stdin is closed; a one-shot RPC command. */
  readonly stdin?: string;
  readonly timeoutMs: number;
}): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  const supervised = spawnSupervised({
    args: [options.launch.executable, ...options.args],
    cwd: options.cwd,
    environment: options.environment,
    executable: options.launch.nodeExecutable,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1_024 * 1_024,
    signal: lifetime.signal,
  });
  const stdinClosed = finished(supervised.child.stdin, { readable: false }).catch(
    (error: unknown) => {
      // A one-shot inspection can exit without reading stdin. With no input to
      // deliver, that broken pipe leaves the command's output and status intact.
      if (
        (options.stdin === undefined || options.stdin === "") &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPIPE"
      )
        return;
      throw toPiProcessError(error, "Pi stdin could not be closed");
    },
  );
  try {
    supervised.child.stdin.end(options.stdin ?? "");
    const [stdout, stderr, exit] = await withTimeout(
      Promise.all([
        collectStreamText(supervised.stdout),
        collectStreamText(supervised.stderr),
        supervised.exited.catch((error: unknown) => {
          throw toPiProcessError(error, "Pi could not be started");
        }),
        stdinClosed,
      ]),
      options.timeoutMs,
      {
        timeoutError: () =>
          new OpensteerError({
            code: "timeout",
            message: `Pi did not finish within ${options.timeoutMs}ms`,
            retryable: true,
          }),
      },
    );
    return { code: exit.code, stderr, stdout };
  } finally {
    options.signal.removeEventListener("abort", abort);
    await supervised.terminate(0).catch(() => undefined);
  }
}

const credentialNamePattern =
  /(?:API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/iu;

const stderrSafeMessageOptions = {
  fallback: "Pi stderr was unavailable",
  maximumLength: 8_000,
  redactions: [
    { pattern: /Bearer\s+\S+/giu, replacement: "Bearer [REDACTED]" },
    { pattern: /os_secret_[A-Za-z0-9_-]+/gu, replacement: "[OPAQUE_CREDENTIAL]" },
  ],
} as const;

/**
 * Not the shared normalization: a launch that cannot find the staged Pi tree is
 * the one process failure the driver reports as a missing install rather than
 * as a harness fault, because inspection turns `not_found` into "unavailable".
 */
export function toPiProcessError(error: unknown, fallback: string): OpensteerError {
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

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return "unknown status";
}

/**
 * `agent_end` repeats every message of the run, images included, which the
 * driver has already received one by one and never reads again. It alone may
 * outgrow the line bound: a run's prompt and steers each fill their own line.
 */
function isRunEcho(head: Buffer): boolean {
  return head.toString("latin1").startsWith('{"type":"agent_end"');
}
