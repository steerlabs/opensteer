import { spawn, type ChildProcessByStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";
import { z } from "zod";
import {
  PortableFsAbortError,
  PortableFsCommandError,
  PortableFsError,
  PortableFsMountCancellationUnverifiedError,
  PortableFsOutputLimitError,
  PortableFsProtocolError,
  PortableFsTimeoutError,
  redactSensitiveText,
  type PortableFsOperation,
} from "./errors.js";
import {
  PortableFsMountCheckResultSchema,
  PortableFsAbsolutePathSchema,
  PortableFsMountInputSchema,
  PortableFsMountedWorkspaceSchema,
  PortableFsMountListSchema,
  PortableFsMountStrategySchema,
  PortableFsRouteResultSchema,
  PortableFsUnmountInputSchema,
  PortableFsUnmountResultSchema,
  PortableFsVersionResultSchema,
  type PortableFsMountCheckResult,
  type PortableFsMountInput,
  type PortableFsMountedWorkspace,
  type PortableFsMountList,
  type PortableFsMountStrategy,
  type PortableFsRouteResult,
  type PortableFsUnmountInput,
  type PortableFsUnmountResult,
  type PortableFsVersionResult,
} from "./schemas.js";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { parseInput } from "./parsing.js";

const MOUNT_CAPABILITY_ENVIRONMENT_VARIABLE = "PORTABLEFS_MOUNT_TOKEN";
const DEFAULT_TIMEOUT_MS = 60_000;
// PortableFS's own mount readiness transaction is bounded at three minutes
// and performs identity-checked cleanup afterward. Do not pre-empt that safety
// transaction with a shorter adapter default.
const DEFAULT_MOUNT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface PortableFsCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PortableFsMountCheckOptions extends PortableFsCommandOptions {
  readonly strategy?: PortableFsMountStrategy;
}

export interface PortableFsRunner {
  checkMountSupport(options?: PortableFsMountCheckOptions): Promise<PortableFsMountCheckResult>;
  explainRoute(path: string, options?: PortableFsCommandOptions): Promise<PortableFsRouteResult>;
  getVersion(options?: PortableFsCommandOptions): Promise<PortableFsVersionResult>;
  listMounts(options?: PortableFsCommandOptions): Promise<PortableFsMountList>;
  mount(
    input: PortableFsMountInput,
    options?: PortableFsCommandOptions,
  ): Promise<PortableFsMountedWorkspace>;
  unmount(
    input: PortableFsUnmountInput,
    options?: PortableFsCommandOptions,
  ): Promise<PortableFsUnmountResult>;
}

interface PortableFsCliRunnerOptions {
  /** Exact executable path or name. It is passed directly to spawn; no shell is used. */
  readonly binary?: string;
  /** Full base environment for child processes. The mount-token variable is always removed. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly defaultMountTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly terminationGraceMs?: number;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stopReason?: TerminationReason;
  readonly stdout: string;
}

type TerminationReason = "aborted" | "output-limit" | "timeout";

export class PortableFsCliRunner implements PortableFsRunner {
  readonly #binary: string;
  readonly #defaultMountTimeoutMs: number;
  readonly #defaultTimeoutMs: number;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #maxOutputBytes: number;
  readonly #terminationGraceMs: number;

  constructor(options: PortableFsCliRunnerOptions = {}) {
    this.#binary = requireNonEmptyOption(options.binary ?? "portablefs", "binary");
    this.#defaultTimeoutMs = requirePositiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#defaultMountTimeoutMs = requirePositiveInteger(
      options.defaultMountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS,
      "defaultMountTimeoutMs",
    );
    this.#maxOutputBytes = requirePositiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#terminationGraceMs = requirePositiveInteger(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    );
    const environment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env) };
    delete environment[MOUNT_CAPABILITY_ENVIRONMENT_VARIABLE];
    this.#environment = Object.freeze(environment);
  }

  async checkMountSupport(
    options: PortableFsMountCheckOptions = {},
  ): Promise<PortableFsMountCheckResult> {
    const strategy = parseInput(
      PortableFsMountStrategySchema,
      options.strategy ?? "auto",
      "mount-check",
    );
    const result = await this.#run(
      "mount-check",
      ["mount-check", "--strategy", strategy, "--json"],
      options,
    );

    // A blocked host is a structured mount-check result with exit 1. Usage
    // failures requested as JSON are structured with exit 2. Preserve that
    // diagnostic contract rather than flattening it into stderr.
    const argv = ["mount-check", "--strategy", strategy, "--json"];
    if (result.exitCode === 0) {
      return parseJsonOutput(PortableFsMountCheckResultSchema, result.stdout, "mount-check");
    }
    try {
      const parsed = parseJsonOutput(
        PortableFsMountCheckResultSchema,
        result.stdout,
        "mount-check",
      );
      if ("error" in parsed) return parsed;
    } catch (error) {
      if (!(error instanceof PortableFsProtocolError)) throw error;
    }
    throw commandFailure("mount-check", argv, result);
  }

  async getVersion(options: PortableFsCommandOptions = {}): Promise<PortableFsVersionResult> {
    const argv = ["version", "--json"];
    const result = await this.#run("version", argv, options);
    ensureSuccessfulCommand("version", argv, result);
    return parseJsonOutput(PortableFsVersionResultSchema, result.stdout, "version");
  }

  async mount(
    input: PortableFsMountInput,
    options: PortableFsCommandOptions = {},
  ): Promise<PortableFsMountedWorkspace> {
    const mount = parseInput(PortableFsMountInputSchema, input, "mount");
    const baseline = await this.listMounts(options);
    const canonicalMountPath = await realpath(mount.mountPath).catch(() => mount.mountPath);
    const argv = [
      "mount",
      mount.volumeId,
      mount.mountPath,
      "--addr",
      mount.authorityAddress,
      "--data-plane-transport",
      mount.tls.transport,
      "--data-plane-server-name",
      mount.tls.serverName,
    ];
    if (mount.tls.transport === "tls-private-ca") {
      argv.push("--data-plane-ca", mount.tls.caPath);
    }
    argv.push(
      "--client-cert",
      mount.clientCertificatePath,
      "--client-key",
      mount.clientKeyPath,
      "--coherence",
      mount.coherence ?? "strict",
      "--strategy",
      mount.strategy ?? "auto",
    );
    argv.push(
      "--auth-expires-at-ms",
      String(mount.automaticReauthorization.authorizationExpiresAtMs),
      "--manager-url",
      mount.automaticReauthorization.managerUrl,
      "--manager-server-name",
      mount.automaticReauthorization.managerServerName,
      "--manager-ca",
      mount.automaticReauthorization.managerCaPath,
      "--mount-enrollment-id",
      mount.automaticReauthorization.enrollmentId,
      "--mount-enrollment-cert",
      mount.automaticReauthorization.enrollmentCertificatePath,
      "--authority-generation",
      String(mount.automaticReauthorization.authorityGeneration),
    );
    if (mount.noLocalDirs === true) argv.push("--no-local-dirs");
    argv.push("--json");

    // The v3 CLI daemonizes into a new session that deliberately survives its
    // parent. A stop request therefore waits for the outer CLI's identity-safe
    // verdict; #reconcileStoppedMount then unmounts and proves absence before
    // the timeout/abort is reported.
    const result = await this.#run("mount", argv, options, mount.capability, true);
    if (result.stopReason !== undefined) {
      await this.#reconcileStoppedMount(
        mount.volumeId,
        mount.mountPath,
        canonicalMountPath,
        baseline,
        result,
      );
      throw stopError(
        "mount",
        result.stopReason,
        options.timeoutMs ?? this.#defaultMountTimeoutMs,
        this.#maxOutputBytes,
      );
    }
    ensureSuccessfulCommand("mount", argv, result);
    const mounted = parseJsonOutput(PortableFsMountedWorkspaceSchema, result.stdout, "mount");
    if (mounted.volumeId !== mount.volumeId) {
      throw new PortableFsProtocolError({
        message: "PortableFS mount returned a different volume identity",
        operation: "mount",
      });
    }
    return mounted;
  }

  async listMounts(options: PortableFsCommandOptions = {}): Promise<PortableFsMountList> {
    const argv = ["mounts", "--json"];
    const result = await this.#run("mounts", argv, options);
    ensureSuccessfulCommand("mounts", argv, result);
    return parseJsonOutput(PortableFsMountListSchema, result.stdout, "mounts");
  }

  async unmount(
    input: PortableFsUnmountInput,
    options: PortableFsCommandOptions = {},
  ): Promise<PortableFsUnmountResult> {
    const unmount = parseInput(PortableFsUnmountInputSchema, input, "umount");
    const argv = ["umount", unmount.mountPath];
    if (unmount.force === true) argv.push("--force");
    argv.push("--json");
    // As with mount, let PortableFS finish its own lifecycle transaction. An
    // external SIGKILL can strand helper/intent state even when the wrapper
    // process is gone.
    const result = await this.#run("umount", argv, options, undefined, true);
    if (result.stopReason !== undefined) {
      throw stopError(
        "umount",
        result.stopReason,
        options.timeoutMs ?? this.#defaultTimeoutMs,
        this.#maxOutputBytes,
      );
    }
    ensureSuccessfulCommand("umount", argv, result);
    return parseJsonOutput(PortableFsUnmountResultSchema, result.stdout, "umount");
  }

  async explainRoute(
    path: string,
    options: PortableFsCommandOptions = {},
  ): Promise<PortableFsRouteResult> {
    const parsedPath = parseInput(PortableFsAbsolutePathSchema, path, "route");
    const argv = ["route", parsedPath, "--json"];
    const result = await this.#run("route", argv, options);
    ensureSuccessfulCommand("route", argv, result);
    return parseJsonOutput(PortableFsRouteResultSchema, result.stdout, "route");
  }

  async #reconcileStoppedMount(
    volumeId: string,
    requestedMountPath: string,
    canonicalMountPath: string,
    baseline: PortableFsMountList,
    result: CommandResult,
  ): Promise<void> {
    const expectedPaths = new Set([requestedMountPath, canonicalMountPath]);
    const baselineRows = new Set(baseline.mounts.map(mountInventoryKey));

    try {
      if (result.exitCode === 0) {
        const parsed = PortableFsMountedWorkspaceSchema.safeParse(parseJson(result.stdout));
        if (parsed.success && parsed.data.volumeId === volumeId) {
          expectedPaths.add(parsed.data.mountPath);
        }

        // A successful v3 readiness report means the detached child owns a
        // live mount, even when our bounded stdout was truncated. Do not rely
        // on a racing inventory read to discover it: explicitly unmount the
        // requested path, unless it was already present before this command.
        const collidedWithBaseline = baseline.mounts.some(
          (row) => row.volumeId === volumeId && expectedPaths.has(row.mountPath),
        );
        if (collidedWithBaseline) {
          throw new Error(
            "PortableFS reported a successful mount over a pre-existing inventory identity",
          );
        }
        const unmounted = await this.unmount({ mountPath: requestedMountPath });
        if (unmounted.mountPath !== requestedMountPath) {
          throw new Error("PortableFS unmounted a different path during cancellation cleanup");
        }
      }

      const inventory = await this.listMounts();
      const candidates = inventory.mounts.filter(
        (row) =>
          row.volumeId === volumeId &&
          expectedPaths.has(row.mountPath) &&
          !baselineRows.has(mountInventoryKey(row)),
      );
      if (candidates.length === 0) return;
      const cleanupErrors: unknown[] = [];
      for (const row of candidates) {
        try {
          const unmounted = await this.unmount({ mountPath: row.mountPath });
          if (unmounted.mountPath !== row.mountPath) {
            throw new Error("PortableFS unmounted a different path during cancellation cleanup");
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      const remaining = (await this.listMounts()).mounts.filter(
        (row) =>
          row.volumeId === volumeId &&
          expectedPaths.has(row.mountPath) &&
          !baselineRows.has(mountInventoryKey(row)),
      );
      if (remaining.length === 0) return;
      throw new AggregateError(
        cleanupErrors,
        "PortableFS mount remains present after cancellation",
      );
    } catch (error) {
      throw new PortableFsMountCancellationUnverifiedError({
        cause: error,
        requestedStop: result.stopReason ?? "aborted",
      });
    }
  }

  async #run(
    operation: PortableFsOperation,
    argv: readonly string[],
    options: PortableFsCommandOptions,
    mountCapability?: string,
    settleBeforeStop = false,
  ): Promise<CommandResult> {
    const timeoutMs = requirePositiveInteger(
      options.timeoutMs ??
        (operation === "mount" ? this.#defaultMountTimeoutMs : this.#defaultTimeoutMs),
      "timeoutMs",
      operation,
    );
    if (options.signal?.aborted === true) throw new PortableFsAbortError(operation);

    const environment: NodeJS.ProcessEnv = { ...this.#environment };
    delete environment[MOUNT_CAPABILITY_ENVIRONMENT_VARIABLE];
    if (mountCapability !== undefined) {
      environment[MOUNT_CAPABILITY_ENVIRONMENT_VARIABLE] = mountCapability;
    }
    const secrets = mountCapability === undefined ? [] : [mountCapability];

    return await new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(this.#binary, argv, {
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(
          new PortableFsCommandError({
            argv,
            cause: error,
            code: "spawn_failed",
            exitCode: null,
            operation,
            signal: null,
            stderr: redactSensitiveText(
              error instanceof Error ? error.message : "Unable to spawn PortableFS",
              secrets,
            ),
          }),
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let outputLimitReached = false;
      let spawnError: unknown;
      let stopReason: TerminationReason | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const requestStop = (reason: TerminationReason): void => {
        if (reason === "output-limit") outputLimitReached = true;
        if (stopReason !== undefined) return;
        stopReason = reason;
        if (settleBeforeStop) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), this.#terminationGraceMs);
        killTimer.unref();
      };

      const collect = (destination: Buffer[], chunk: Buffer | string): void => {
        if (outputLimitReached || (stopReason !== undefined && !settleBeforeStop)) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.#maxOutputBytes) {
          requestStop("output-limit");
          return;
        }
        destination.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
      child.stderr.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));
      child.once("error", (error) => {
        spawnError = error;
      });

      const timeout = setTimeout(() => requestStop("timeout"), timeoutMs);
      timeout.unref();
      const abort = (): void => requestStop("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);

        if (stopReason !== undefined && !settleBeforeStop) {
          reject(stopError(operation, stopReason, timeoutMs, this.#maxOutputBytes));
          return;
        }

        const stderr = redactSensitiveText(Buffer.concat(stderrChunks).toString("utf8"), secrets);
        if (spawnError !== undefined) {
          reject(
            new PortableFsCommandError({
              argv,
              cause: spawnError,
              code: "spawn_failed",
              exitCode,
              operation,
              signal,
              stderr:
                stderr.length > 0
                  ? stderr
                  : redactSensitiveText(
                      spawnError instanceof Error
                        ? spawnError.message
                        : "Unable to spawn PortableFS",
                      secrets,
                    ),
            }),
          );
          return;
        }
        resolve({
          exitCode,
          signal,
          stderr,
          ...(stopReason === undefined ? {} : { stopReason }),
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        });
      });
    });
  }
}

function ensureSuccessfulCommand(
  operation: PortableFsOperation,
  argv: readonly string[],
  result: CommandResult,
): void {
  if (result.exitCode === 0) return;
  throw commandFailure(operation, argv, result);
}

function commandFailure(
  operation: PortableFsOperation,
  argv: readonly string[],
  result: CommandResult,
): PortableFsCommandError {
  return new PortableFsCommandError({
    argv,
    exitCode: result.exitCode,
    operation,
    signal: result.signal,
    stderr: result.stderr,
  });
}

function stopError(
  operation: PortableFsOperation,
  reason: TerminationReason,
  timeoutMs: number,
  maxOutputBytes: number,
): PortableFsError {
  switch (reason) {
    case "aborted":
      return new PortableFsAbortError(operation);
    case "output-limit":
      return new PortableFsOutputLimitError(operation, maxOutputBytes);
    case "timeout":
      return new PortableFsTimeoutError(operation, timeoutMs);
  }
}

function mountInventoryKey(row: PortableFsMountList["mounts"][number]): string {
  return [row.volumeId, row.mountPath, row.pid, row.startedAtMs].join("\0");
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonOutput<TSchema extends z.ZodType>(
  schema: TSchema,
  output: string,
  operation: PortableFsOperation,
): z.output<TSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    throw new PortableFsProtocolError({
      message: `PortableFS ${operation} returned invalid JSON`,
      operation,
    });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new PortableFsProtocolError({
      message: `PortableFS ${operation} returned an incompatible response (${formatIssues(parsed.error.issues)})`,
      operation,
    });
  }
  return parsed.data;
}

function requireNonEmptyOption(value: string, name: string): string {
  if (value.trim().length > 0) return value;
  throw new TypeError(`${name} must not be empty`);
}

function requirePositiveInteger(
  value: number,
  name: string,
  operation?: PortableFsOperation,
): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (operation !== undefined) {
    throw new PortableFsError({
      code: "invalid_input",
      message: `${name} must be a positive integer`,
      operation,
    });
  }
  throw new TypeError(`${name} must be a positive integer`);
}
