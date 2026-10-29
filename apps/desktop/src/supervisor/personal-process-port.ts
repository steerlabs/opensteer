import {
  processSupervisorExecutableVariable,
  writeProcessControl,
} from "@opensteer/shared/processControl";
import { ensurePrivateDirectorySync } from "@opensteer/shared/privateFiles";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import {
  encodeProcessSecrets,
  processSecretsDescriptorVariable,
} from "@opensteer/shared/processSecrets";
import { throwIfAborted } from "@opensteer/shared/throwIfAborted";
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  fchmodSync,
} from "node:fs";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

export type PersonalRuntimeComponent = "postgresql" | "host" | "runner" | "messaging";

export interface PersonalProcessSpec {
  readonly arguments: readonly string[];
  readonly component: PersonalRuntimeComponent;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  /** Kept separate so diagnostics and launch-event serialization cannot include it. */
  readonly secretEnvironment?: Readonly<Record<string, string>>;
  /**
   * Secrets delivered on the child's standard input instead of its
   * environment, for a service that reads `OPENSTEER_SECRETS_FD`: a startup
   * environment stays readable to every process of the same user for as long
   * as the child runs, and a pipe it has read to its end does not.
   */
  readonly secretInput?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface PersonalChildProcess {
  readonly pid?: number | undefined;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  /** Requests a whole-tree transition through the native containment owner. */
  terminate(mode: "force" | "graceful"): Promise<void>;
}

export interface PersonalProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface PersonalProcessPort {
  run(
    spec: PersonalProcessSpec,
    options: PersonalOneShotProcessOptions,
  ): Promise<PersonalProcessResult>;
  spawn(spec: PersonalProcessSpec): PersonalChildProcess;
}

const maximumOneShotOutputBytes = 128 * 1_024;
const maximumProcessDurationMs = 10 * 60_000;
const defaultGracefulTerminationMs = 1_000;
const defaultForceTerminationMs = 5_000;

export interface PersonalOneShotProcessOptions {
  /** The owning startup/shutdown operation. Aborting it immediately begins tree termination. */
  readonly signal: AbortSignal;
  /** Absolute deadline for the one-shot itself, excluding bounded cleanup. */
  readonly timeoutMs: number;
  readonly gracefulTerminationMs?: number;
  readonly forceTerminationMs?: number;
}

interface NodePersonalProcessPortOptions {
  /** Verified, absolute path to the bundled native containment supervisor. */
  readonly supervisorExecutable: string;
  readonly logsDirectory?: string;
}

export class PersonalProcessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Personal runtime command exceeded its ${timeoutMs}ms deadline.`);
    this.name = "PersonalProcessTimeoutError";
  }
}

export class NodePersonalProcessPort implements PersonalProcessPort {
  readonly #supervisorExecutable: string;
  readonly #logsDirectory: string | undefined;
  readonly #logs = new Map<
    PersonalRuntimeComponent,
    { log: RotatingPersonalLog; references: number }
  >();

  constructor(options: NodePersonalProcessPortOptions) {
    if (!path.isAbsolute(options.supervisorExecutable)) {
      throw new TypeError("Personal process supervisor path must be absolute.");
    }
    this.#supervisorExecutable = path.resolve(options.supervisorExecutable);
    this.#logsDirectory = options.logsDirectory;
  }

  async run(
    spec: PersonalProcessSpec,
    optionsInput: PersonalOneShotProcessOptions,
  ): Promise<PersonalProcessResult> {
    const options = oneShotOptions(optionsInput);
    throwIfAborted(options.signal, "Personal command was aborted.");
    const child = this.spawn(spec);
    const sensitiveValues = processSensitiveValues(spec);
    const stdout = new BoundedPersonalLog(maximumOneShotOutputBytes, sensitiveValues);
    const stderr = new BoundedPersonalLog(maximumOneShotOutputBytes, sensitiveValues);
    stdout.attach(child.stdout);
    stderr.attach(child.stderr);
    const exited = childExit(child);
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolvePromise, rejectPromise) => {
      abort = () => rejectPromise(abortReason(options.signal));
      options.signal.addEventListener("abort", abort, { once: true });
      // AbortSignal does not replay an abort that lands between the pre-spawn
      // check and listener registration. Recheck while the listener is armed.
      if (options.signal.aborted) {
        abort();
        return;
      }
      timer = setTimeout(
        () => rejectPromise(new PersonalProcessTimeoutError(options.timeoutMs)),
        options.timeoutMs,
      );
      timer.unref?.();
    });
    try {
      const result = await Promise.race([exited, interrupted]);
      stdout.flush();
      stderr.flush();
      return { ...result, stderr: stderr.text, stdout: stdout.text };
    } catch (operationError) {
      try {
        await terminateOwnedTree(
          child,
          exited.catch(() => undefined),
          options.gracefulTerminationMs,
          options.forceTerminationMs,
        );
      } catch (terminationError) {
        throw new AggregateError(
          [operationError, terminationError],
          "Personal runtime command failed and its process tree could not be verified stopped.",
        );
      }
      throw operationError;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal.removeEventListener("abort", abort);
    }
  }

  spawn(spec: PersonalProcessSpec): PersonalChildProcess {
    if (!path.isAbsolute(spec.executable) || !path.isAbsolute(spec.cwd)) {
      throw new TypeError("Personal process executable and working directory must be absolute.");
    }
    if (spec.stdin !== undefined && spec.secretInput !== undefined) {
      throw new TypeError("A Personal process reads either its input or its secrets on stdin.");
    }
    const stdin =
      spec.secretInput === undefined ? spec.stdin : encodeProcessSecrets(spec.secretInput);
    let output = this.#logs.get(spec.component);
    if (!output && this.#logsDirectory) {
      output = {
        log: new RotatingPersonalLog(
          path.join(this.#logsDirectory, `personal-${spec.component}.log`),
        ),
        references: 0,
      };
      this.#logs.set(spec.component, output);
    }
    if (output) output.references += 1;
    const child = spawnChild(
      this.#supervisorExecutable,
      ["--", path.resolve(spec.executable), ...spec.arguments],
      {
        cwd: spec.cwd,
        env: {
          ...spec.environment,
          ...spec.secretEnvironment,
          [processSupervisorExecutableVariable]: this.#supervisorExecutable,
          // The supervisor and the launcher both hand fd 0 through unchanged.
          ...(spec.secretInput === undefined ? {} : { [processSecretsDescriptorVariable]: "0" }),
        },
        shell: false,
        // fd 3 belongs exclusively to the wrapper. Target stdin remains fd 0,
        // so initdb passwords never share a framing protocol with control.
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin, "utf8");
    }
    if (output) {
      const shared = output;
      const log = shared.log;
      const sensitive = processSensitiveValues(spec);
      for (const [name, stream] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        new BoundedPersonalLog(16 * 1_024, sensitive, (line) => log.append(name, line)).attach(
          stream,
        );
      }
      child.once("close", () => {
        shared.references -= 1;
        if (shared.references === 0) {
          log.close();
          this.#logs.delete(spec.component);
        }
      });
    }
    return managedChild(child);
  }
}

const ProcessSupervisorReleaseSchema = z.strictObject({
  architecture: z.enum(["amd64", "arm64"]),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operatingSystem: z.enum(["darwin", "linux", "win32"]),
  schemaVersion: z.literal(1),
});

/**
 * Verifies the app-signed process-supervisor resource again at runtime before
 * Electron starts any Personal service. There is no PATH or source-tree lookup.
 */
export function readPersonalProcessSupervisorRelease(
  resourcesDirectory: string,
  options: { readonly architecture?: string; readonly operatingSystem?: string } = {},
): string {
  const root = realRegularDirectory(resourcesDirectory, "Desktop resources directory");
  const directory = realRegularDirectory(
    path.join(root, "process-supervisor"),
    "Personal process-supervisor release directory",
  );
  const operatingSystem = normalizedOperatingSystem(options.operatingSystem ?? hostPlatform());
  const architecture = normalizedArchitecture(options.architecture ?? hostArchitecture());
  const executable = path.join(
    directory,
    operatingSystem === "win32"
      ? "opensteer-process-supervisor.exe"
      : "opensteer-process-supervisor",
  );
  const manifestPath = path.join(directory, "release.json");
  const manifestBytes = realRegularFile(manifestPath, "Personal process-supervisor manifest");
  const executableBytes = realRegularFile(
    executable,
    "Personal process-supervisor executable",
    operatingSystem !== "win32",
  );
  const manifest = ProcessSupervisorReleaseSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.operatingSystem !== operatingSystem || manifest.architecture !== architecture) {
    throw new Error("Personal process supervisor does not match this computer.");
  }
  if (createHash("sha256").update(executableBytes).digest("hex") !== manifest.binarySha256) {
    throw new Error("Personal process supervisor does not match its release manifest.");
  }
  return executable;
}

/** The same containment owner for connectors as for Personal services. */
export function spawnContainedPersonalProcess(
  supervisorExecutable: string,
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
): PersonalChildProcess {
  return managedChild(
    spawnChild(supervisorExecutable, ["--", executable, ...arguments_], {
      ...options,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    }),
  );
}

function managedChild(child: ChildProcess): PersonalChildProcess {
  const control = child.stdio[3];
  if (!control || typeof control === "number" || !("write" in control)) {
    child.kill();
    throw new Error("Personal process supervisor control channel was not created.");
  }
  let controlError: Error | undefined;
  control.on("error", (error) => {
    controlError = error;
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  return {
    get pid() {
      return child.pid;
    },
    stderr: child.stderr,
    stdout: child.stdout,
    once(event, listener) {
      child.once(event === "exit" ? "close" : event, listener as never);
      return this;
    },
    async terminate(mode) {
      if (exited) return;
      if (controlError) throw controlError;
      await writeProcessControl(control, mode);
    },
  };
}

function childExit(
  child: PersonalChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, signal });
    });
  });
}

async function terminateOwnedTree(
  child: PersonalChildProcess,
  exited: Promise<unknown>,
  gracefulTerminationMs: number,
  forceTerminationMs: number,
): Promise<void> {
  const graceful = await commandOrExit(child, exited, "graceful");
  if (graceful === "exited" || (await waitUntil(exited, gracefulTerminationMs))) return;
  const forced = await commandOrExit(child, exited, "force");
  if (forced === "exited" || (await waitUntil(exited, forceTerminationMs))) return;
  throw new Error("Personal runtime process tree did not stop after forced termination.");
}

async function commandOrExit(
  child: PersonalChildProcess,
  exited: Promise<unknown>,
  mode: "force" | "graceful",
): Promise<"commanded" | "exited"> {
  return Promise.race([
    exited.then(() => "exited" as const),
    child.terminate(mode).then(() => "commanded" as const),
  ]);
}

async function waitUntil(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function oneShotOptions(
  options: PersonalOneShotProcessOptions,
): Required<PersonalOneShotProcessOptions> {
  return {
    forceTerminationMs: boundedDuration(
      options.forceTerminationMs ?? defaultForceTerminationMs,
      "Personal forced-termination timeout",
    ),
    gracefulTerminationMs: boundedDuration(
      options.gracefulTerminationMs ?? defaultGracefulTerminationMs,
      "Personal graceful-termination timeout",
    ),
    signal: options.signal,
    timeoutMs: boundedDuration(options.timeoutMs, "Personal command timeout"),
  };
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumProcessDurationMs) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Personal command was aborted.");
}

function normalizedOperatingSystem(value: string): "darwin" | "linux" | "win32" {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  if (value === "windows") return "win32";
  throw new Error(`Unsupported Personal process-supervisor operating system: ${value}`);
}

function normalizedArchitecture(value: string): "amd64" | "arm64" {
  if (["amd64", "x64", "x86_64"].includes(value)) return "amd64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error(`Unsupported Personal process-supervisor architecture: ${value}`);
}

function realRegularDirectory(candidate: string, label: string): string {
  const absolute = path.resolve(candidate);
  const metadata = lstatSync(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return realpathSync(absolute);
}

function realRegularFile(candidate: string, label: string, executable = false): Buffer {
  const linkMetadata = lstatSync(candidate);
  if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file.`);
  }
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | (hostPlatform() === "win32" ? 0 : noFollowFlag()),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > 32 * 1_024 * 1_024) {
      throw new Error(`${label} has an invalid size or type.`);
    }
    if (before.dev !== linkMetadata.dev || before.ino !== linkMetadata.ino) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    if (executable && (before.mode & 0o111) === 0) {
      throw new Error(`${label} is not executable.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw new Error(`${label} changed while it was being verified.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Redaction happens on complete lines before memory or disk receives output. */
export class BoundedPersonalLog {
  readonly #maximumBytes: number;
  readonly #sensitiveValues: readonly string[];
  readonly #onLine: (line: string) => void;
  #discardingLine = false;
  #pending = "";
  #text = "";

  constructor(
    maximumBytes = 128 * 1_024,
    sensitiveValues: readonly string[] = [],
    onLine: (line: string) => void = () => undefined,
  ) {
    this.#onLine = onLine;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 1 * 1_024 * 1_024
    ) {
      throw new TypeError("Personal runtime log bound is invalid.");
    }
    this.#maximumBytes = maximumBytes;
    this.#sensitiveValues = [...new Set(sensitiveValues.filter((value) => value.length >= 8))].sort(
      (left, right) => right.length - left.length,
    );
  }

  get text(): string {
    return this.#text;
  }

  attach(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer | string) => {
      this.append(typeof chunk === "string" ? chunk : decoder.write(chunk));
    });
    stream.once("end", () => {
      this.append(decoder.end());
      this.flush();
    });
    stream.resume();
  }

  append(value: string): void {
    if (this.#discardingLine) {
      const newline = value.indexOf("\n");
      if (newline === -1) return;
      value = value.slice(newline + 1);
      this.#discardingLine = false;
    }
    this.#pending += value;
    while (true) {
      const newline = this.#pending.indexOf("\n");
      if (newline === -1) break;
      this.#commit(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.#pending, "utf8") > 8 * 1_024) {
      this.#commit("[oversized log line omitted]");
      this.#pending = "";
      this.#discardingLine = true;
    }
  }

  flush(): void {
    if (this.#pending) this.#commit(this.#pending);
    this.#pending = "";
  }

  #commit(line: string): void {
    const safe = redact(line, this.#sensitiveValues).slice(0, 2_000);
    const candidate = this.#text ? `${this.#text}\n${safe}` : safe;
    let bytes = Buffer.from(candidate, "utf8");
    if (bytes.byteLength > this.#maximumBytes) {
      bytes = bytes.subarray(bytes.byteLength - this.#maximumBytes);
      while (bytes.byteLength > 0 && (bytes[0]! & 0xc0) === 0x80) bytes = bytes.subarray(1);
    }
    this.#text = bytes.toString("utf8");
    this.#onLine(safe);
  }
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  let safe = value
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(password|token|secret)=([^\s&]+)/giu, "$1=[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[redacted]@")
    .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]");
  for (const sensitive of sensitiveValues) safe = safe.split(sensitive).join("[redacted]");
  return safe;
}

