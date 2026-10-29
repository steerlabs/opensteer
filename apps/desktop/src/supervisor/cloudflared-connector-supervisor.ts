import { delay } from "@opensteer/shared/delay";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { RestartPolicy } from "@opensteer/shared/restartPolicy";
import type { SpawnOptions } from "node:child_process";
import {
  readPersonalProcessSupervisorRelease,
  spawnContainedPersonalProcess,
} from "./personal-process-port.js";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ConnectLocalOriginSchema } from "@opensteer/control-plane-protocol";
import { HostKeyFingerprintSchema } from "@opensteer/core";
import {
  HostDiscoveryDocumentSchema,
  hostKeyFingerprint,
  sameDiscoveryDocument,
} from "@opensteer/deployment-authority";
import { z } from "zod";
import { preparePrivateDesktopDeploymentDirectories } from "../app/application-paths.js";
import { readPackagedCloudflaredRelease } from "../releases/cloudflared-release.js";
import type { DesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import {
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeSource,
} from "./personal-host-runtime.js";

const maximumLogBytes = 128 * 1_024;
const maximumLogLineBytes = 2_000;
const maximumPendingLogBytes = 64 * 1_024;
const defaultHealthIntervalMs = 5_000;
const defaultHealthFailureThreshold = 3;
const defaultHealthRequestTimeoutMs = 2_000;
const defaultStartupTimeoutMs = 30_000;
const defaultShutdownTimeoutMs = 10_000;
const defaultRestartBackoffBaseMs = 1_000;
const defaultRestartBackoffMaximumMs = 60_000;
const defaultRestartResetAfterMs = 5 * 60_000;

const TunnelTokenSchema = z
  .string()
  .min(32)
  .max(16_384)
  .refine((value) => value === value.trim(), "Tunnel token must not have outer whitespace")
  .refine((value) => !/\p{Control}/u.test(value), "Tunnel token must not contain controls");

export const CloudflaredConnectorConfigurationSchema = z.strictObject({
  discovery: HostDiscoveryDocumentSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostKeyFingerprint: HostKeyFingerprintSchema,
  localOrigin: ConnectLocalOriginSchema,
  schemaVersion: z.literal(1),
  tunnelToken: TunnelTokenSchema,
});
export type CloudflaredConnectorConfiguration = z.infer<
  typeof CloudflaredConnectorConfigurationSchema
>;

export type CloudflaredConnectorState =
  "stopped" | "starting" | "healthy" | "degraded" | "restarting" | "fenced" | "stopping";

export interface CloudflaredConnectorStatus {
  readonly deploymentId: string | null;
  readonly generation: number | null;
  readonly hostInstanceId: string | null;
  readonly lastError: string | null;
  readonly lastHealthyAt: string | null;
  readonly restartAttempt: number;
  readonly state: CloudflaredConnectorState;
}

export interface CloudflaredChildProcess {
  readonly pid?: number | undefined;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnCloudflared = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => CloudflaredChildProcess;

interface CloudflaredConnectorSupervisorOptions {
  readonly allocateMetricsPort?: () => Promise<number>;
  readonly fetch?: typeof globalThis.fetch;
  readonly healthFailureThreshold?: number;
  readonly healthIntervalMs?: number;
  readonly healthRequestTimeoutMs?: number;
  readonly now?: () => Date;
  readonly onStatus?: (status: CloudflaredConnectorStatus) => void;
  readonly privateFiles: DesktopPrivateFilesystem;
  readonly resourcesDirectory: string;
  readonly runtime: PersonalHostRuntimeSource;
  readonly restartBackoffBaseMs?: number;
  readonly restartBackoffMaximumMs?: number;
  readonly restartResetAfterMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawn?: SpawnCloudflared;
  readonly startupTimeoutMs?: number;
}

interface ActiveConfiguration {
  readonly parsed: CloudflaredConnectorConfiguration;
  readonly tokenDigest: string;
}

interface ConnectorExit {
  readonly code: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
}

interface RunningConnector {
  readonly child: CloudflaredChildProcess;
  readonly exit: Promise<ConnectorExit>;
  readonly logCollectors: readonly ConnectorLogCollector[];
  readonly metricsPort: number;
  readonly tokenFilePath: string;
  expectedExit: boolean;
}

/**
 * Owns exactly one remotely-managed Cloudflare Tunnel connector for one local
 * Deployment Host. Provisioning and Cloudflare account credentials remain in
 * the control plane; Desktop receives only the scoped connector token.
 */
export class CloudflaredConnectorSupervisor {
  readonly #allocateMetricsPort: () => Promise<number>;
  readonly #binaryPath: string;
  readonly #cloudflaredVersion: string;
  readonly #dataDirectory: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #healthFailureThreshold: number;
  readonly #healthIntervalMs: number;
  readonly #healthRequestTimeoutMs: number;
  readonly #now: () => Date;
  readonly #onStatus: (status: CloudflaredConnectorStatus) => void;
  readonly #privateFiles: DesktopPrivateFilesystem;
  readonly #restartPolicy: RestartPolicy;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #shutdownTimeoutMs: number;
  readonly #spawn: SpawnCloudflared;
  readonly #startupTimeoutMs: number;
  #stopping = false;
  #active: ActiveConfiguration | undefined;
  #attemptAbort: AbortController | undefined;
  #child: RunningConnector | undefined;
  #consecutiveHealthFailures = 0;
  #healthTimer: NodeJS.Timeout | undefined;
  #lastError: string | null = null;
  #lastHealthyAt: string | null = null;
  #log: BoundedConnectorLog | undefined;
  readonly #mutations = new MutationQueue();
  #restartTimer: NodeJS.Timeout | undefined;
  #state: CloudflaredConnectorState = "stopped";

  constructor(options: CloudflaredConnectorSupervisorOptions) {
    const release = readPackagedCloudflaredRelease(options.resourcesDirectory);
    this.#binaryPath = release.binaryPath;
    this.#cloudflaredVersion = release.version;
    this.#privateFiles = options.privateFiles;
    this.#dataDirectory = path.resolve(options.privateFiles.root);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#spawn =
      options.spawn ??
      containedConnectorSpawn(readPersonalProcessSupervisorRelease(options.resourcesDirectory));
    this.#allocateMetricsPort = options.allocateMetricsPort ?? allocateLoopbackPort;
    this.#now = options.now ?? (() => new Date());
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#runtime = options.runtime;
    this.#healthIntervalMs = boundedDuration(
      options.healthIntervalMs ?? defaultHealthIntervalMs,
      "health interval",
    );
    this.#healthRequestTimeoutMs = boundedDuration(
      options.healthRequestTimeoutMs ?? defaultHealthRequestTimeoutMs,
      "health request timeout",
    );
    this.#startupTimeoutMs = boundedDuration(
      options.startupTimeoutMs ?? defaultStartupTimeoutMs,
      "startup timeout",
    );
    this.#shutdownTimeoutMs = boundedDuration(
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
      "shutdown timeout",
    );
    this.#restartPolicy = new RestartPolicy({
      baseMs: boundedDuration(
        options.restartBackoffBaseMs ?? defaultRestartBackoffBaseMs,
        "restart backoff base",
      ),
      // The connector is the Deployment's only remote reachability, so it
      // retries for as long as it is configured.
      maximumAttempts: null,
      maximumMs: boundedDuration(
        options.restartBackoffMaximumMs ?? defaultRestartBackoffMaximumMs,
        "restart backoff maximum",
      ),
      resetAfterMs: boundedDuration(
        options.restartResetAfterMs ?? defaultRestartResetAfterMs,
        "restart reset interval",
      ),
    });
    const healthFailureThreshold = options.healthFailureThreshold ?? defaultHealthFailureThreshold;
    if (
      !Number.isSafeInteger(healthFailureThreshold) ||
      healthFailureThreshold < 1 ||
      healthFailureThreshold > 100
    ) {
      throw new TypeError("Connector health failure threshold must be from 1 through 100.");
    }
    this.#healthFailureThreshold = healthFailureThreshold;
  }

  get status(): CloudflaredConnectorStatus {
    const discovery = this.#active?.parsed.discovery;
    return {
      deploymentId: discovery?.deploymentId ?? null,
      generation: this.#active?.parsed.generation ?? null,
      hostInstanceId: discovery?.hostInstanceId ?? null,
      lastError: this.#lastError,
      lastHealthyAt: this.#lastHealthyAt,
      restartAttempt: this.#restartPolicy.attempt,
      state: this.#state,
    };
  }

  async start(input: CloudflaredConnectorConfiguration): Promise<void> {
    this.#stopping = false;
    const parsed = CloudflaredConnectorConfigurationSchema.parse(input);
    return this.#mutations.run(async () => {
      if (this.#active || this.#state !== "stopped") {
        throw new Error("Opensteer Connect is already started.");
      }
      await this.#assertRuntimeIdentity(parsed);
      this.#active = activeConfiguration(parsed);
      this.#restartPolicy.reset();
      this.#consecutiveHealthFailures = 0;
      this.#lastError = null;
      this.#setState("starting");
      try {
        await this.#launch(this.#active);
      } catch (error) {
        const safeError = safeConnectorError(error, [parsed.tunnelToken]);
        this.#setState("stopped", safeError);
        this.#active = undefined;
        throw safeError;
      }
    });
  }

  async rotateToken(input: CloudflaredConnectorConfiguration): Promise<void> {
    const parsed = CloudflaredConnectorConfigurationSchema.parse(input);
    return this.#mutations.run(async () => {
      const current = this.#active;
      if (!current || this.#state === "stopped" || this.#state === "stopping") {
        throw new Error("Opensteer Connect is not started.");
      }
      assertSameConnectorIdentity(current.parsed, parsed);
      const candidate = activeConfiguration(parsed);
      if (parsed.generation < current.parsed.generation) {
        throw new Error("Tunnel token generation is stale.");
      }
      if (parsed.generation === current.parsed.generation) {
        if (candidate.tokenDigest !== current.tokenDigest) {
          throw new Error("Tunnel token generation was reused with different content.");
        }
        return;
      }
      await this.#assertRuntimeIdentity(parsed);
      this.#cancelScheduledWork();
      await this.#stopRunningConnector();
      this.#active = candidate;
      this.#consecutiveHealthFailures = 0;
      this.#restartPolicy.reset();
      this.#setState("starting");
      try {
        await this.#launch(candidate);
      } catch (error) {
        this.#scheduleRestart(error);
        throw safeConnectorError(error, [parsed.tunnelToken]);
      }
    });
  }

  stop(signal?: AbortSignal): Promise<void> {
    this.#stopping = true;
    this.#attemptAbort?.abort(new Error("Opensteer Connect is stopping."));
    this.#cancelScheduledWork();
    const force = () => this.#child?.child.kill("SIGKILL");
    signal?.addEventListener("abort", force, { once: true });
    if (signal?.aborted) force();
    return this.#mutations
      .run(async () => {
        if (this.#state === "stopped" && !this.#active) return;
        this.#setState("stopping");
        await this.#stopRunningConnector();
        await this.#log?.flush().catch(() => undefined);
        this.#active = undefined;
        this.#log = undefined;
        this.#restartPolicy.reset();
        this.#consecutiveHealthFailures = 0;
        this.#lastError = null;
        this.#lastHealthyAt = null;
        this.#setState("stopped");
      })
      .finally(() => signal?.removeEventListener("abort", force));
  }

  async #launch(configuration: ActiveConfiguration): Promise<void> {
    await this.#assertRuntimeIdentity(configuration.parsed);
    const paths = await preparePrivateDesktopDeploymentDirectories(
      this.#privateFiles,
      this.#dataDirectory,
      configuration.parsed.discovery.deploymentId,
    );
    const runtimeDirectory = path.join(paths.runtimeDirectory, "connect");
    const logsDirectory = path.join(paths.logsDirectory, "connect");
    await this.#privateFiles.ensureDirectory(runtimeDirectory);
    await this.#privateFiles.ensureDirectory(logsDirectory);
    this.#log ??= new BoundedConnectorLog(
      this.#privateFiles,
      path.join(logsDirectory, "cloudflared.log"),
    );
    this.#log.addSecret(configuration.parsed.tunnelToken);
    const configurationPath = path.join(runtimeDirectory, "cloudflared.yml");
    await this.#privateFiles.writeFileAtomic(configurationPath, "{}\n");
    await this.#privateFiles.writeFileAtomic(
      path.join(runtimeDirectory, "connector.v1.json"),
      `${JSON.stringify({
        cloudflaredVersion: this.#cloudflaredVersion,
        discovery: configuration.parsed.discovery,
        generation: configuration.parsed.generation,
        localOrigin: configuration.parsed.localOrigin,
        schemaVersion: 1,
      })}\n`,
    );
    // A stable token pathname makes crash recovery complete: the native
    // authority atomically replaces any token left by an interrupted Desktop
    // process, while every supervised exit removes the same file.
    const tokenFilePath = path.join(runtimeDirectory, "token.v1");
    await this.#privateFiles.writeFileAtomic(tokenFilePath, configuration.parsed.tunnelToken);
    let metricsPort: number;
    try {
      metricsPort = validPort(await this.#allocateMetricsPort());
    } catch (error) {
      await this.#privateFiles.removeFile(tokenFilePath);
      throw error;
    }
    const arguments_ = [
      "tunnel",
      "--config",
      configurationPath,
      "--no-autoupdate",
      // The Host is stopping too; long-lived tunnel sockets cannot drain on their own.
      "--grace-period",
      "0s",
      "--loglevel",
      "info",
      "--metrics",
      `127.0.0.1:${metricsPort}`,
      "run",
      "--token-file",
      tokenFilePath,
    ] as const;
    const attemptAbort = new AbortController();
    this.#attemptAbort = attemptAbort;
    let child: CloudflaredChildProcess;
    try {
      if (this.#stopping) throw new Error("Opensteer Connect is stopping.");
      child = this.#spawn(this.#binaryPath, arguments_, {
        cwd: runtimeDirectory,
        env: connectorEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#attemptAbort = undefined;
      await this.#privateFiles.removeFile(tokenFilePath);
      throw error;
    }
    const exit = childExit(child);
    const logCollectors = [
      collectConnectorLogs(child.stdout, this.#log),
      collectConnectorLogs(child.stderr, this.#log),
    ];
    const running: RunningConnector = {
      child,
      exit,
      expectedExit: false,
      logCollectors,
      metricsPort,
      tokenFilePath,
    };
    this.#child = running;
    this.#restartPolicy.markStarted();
    void exit.then((result) => this.#unexpectedExit(running, result));
    try {
      await this.#waitUntilHealthy(running, attemptAbort.signal);
      if (this.#active !== configuration || this.#child !== running) {
        throw new Error("Opensteer Connect configuration changed during startup.");
      }
      this.#attemptAbort = undefined;
      this.#consecutiveHealthFailures = 0;
      this.#lastError = null;
      this.#lastHealthyAt = this.#now().toISOString();
      this.#setState("healthy");
      this.#scheduleHealthCheck();
    } catch (error) {
      this.#attemptAbort = undefined;
      await this.#stopConnector(running);
      if (this.#child === running) this.#child = undefined;
      throw error;
    }
  }

  async #waitUntilHealthy(running: RunningConnector, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.#raceHealthWithExit(running, signal)) return;
      await raceDelayWithExit(
        Math.min(250, Math.max(1, deadline - Date.now())),
        running.exit,
        signal,
      );
    }
    throw new Error("cloudflared did not become healthy before its startup deadline.");
  }

  async #raceHealthWithExit(running: RunningConnector, signal: AbortSignal): Promise<boolean> {
    return Promise.race([
      this.#isHealthy(running.metricsPort, signal),
      running.exit.then((result) => {
        throw unexpectedExitError(result);
      }),
    ]);
  }

  async #isHealthy(metricsPort: number, signal: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(this.#healthRequestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.#fetch(`http://127.0.0.1:${metricsPort}/ready`, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "text/plain" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: combined,
      });
      await response.body?.cancel();
      return response.status === 200 && !response.redirected;
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      return false;
    }
  }

  #scheduleHealthCheck(): void {
    if (this.#stopping || !this.#active || !this.#child || this.#state === "stopping") return;
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = setTimeout(() => {
      this.#healthTimer = undefined;
      void this.#mutations
        .run(() => this.#checkHealth())
        .catch((error: unknown) => {
          this.#setState("fenced", error);
        });
    }, this.#healthIntervalMs);
    this.#healthTimer.unref();
  }

  async #checkHealth(): Promise<void> {
    const active = this.#active;
    const running = this.#child;
    if (!active || !running || this.#state === "stopping" || this.#state === "fenced") return;
    try {
      await this.#assertRuntimeIdentity(active.parsed);
    } catch (error) {
      this.#setState("fenced", error);
      await this.#stopRunningConnector();
      await this.#log?.flush().catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    const healthy = await this.#isHealthy(running.metricsPort, controller.signal);
    await this.#log?.flush().catch((error: unknown) => this.#recordError(error));
    if (this.#child !== running || this.#active !== active) return;
    if (healthy) {
      this.#consecutiveHealthFailures = 0;
      this.#lastError = null;
      this.#lastHealthyAt = this.#now().toISOString();
      this.#setState("healthy");
      this.#scheduleHealthCheck();
      return;
    }
    this.#consecutiveHealthFailures += 1;
    this.#setState("degraded", new Error("cloudflared readiness check failed."));
    if (this.#consecutiveHealthFailures < this.#healthFailureThreshold) {
      this.#scheduleHealthCheck();
      return;
    }
    await this.#stopRunningConnector();
    this.#scheduleRestart(new Error("cloudflared remained unhealthy."));
  }

  async #unexpectedExit(running: RunningConnector, result: ConnectorExit): Promise<void> {
    if (running.expectedExit) return;
    await this.#mutations.run(async () => {
      if (running.expectedExit || this.#child !== running || !this.#active) return;
      for (const collector of running.logCollectors) collector.end();
      this.#child = undefined;
      try {
        await this.#privateFiles.removeFile(running.tokenFilePath);
      } catch (error) {
        this.#setState("fenced", error);
        return;
      }
      await this.#log?.flush().catch(() => undefined);
      this.#scheduleRestart(unexpectedExitError(result));
    });
  }

  #scheduleRestart(error: unknown): void {
    if (this.#stopping || !this.#active || this.#state === "stopping" || this.#state === "fenced")
      return;
    this.#recordError(error);
    const delayMs = this.#restartPolicy.nextDelayMs();
    if (delayMs === null) {
      // The connector's policy is unbounded, so this is only reachable if it
      // ever gains an attempt budget. Stop rather than restart in silence.
      this.#setState("stopped", new Error("cloudflared exhausted its restart budget."));
      return;
    }
    this.#setState("restarting", error);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#mutations.run(() => this.#restart());
    }, delayMs);
    this.#restartTimer.unref();
  }

  async #restart(): Promise<void> {
    const active = this.#active;
    if (!active || this.#state === "stopping" || this.#state === "fenced") return;
    try {
      await this.#assertRuntimeIdentity(active.parsed);
      await this.#launch(active);
    } catch (error) {
      if (isRuntimeFence(error)) {
        this.#setState("fenced", error);
        return;
      }
      this.#scheduleRestart(error);
    }
  }

  async #assertRuntimeIdentity(configuration: CloudflaredConnectorConfiguration): Promise<void> {
    const runtime = await this.#runtime.current();
    if (!runtime) {
      throw runtimeFence("Opensteer Connect requires a ready Desktop-owned Personal Host runtime.");
    }
    const parsed = PersonalHostRuntimeRecordSchema.parse(runtime);
    if (
      parsed.localOrigin !== configuration.localOrigin ||
      hostKeyFingerprint(parsed.discoveryEnvelope.publicKey.spki) !==
        configuration.hostKeyFingerprint ||
      !sameDiscoveryDocument(parsed.discovery, configuration.discovery)
    ) {
      throw runtimeFence(
        "Opensteer Connect configuration does not match the current Personal Host runtime.",
      );
    }
  }

  async #stopRunningConnector(): Promise<void> {
    const running = this.#child;
    if (!running) return;
    await this.#stopConnector(running);
    if (this.#child === running) this.#child = undefined;
  }

  async #stopConnector(running: RunningConnector): Promise<void> {
    running.expectedExit = true;
    running.child.kill("SIGTERM");
    let stopped = await settledWithin(running.exit, this.#shutdownTimeoutMs);
    try {
      if (!stopped) {
        running.child.kill("SIGKILL");
        stopped = await settledWithin(running.exit, this.#shutdownTimeoutMs);
      }
      if (!stopped) throw new Error("cloudflared did not stop after forced termination.");
    } finally {
      for (const collector of running.logCollectors) collector.end();
      await this.#privateFiles.removeFile(running.tokenFilePath);
      await this.#log?.flush().catch(() => undefined);
    }
  }

  #cancelScheduledWork(): void {
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#healthTimer = undefined;
    this.#restartTimer = undefined;
  }

  #setState(state: CloudflaredConnectorState, error?: unknown): void {
    this.#state = state;
    if (error !== undefined) this.#recordError(error);
    const status = this.status;
    try {
      this.#onStatus(status);
    } catch {
      // Status observers cannot break connector supervision.
    }
  }

  #recordError(error: unknown): void {
    this.#lastError = redactConnectorText(
      error instanceof Error ? error.message : "Opensteer Connect failed.",
      this.#active ? [this.#active.parsed.tunnelToken] : [],
    ).slice(0, 2_000);
  }
}

