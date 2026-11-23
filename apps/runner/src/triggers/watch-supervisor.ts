import { programEnvironment, spawnSupervised, type SupervisedProcess } from "@opensteer/harness";
import {
  createPrivateFileAtomically,
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { delay } from "@opensteer/shared/delay";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { safeMessage } from "@opensteer/shared/safeMessage";
import type { RunnerConfig } from "@opensteer/config";
import {
  assertAutomationSecretsWithinBounds,
  automationSecretEnvName,
  AutomationScriptSchema,
  AutomationSecretValueSchema,
  normalizeScriptText,
  scriptFileExtension,
  WATCH_LOG_TAIL_BYTES,
  WATCH_START_RETRY_MS,
  type AutomationScript,
} from "@opensteer/triggers";
import { createId, type EnvironmentId, type TriggerWatchActivationId } from "@opensteer/core";
import type { RunnerOperationalReport, WatchReconcileActivation } from "@opensteer/protocol";
import { isNodeError } from "@opensteer/shared/nodeError";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { RunnerMessageSink } from "../runtime/runtime.js";
import type { AgentHomeAccess, AgentHomeWorkspace } from "../folders/agent-home.js";
import { startProgramEndpoints, type ProgramEndpointSet } from "../agent/program-endpoints.js";
import {
  resolveAutomationCliPaths,
  resolveInterpreterExecutable,
  type ProgramLaunchPlanner,
} from "../agent/script-executor.js";

const WatchScriptResponseSchema = z.strictObject({
  script: AutomationScriptSchema,
  secrets: z.record(z.string(), z.string()).default({}),
});

const CachedWatchScriptSchema = z.strictObject({
  hasSecrets: z.boolean(),
  script: AutomationScriptSchema,
});

interface LoadedWatchScript {
  readonly script: AutomationScript;
  readonly secrets: Readonly<Record<string, string>>;
}

interface ActiveWatch {
  abort: AbortController;
  capabilitiesPath: string;
  desired: WatchReconcileActivation;
  /** The script's stand-ins for the Host, from start until the watch stops or expires. */
  endpoints?: ProgramEndpointSet;
  healthySince: string | null;
  lastError: string | null;
  lastExitCode: number | null;
  leaseTimer?: NodeJS.Timeout;
  observed: "starting" | "running" | "backoff" | "expired" | "stopped";
  process: SupervisedProcess | undefined;
  renewingToken?: Promise<boolean>;
  restartCount: number;
  /** Memory-only script + secrets payload for this active watch; secrets never touch disk. */
  scriptPayload?: LoadedWatchScript;
  sink: RunnerMessageSink;
  stderrTail: Buffer;
  stdoutTail: Buffer;
  task?: Promise<void>;
}

export interface WatchSupervisorOptions {
  readonly cliBinDirectory?: string;
  readonly cliScriptPath?: string;
  readonly environmentId: EnvironmentId;
  readonly nodeExecutable: string;
  /** Confines one script launch; see the Runner's own automation script launches. */
  readonly planLaunch: (
    executionId: string,
    launch: Parameters<ProgramLaunchPlanner>[0],
  ) => ReturnType<ProgramLaunchPlanner>;
  readonly privateStateDirectory: string;
  readonly onStopped?: (
    report: Extract<
      RunnerOperationalReport,
      {
        readonly type: "runner.watch-status";
      }
    >,
  ) => void;
  /** Ends whatever an execution's script left running. */
  readonly terminate: (
    executionId: string,
  ) => Promise<import("../runtime/execution-containment.js").TerminationProof>;
  readonly transport: Pick<RunnerConfig, "mode">;
  readonly agentHome: AgentHomeAccess;
}

const maximumScriptResponseBytes = 6 * 512 * 1_024 + 1_024;
const maximumBackoffMs = 5 * 60_000;
const scriptCacheDirectory = "script-cache-v1";

export class WatchSupervisor {
  readonly #cliBinDirectory: string;
  readonly #cliScriptPath: string;
  readonly #environmentId: EnvironmentId;
  readonly #nodeExecutable: string;
  readonly #planLaunch: WatchSupervisorOptions["planLaunch"];
  readonly #onStopped: WatchSupervisorOptions["onStopped"];
  readonly #terminate: WatchSupervisorOptions["terminate"];
  readonly #transport: WatchSupervisorOptions["transport"];
  readonly #executionRoot: string;
  readonly #privateRoot: string;
  readonly #watches = new Map<TriggerWatchActivationId, ActiveWatch>();
  readonly #stopped = new Map<string, "ended" | "never-seen">();
  readonly #agentHome: AgentHomeAccess;
  readonly #statusTimer: NodeJS.Timeout;
  #closed = false;
  #privateRootPrepared = false;
  #lastReconcileGeneration = 0;
  #reconcileTail: Promise<void> = Promise.resolve();

  constructor(options: WatchSupervisorOptions) {
    const cliDefaults = resolveAutomationCliPaths(import.meta.url, process.env);
    this.#cliBinDirectory = resolve(options.cliBinDirectory ?? cliDefaults.cliBinDirectory);
    this.#cliScriptPath = resolve(options.cliScriptPath ?? cliDefaults.cliScriptPath);
    this.#environmentId = options.environmentId;
    this.#nodeExecutable = options.nodeExecutable;
    this.#planLaunch = options.planLaunch;
    this.#terminate = options.terminate;
    this.#onStopped = options.onStopped;
    this.#transport = options.transport;
    this.#privateRoot = resolve(options.privateStateDirectory, "watches");
    this.#executionRoot = join(this.#privateRoot, "executions", randomUUID());
    this.#agentHome = options.agentHome;
    this.#statusTimer = setInterval(() => {
      for (const active of this.#watches.values()) {
        if (active.observed === "running") void this.#report(active);
      }
    }, 60_000);
    this.#statusTimer.unref();
  }

  activeActivationIds(): readonly TriggerWatchActivationId[] {
    return [...this.#watches.keys()];
  }

  async reconcile(
    command: Extract<
      import("@opensteer/protocol").RunnerCommand,
      { readonly type: "watch.reconcile" }
    >,
    sink: RunnerMessageSink,
  ): Promise<void> {
    const applied = this.#reconcileTail.then(() => this.#applyReconcile(command, sink));
    this.#reconcileTail = applied.catch(() => undefined);
    return applied;
  }

  async connectionLost(sink: RunnerMessageSink): Promise<void> {
    const stopped = this.#reconcileTail.then(async () => {
      const active = [...this.#watches.entries()].filter(([, watch]) => watch.sink === sink);
      await Promise.allSettled(
        active.map(async ([activationId, watch]) => {
          await this.#stop(watch, true);
          this.#watches.delete(activationId);
        }),
      );
    });
    this.#reconcileTail = stopped.catch(() => undefined);
    await stopped;
  }

  async stopAttempt(
    activationId: TriggerWatchActivationId,
    generation: number,
    sink: RunnerMessageSink,
  ): Promise<import("@opensteer/protocol").AttemptStopState> {
    const stopped = this.#reconcileTail.then(async () => {
      const key = `${activationId}:${generation}`;
      const prior = this.#stopped.get(key);
      if (prior) return prior;
      const active = this.#watches.get(activationId);
      if (!active || active.desired.executionGeneration !== generation) {
        this.#stopped.set(key, "never-seen");
        return "never-seen" as const;
      }
      active.sink = sink;
      try {
        await this.#stop(active, true);
        this.#watches.delete(activationId);
        return "ended" as const;
      } catch {
        return "still-ending" as const;
      }
    });
    this.#reconcileTail = stopped.then(
      () => undefined,
      () => undefined,
    );
    return stopped;
  }

  async #applyReconcile(
    command: Extract<
      import("@opensteer/protocol").RunnerCommand,
      { readonly type: "watch.reconcile" }
    >,
    sink: RunnerMessageSink,
  ): Promise<void> {
    if (this.#closed) throw new Error("Watch supervisor is closed");
    if (command.environmentId !== this.#environmentId) {
      throw new Error("Watch reconciliation targets a different execution environment");
    }
    if (command.reconcileGeneration <= this.#lastReconcileGeneration) return;
    await this.#preparePrivateRoot();
    const desired = new Map(command.desired.map((item) => [item.activationId, item]));
    for (const [activationId, active] of this.#watches) {
      const next = desired.get(activationId);
      if (
        !next ||
        next.executionGeneration !== active.desired.executionGeneration ||
        next.revisionId !== active.desired.revisionId
      ) {
        active.sink = sink;
        try {
          await this.#stop(active, true);
          this.#watches.delete(activationId);
        } catch {
          continue;
        }
      }
    }
    for (const item of command.desired) {
      if (this.#stopped.has(`${item.activationId}:${item.executionGeneration}`)) continue;
      const existing = this.#watches.get(item.activationId);
      if (existing) {
        if (
          existing.abort.signal.aborted ||
          existing.desired.executionGeneration !== item.executionGeneration
        )
          continue;
        existing.desired = item;
        existing.sink = sink;
        await this.#writeCapabilities(existing);
        this.#armLease(existing);
        await this.#report(existing);
        continue;
      }
      const active: ActiveWatch = {
        abort: new AbortController(),
        capabilitiesPath: join(
          this.#executionRoot,
          item.activationId,
          String(item.executionGeneration),
          "capabilities.json",
        ),
        desired: item,
        healthySince: null,
        lastError: null,
        lastExitCode: null,
        observed: "starting",
        restartCount: 0,
        sink,
        stderrTail: Buffer.alloc(0),
        stdoutTail: Buffer.alloc(0),
        process: undefined,
      };
      this.#watches.set(item.activationId, active);
      await this.#writeCapabilities(active);
      this.#armLease(active);
      active.task = this.#run(active);
    }
    await this.#evictScriptCache(new Set(command.desired.map(({ revisionId }) => revisionId)));
    this.#lastReconcileGeneration = command.reconcileGeneration;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#statusTimer);
    await this.#reconcileTail;
    const active = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.allSettled(active.map((watch) => this.#stop(watch, true)));
  }

  async #run(active: ActiveWatch): Promise<void> {
    while (!active.abort.signal.aborted && active.observed !== "expired") {
      let workspace: AgentHomeWorkspace | undefined;
      let materializationRoot: string | undefined;
      active.observed = "starting";
      await this.#report(active);
      try {
        workspace = await this.#agentHome.prepare({
          agentHome: active.desired.agentHome,
          signal: active.abort.signal,
        });
      } catch (error) {
        if (active.abort.signal.aborted) break;
        // An unavailable Agent home is not the script crashing, so it never counts toward the
        // restart counter; the Watch starts once the folder is back.
        active.lastExitCode = null;
        active.lastError = safeMessage(error, {
          fallback: "Agent home is unavailable",
          maximumLength: 20_000,
        });
        active.observed = "backoff";
        await this.#report(active);
        await delay(WATCH_START_RETRY_MS, active.abort.signal).catch(() => undefined);
        continue;
      }
      try {
        const loaded = await this.#loadScript(active);
        const materialized = await this.#materialize(active, loaded.script);
        materializationRoot = materialized.root;
        const environment = this.#watchEnvironment(active, materialized.eventFile, loaded.secrets);
        const executable = loaded.script.interpreter
          ? resolveInterpreterExecutable(
              loaded.script.interpreter[0]!,
              environment.PATH ?? "",
              environment.PATHEXT,
            )
          : this.#nodeExecutable;
        const args = loaded.script.interpreter
          ? [...loaded.script.interpreter.slice(1), materialized.scriptFile]
          : [materialized.scriptFile];
        const readOnlyDirectories = [this.#cliBinDirectory, dirname(this.#cliScriptPath)];
        const launch = (
          await this.#planLaunch(active.desired.activationId, {
            environment,
            privateDirectory: dirname(active.capabilitiesPath),
            readOnlyDirectories,
            workspacePath: workspace.path,
          })
        )({ args, cwd: workspace.path, environment, executable });
        active.abort.signal.throwIfAborted();
        const child = spawnSupervised({
          args: launch.args,
          cwd: launch.cwd,
          environment: launch.environment,
          executable: launch.executable,
          maxOutputBytes: Number.MAX_SAFE_INTEGER,
          stdin: "closed",
        });
        active.process = child;
        active.healthySince = new Date().toISOString();
        active.lastError = null;
        active.observed = "running";
        await this.#report(active);
        const output = Promise.all([
          this.#consume(child.stdout, active, "stdout"),
          this.#consume(child.stderr, active, "stderr"),
        ]);
        const exit = await child.exited;
        await output;
        active.process = undefined;
        active.lastExitCode = exit.code;
        if (active.abort.signal.aborted) break;
        active.restartCount += 1;
        active.lastError = exit.signal
          ? `Watch script ended from ${exit.signal}`
          : `Watch script exited with code ${String(exit.code)}`;
      } catch (error) {
        active.process = undefined;
        if (active.abort.signal.aborted) break;
        active.restartCount += 1;
        active.lastExitCode = null;
        active.lastError = safeMessage(error, {
          fallback: "Watch script failed",
          maximumLength: 20_000,
        });
      } finally {
        // Contain any orphaned grandchildren before cleaning up or spawning the next restart (Y5).
        await this.#terminate(active.desired.activationId).catch(() => undefined);
        if (materializationRoot) {
          await rm(materializationRoot, { force: true, recursive: true }).catch(() => undefined);
        }
      }
      if (active.abort.signal.aborted) break;
      active.observed = "backoff";
      await this.#report(active);
      const ceiling = Math.min(
        maximumBackoffMs,
        1_000 * 2 ** Math.min(Math.max(active.restartCount - 1, 0), 18),
      );
      await delay(Math.floor(Math.random() * (ceiling + 1)), active.abort.signal).catch(
        () => undefined,
      );
    }
  }

  async #materialize(
    active: ActiveWatch,
    script: AutomationScript,
  ): Promise<{
    readonly eventFile: string;
    readonly root: string;
    readonly scriptFile: string;
  }> {
    const root = join(dirname(active.capabilitiesPath), `attempt-${randomUUID()}`);
    await securePrivateDirectory(root);
    const extension = scriptFileExtension(script.interpreter);
    const scriptFile = join(root, `script${extension}`);
    const eventFile = join(root, "event.json");
    const event = {
      automationId: active.desired.triggerId,
      firedAt: new Date().toISOString(),
      firingId: createId("triggerOccurrence"),
      kind: "watch" as const,
      payload: null,
    };
    try {
      const normalized = normalizeScriptText(script.text, process.platform);
      await Promise.all([
        replacePrivateFileAtomically(scriptFile, normalized),
        replacePrivateFileAtomically(eventFile, JSON.stringify(event)),
      ]);
      return { eventFile, root, scriptFile };
    } catch (error) {
      await rm(root, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async #preparePrivateRoot(): Promise<void> {
    if (this.#privateRootPrepared) return;
    await securePrivateDirectory(this.#privateRoot);
    await rm(join(this.#privateRoot, "executions"), { force: true, recursive: true });
    // Legacy v5 program caches are disposable and replaced by script-cache-v1.
    await rm(join(this.#privateRoot, "program-cache"), { force: true, recursive: true });
    await rm(join(this.#privateRoot, "program-cache-v2"), { force: true, recursive: true });
    await securePrivateDirectory(this.#executionRoot);
    this.#privateRootPrepared = true;
  }

  async #evictScriptCache(desiredRevisionIds: ReadonlySet<string>): Promise<void> {
    const cacheRoot = join(this.#privateRoot, scriptCacheDirectory);
    let entries;
    try {
      entries = await readdir(cacheRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    const desiredNames = new Set([...desiredRevisionIds].map((revisionId) => `${revisionId}.json`));
    await Promise.all(
      entries
        .filter((entry) => !desiredNames.has(entry.name))
        .map((entry) => rm(join(cacheRoot, entry.name), { force: true, recursive: true })),
    );
  }

  async #loadScript(active: ActiveWatch): Promise<LoadedWatchScript> {
    if (active.scriptPayload) return active.scriptPayload;
    const cachePath = join(
      this.#privateRoot,
      scriptCacheDirectory,
      `${active.desired.revisionId}.json`,
    );
    const cachedText = await readPrivateFileText(cachePath, maximumScriptResponseBytes, {
      exposed: () => new Error("Cached watch script permissions are unsafe"),
      invalid: () => new Error("Cached watch script is invalid"),
    });
    if (cachedText) {
      const cached = CachedWatchScriptSchema.parse(JSON.parse(cachedText));
      // Only reuse disk cache when the automation has no sealed secrets; secrets never touch disk.
      if (!cached.hasSecrets) {
        const loaded: LoadedWatchScript = { script: cached.script, secrets: {} };
        active.scriptPayload = loaded;
        return loaded;
      }
    }
    const url = new URL(
      `/internal/v1/triggers/revisions/${active.desired.revisionId}/script`,
      active.desired.capabilities.mcp.url,
    );
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${active.desired.capabilities.mcp.token}` },
      redirect: "error",
      signal: active.abort.signal,
    });
    if (!response.ok) throw new Error(`Watch script fetch failed (${response.status})`);
    const loaded = WatchScriptResponseSchema.parse(
      await readBoundedJson(response, {
        expectedContentType: "application/json",
        maximumBytes: maximumScriptResponseBytes,
        signal: active.abort.signal,
        sizeError: () => new Error("Watch script response exceeds its limit"),
      }),
    );
    await mkdir(dirname(cachePath), { mode: 0o700, recursive: true });
    await createPrivateFileAtomically(
      cachePath,
      JSON.stringify({
        hasSecrets: Object.keys(loaded.secrets).length > 0,
        script: loaded.script,
      }),
    );
    active.scriptPayload = loaded;
    return loaded;
  }

  /**
   * The capabilities the script reads: its stand-ins, with the Host's
   * expiries. The Host tokens behind them change on demand; what the
   * script holds does not, and never works anywhere but here.
   */
  async #writeCapabilities(active: ActiveWatch): Promise<void> {
    active.endpoints ??= await startProgramEndpoints({
      capabilities: () => active.desired.capabilities,
      resolveBrowserToken: () => this.#freshBrowserToken(active),
      resolveMcpToken: () => this.#freshMcpToken(active),
      transport: this.#transport,
    });
    const { endpoints } = active.endpoints;
    const { capabilities } = active.desired;
    await replacePrivateFileAtomically(
      active.capabilitiesPath,
      JSON.stringify({
        browserCdp:
          endpoints.browserCdp && capabilities.browserCdp
            ? { ...endpoints.browserCdp, expiresAt: capabilities.browserCdp.expiresAt }
            : null,
        mcp: { ...endpoints.mcp, expiresAt: capabilities.mcp.expiresAt },
      }),
    );
  }

  async #freshMcpToken(active: ActiveWatch): Promise<string> {
    const expiresAt = Date.parse(active.desired.capabilities.mcp.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) {
      return active.desired.capabilities.mcp.token;
    }
    await this.#renewCapabilities(active);
    return active.desired.capabilities.mcp.token;
  }

  async #freshBrowserToken(active: ActiveWatch): Promise<string> {
    const browserCdp = active.desired.capabilities.browserCdp;
    if (!browserCdp) return "";
    const expiresAt = Date.parse(browserCdp.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) {
      return browserCdp.token;
    }
    await this.#renewCapabilities(active);
    return active.desired.capabilities.browserCdp?.token ?? "";
  }

  async #renewCapabilities(active: ActiveWatch): Promise<boolean> {
    const renew = active.sink.renewProxyToken;
    if (!renew || active.abort.signal.aborted) return false;
    active.renewingToken ??= renew({
      activationId: active.desired.activationId,
      executionGeneration: active.desired.executionGeneration,
      kind: "watch",
    })
      .then((answer) => {
        if (!answer?.mcp || this.#watches.get(active.desired.activationId) !== active) {
          return false;
        }
        active.desired = {
          ...active.desired,
          capabilities: {
            browserCdp: answer.browserCdp,
            mcp: answer.mcp,
          },
        };
        this.#armLease(active);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        delete active.renewingToken;
      });
    return active.renewingToken;
  }

  /** Ends the script's access to the Host and whatever it left running. */
  async #endExecution(active: ActiveWatch): Promise<void> {
    const endpoints = active.endpoints;
    delete active.endpoints;
    delete active.scriptPayload;
    endpoints?.revoke();
    await active.process?.terminate(5_000).catch(() => undefined);
    await active.task?.catch(() => undefined);
    await endpoints?.close();
    if ((await this.#terminate(active.desired.activationId)) !== "proven")
      throw new Error("Watch containment could not be verified");
  }

  #armLease(active: ActiveWatch): void {
    if (active.leaseTimer) clearTimeout(active.leaseTimer);
    const expirations = [
      active.desired.capabilities.mcp.expiresAt,
      active.desired.capabilities.browserCdp?.expiresAt,
    ].filter((value): value is string => value !== undefined);
    const expiresAt = Math.min(...expirations.map((value) => new Date(value).getTime()));
    active.leaseTimer = setTimeout(
      () => {
        void this.#expire(active).catch(() => undefined);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    active.leaseTimer.unref();
  }

  async #expire(active: ActiveWatch): Promise<void> {
    if (this.#watches.get(active.desired.activationId) !== active) return;
    if (await this.#renewCapabilities(active)) return;
    if (this.#watches.get(active.desired.activationId) !== active) return;
    active.abort.abort(new Error("Watch capability lease expired"));
    await this.#endExecution(active);
    active.observed = "expired";
    await this.#report(active);
  }

  async #stop(active: ActiveWatch, report: boolean): Promise<void> {
    if (active.leaseTimer) clearTimeout(active.leaseTimer);
    active.abort.abort(new Error("Watch was stopped"));
    await this.#endExecution(active);
    active.observed = "stopped";
    if (report) await this.#report(active);
  }

  async #consume(
    stream: AsyncIterable<Buffer>,
    active: ActiveWatch,
    target: "stderr" | "stdout",
  ): Promise<void> {
    for await (const chunk of stream) {
      const current = target === "stdout" ? active.stdoutTail : active.stderrTail;
      const combined = Buffer.concat([current, chunk]);
      const tail =
        combined.byteLength <= WATCH_LOG_TAIL_BYTES
          ? combined
          : combined.subarray(combined.byteLength - WATCH_LOG_TAIL_BYTES);
      if (target === "stdout") active.stdoutTail = tail;
      else active.stderrTail = tail;
    }
  }

  async #report(active: ActiveWatch): Promise<void> {
    const message: RunnerOperationalReport = {
      activationId: active.desired.activationId,
      executionGeneration: active.desired.executionGeneration,
      healthySince: active.healthySince,
      lastError: active.lastError,
      lastExitCode: active.lastExitCode,
      observed: active.observed,
      restartCount: active.restartCount,
      stderrTail: watchTailText(active.stderrTail),
      stdoutTail: watchTailText(active.stdoutTail),
      type: "runner.watch-status",
    };
    if (message.observed === "stopped" || message.observed === "expired") {
      this.#stopped.set(`${message.activationId}:${message.executionGeneration}`, "ended");
      this.#onStopped?.(message);
    }
    await active.sink.send(message).catch(() => undefined);
  }

  #watchEnvironment(
    active: ActiveWatch,
    eventFile: string,
    secrets: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const environment = programEnvironment();
    // Z11: drop empty, `.`, and relative PATH entries so Agent home in cwd can never hijack commands.
    const absolutePathEntries = (environment.PATH ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0 && isAbsolute(entry));
    environment.PATH = [this.#cliBinDirectory, ...absolutePathEntries].join(delimiter);
    if (Object.keys(secrets).length > 0) {
      assertAutomationSecretsWithinBounds(secrets);
      for (const [name, value] of Object.entries(secrets)) {
        AutomationSecretValueSchema.parse(value);
        environment[automationSecretEnvName(name)] = value;
      }
    }
    environment.OPENSTEER_ACTIVATION_ID = active.desired.activationId;
    environment.OPENSTEER_AUTOMATION_ID = active.desired.triggerId;
    environment.OPENSTEER_CAPABILITIES_PATH = active.capabilitiesPath;
    environment.OPENSTEER_CLI = this.#cliScriptPath;
    environment.OPENSTEER_EVENT = eventFile;
    environment.OPENSTEER_EVENT_PATH = eventFile;
    environment.OPENSTEER_NODE = this.#nodeExecutable;
    environment.OPENSTEER_TRIGGER_ID = active.desired.triggerId;
    environment.OPENSTEER_WATCH = "1";
    const endpoints = active.endpoints?.endpoints;
    if (endpoints) {
      environment.OPENSTEER_MCP_TOKEN = endpoints.mcp.token;
      environment.OPENSTEER_MCP_URL = endpoints.mcp.url;
      if (endpoints.browserCdp) {
        environment.OPENSTEER_CDP_TOKEN = endpoints.browserCdp.token;
        environment.OPENSTEER_CDP_URL = endpoints.browserCdp.url;
      }
    }
    return environment;
  }
}

function watchTailText(value: Buffer): string {
  let bytes = Buffer.from(value.toString("utf8"), "utf8");
  if (bytes.byteLength <= WATCH_LOG_TAIL_BYTES) return bytes.toString("utf8");
  bytes = bytes.subarray(bytes.byteLength - WATCH_LOG_TAIL_BYTES);
  while (bytes.byteLength > 0 && (bytes[0]! & 0xc0) === 0x80) bytes = bytes.subarray(1);
  return bytes.toString("utf8");
}