export function processSensitiveValues(spec: PersonalProcessSpec): readonly string[] {
  const values = [
    ...Object.values(spec.secretEnvironment ?? {}),
    ...Object.values(spec.secretInput ?? {}),
    ...(spec.stdin ? [spec.stdin.trim()] : []),
  ];
  for (const value of Object.values(spec.secretEnvironment ?? {})) {
    try {
      const parsed = new URL(value);
      if (parsed.password) values.push(parsed.password, decodeURIComponent(parsed.password));
    } catch {
      // Most secret environment values are opaque tokens rather than URLs.
    }
  }
  return values;
}

/**
 * A disk copy of a child's output. Logging never decides whether a child runs:
 * a log that cannot be opened, written or rotated reports why once and stays
 * closed.
 */
export class RotatingPersonalLog {
  readonly #path: string;
  readonly #lifecycle: RotatingPersonalLog | undefined;
  #descriptor: number | undefined;
  #bytes = 0;
  #closed = false;

  constructor(filePath: string, lifecycle = true) {
    this.#path = filePath;
    this.#lifecycle = lifecycle
      ? new RotatingPersonalLog(`${filePath}.lifecycle`, false)
      : undefined;
    try {
      this.#descriptor = this.#open();
      this.#bytes = fstatSync(this.#descriptor).size;
    } catch (error) {
      this.#fail(error);
    }
  }