class BoundedConnectorLog {
  readonly #entries: string[] = [];
  readonly #filePath: string;
  readonly #privateFiles: DesktopPrivateFilesystem;
  readonly #secrets = new Set<string>();
  #bytes = 0;

  constructor(privateFiles: DesktopPrivateFilesystem, filePath: string) {
    this.#privateFiles = privateFiles;
    this.#filePath = filePath;
  }

  addSecret(secret: string): void {
    this.#secrets.add(secret);
  }

  append(line: string): void {
    const redacted = redactConnectorText(line, this.#secrets).slice(0, maximumLogLineBytes);
    if (!redacted) return;
    const entry = `${redacted}\n`;
    const bytes = Buffer.byteLength(entry);
    this.#entries.push(entry);
    this.#bytes += bytes;
    while (this.#bytes > maximumLogBytes && this.#entries.length > 1) {
      this.#bytes -= Buffer.byteLength(this.#entries.shift()!);
    }
  }

  flush(): Promise<void> {
    return this.#privateFiles.writeFileAtomic(this.#filePath, this.#entries.join(""));
  }
}

class ConnectorLogCollector {
  readonly #decoder = new StringDecoder("utf8");
  readonly #log: BoundedConnectorLog;
  readonly #stream: NodeJS.ReadableStream | null;
  readonly #onData = (chunk: Buffer | string) => this.#append(chunk);
  #ended = false;
  #pending = "";

  constructor(stream: NodeJS.ReadableStream | null, log: BoundedConnectorLog) {
    this.#log = log;
    this.#stream = stream;
    stream?.on("data", this.#onData);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#stream?.removeListener("data", this.#onData);
    this.#pending += this.#decoder.end();
    if (this.#pending) this.#log.append(this.#pending);
    this.#pending = "";
  }

  #append(chunk: Buffer | string): void {
    this.#pending += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const lines = this.#pending.split(/\r?\n/u);
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#log.append(line);
    if (Buffer.byteLength(this.#pending) >= maximumPendingLogBytes) {
      this.#log.append(this.#pending);
      this.#pending = "";
    }
  }
}

function collectConnectorLogs(
  stream: NodeJS.ReadableStream | null,
  log: BoundedConnectorLog,
): ConnectorLogCollector {
  return new ConnectorLogCollector(stream, log);
}

function activeConfiguration(parsed: CloudflaredConnectorConfiguration): ActiveConfiguration {
  return {
    parsed,
    tokenDigest: createHash("sha256").update(parsed.tunnelToken).digest("base64url"),
  };
}

function assertSameConnectorIdentity(
  expected: CloudflaredConnectorConfiguration,
  actual: CloudflaredConnectorConfiguration,
): void {
  if (
    expected.hostKeyFingerprint !== actual.hostKeyFingerprint ||
    !sameDiscoveryDocument(expected.discovery, actual.discovery)
  ) {
    throw new Error("Connector identity does not match the Deployment discovery document.");
  }
}

function connectorEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "LANG",
    "LC_ALL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => (environment[name] ? [[name, environment[name]]] : [])),
  );
}

function containedConnectorSpawn(supervisorExecutable: string): SpawnCloudflared {
  return (executable, arguments_, options) => {
    const child = spawnContainedPersonalProcess(
      supervisorExecutable,
      executable,
      arguments_,
      options,
    );
    return {
      get pid() {
        return child.pid;
      },
      stdout: child.stdout,
      stderr: child.stderr,
      once(event, listener) {
        if (event === "error") child.once("error", listener as (error: Error) => void);
        else
          child.once(
            "exit",
            listener as (code: number | null, signal: NodeJS.Signals | null) => void,
          );
        return this;
      },
      kill(signal) {
        void child
          .terminate(signal === "SIGKILL" ? "force" : "graceful")
          .catch((error: unknown) => console.error("cloudflared containment stop failed", error));
        return true;
      },
    };
  };
}

function childExit(child: CloudflaredChildProcess): Promise<ConnectorExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ConnectorExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ code: null, error, signal: null }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