  append(stream: "stdout" | "stderr", line: string): void {
    if (!routineHttpLog(line)) this.#lifecycle?.append(stream, line);
    if (this.#closed || this.#descriptor === undefined) return;
    const entry = Buffer.from(`${new Date().toISOString()} ${stream} ${line}\n`, "utf8");
    if (entry.byteLength > 256 * 1_024) return;
    try {
      if (this.#bytes + entry.byteLength > 256 * 1_024) {
        const descriptor = this.#descriptor;
        this.#descriptor = undefined;
        closeSync(descriptor);
        rmSync(`${this.#path}.1`, { force: true });
        renameSync(this.#path, `${this.#path}.1`);
        this.#descriptor = this.#open();
        this.#bytes = 0;
      }
      writeSync(this.#descriptor, entry);
      this.#bytes += entry.byteLength;
    } catch (error) {
      this.#fail(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifecycle?.close();
    const descriptor = this.#descriptor;
    this.#descriptor = undefined;
    if (descriptor !== undefined) closeSync(descriptor);
  }

  #fail(error: unknown): void {
    this.close();
    console.error("Personal runtime log persistence failed.", error);
  }

  #open(): number {
    // The logs directory can be removed while Opensteer runs.
    ensurePrivateDirectorySync(path.dirname(this.#path));
    const descriptor = openSync(
      this.#path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollowFlag(),
      0o600,
    );
    if (!fstatSync(descriptor).isFile()) {
      closeSync(descriptor);
      throw new Error("Personal runtime log must be a regular file.");
    }
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    return descriptor;
  }
}

function routineHttpLog(line: string): boolean {
  if (!line.startsWith("{")) return false;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("level" in value) ||
    typeof value.level !== "number" ||
    value.level > 30 ||
    !("msg" in value)
  )
    return false;
  if (value.msg === "incoming request") return true;
  if (
    value.msg !== "request completed" ||
    !("res" in value) ||
    typeof value.res !== "object" ||
    value.res === null ||
    !("statusCode" in value.res)
  )
    return false;
  return (
    typeof value.res.statusCode === "number" &&
    value.res.statusCode >= 200 &&
    value.res.statusCode < 400
  );
}