function unexpectedExitError(exit: ConnectorExit): Error {
  if (exit.error) return new Error("cloudflared failed to start.");
  return new Error(
    `cloudflared stopped unexpectedly (${exit.signal ?? `exit ${exit.code ?? "unknown"}`}).`,
  );
}

async function raceDelayWithExit(
  milliseconds: number,
  exit: Promise<ConnectorExit>,
  signal: AbortSignal,
): Promise<void> {
  await Promise.race([
    delay(milliseconds, signal),
    exit.then((result) => {
      throw unexpectedExitError(result);
    }),
  ]);
}

async function settledWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a cloudflared health port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function redactConnectorText(value: string, secrets: Iterable<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/((?:tunnel[_ -]?token|token)\s*[:=]\s*)[^\s,}]+/giu, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@");
}

function safeConnectorError(error: unknown, secrets: Iterable<string>): Error {
  return new Error(
    redactConnectorText(
      error instanceof Error ? error.message : "Opensteer Connect failed.",
      secrets,
    ).slice(0, 2_000),
  );
}

function runtimeFence(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "connector_identity_fenced",
  });
}

function isRuntimeFence(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "connector_identity_fenced"
  );
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new TypeError(`Connector ${label} must be a positive bounded integer.`);
  }
  return value;
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new TypeError("cloudflared health port must be from 1024 through 65535.");
  }
  return value;
}
