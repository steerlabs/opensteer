import {
  createPrivateFileAtomically,
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { delay } from "@opensteer/shared/delay";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { spawnSupervised, type SupervisedProcess } from "@opensteer/harness";
import type { RunnerConfig } from "@opensteer/config";
import {
  TriggerProgramEventSchema,
  TriggerProgramSchema,
  WATCH_LOG_TAIL_BYTES,
  type TriggerProgram,
} from "@opensteer/triggers";
import { createId, type EnvironmentId, type TriggerWatchActivationId } from "@opensteer/core";
import type { RunnerOperationalReport, WatchReconcileActivation } from "@opensteer/protocol";
import { isNodeError } from "@opensteer/shared/nodeError";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerMessageSink } from "../runtime/runtime.js";
import type { RunWorkspace, WorkspaceAccessManager } from "../workspace/mount-manager.js";
import { triggerProgramRuntimeSource } from "../agent/program-runtime.js";
import { startProgramEndpoints, type ProgramEndpointSet } from "../agent/program-endpoints.js";
import type { ProgramLaunchPlanner } from "../agent/program-executor.js";

interface ActiveWatch {
  abort: AbortController;
  capabilitiesPath: string;
  desired: WatchReconcileActivation;
  /** The program's stand-ins for the Host, from start until the watch stops or expires. */
  endpoints?: ProgramEndpointSet;
  healthySince: string | null;
  lastError: string | null;
  lastExitCode: number | null;
  leaseTimer?: NodeJS.Timeout;
  observed: "starting" | "running" | "backoff" | "expired" | "stopped";
  process: SupervisedProcess | undefined;
  restartCount: number;
  sink: RunnerMessageSink;
  stderrTail: Buffer;
  stdoutTail: Buffer;
  task?: Promise<void>;
}

export interface WatchSupervisorOptions {
  readonly environmentId: EnvironmentId;
  readonly nodeExecutable: string;
  /** Confines one program launch; see the Runner's own program launches. */
  readonly planLaunch: (
    executionId: string,
    launch: Parameters<ProgramLaunchPlanner>[0],
  ) => ReturnType<ProgramLaunchPlanner>;
  readonly privateStateDirectory: string;
  /** Ends whatever an execution's program left running. */
  readonly terminate: (executionId: string) => Promise<unknown>;
  readonly transport: Pick<RunnerConfig, "mode">;
  readonly workspaceManager: WorkspaceAccessManager;
}

const maximumProgramResponseBytes = 6 * 512 * 1_024 + 1_024;
const maximumBackoffMs = 5 * 60_000;
const programCacheDirectory = "program-cache-v2";

export class WatchSupervisor {
  readonly #environmentId: EnvironmentId;
  readonly #nodeExecutable: string;
  readonly #planLaunch: WatchSupervisorOptions["planLaunch"];
  readonly #terminate: WatchSupervisorOptions["terminate"];
  readonly #transport: WatchSupervisorOptions["transport"];
  readonly #executionRoot: string;
  readonly #privateRoot: string;
  readonly #watches = new Map<TriggerWatchActivationId, ActiveWatch>();
  readonly #workspaceManager: WorkspaceAccessManager;
  readonly #statusTimer: NodeJS.Timeout;
  #closed = false;
  #privateRootPrepared = false;
  #lastReconcileGeneration = 0;
  #reconcileTail: Promise<void> = Promise.resolve();

  constructor(options: WatchSupervisorOptions) {
    this.#environmentId = options.environmentId;
    this.#nodeExecutable = options.nodeExecutable;
    this.#planLaunch = options.planLaunch;
    this.#terminate = options.terminate;
    this.#transport = options.transport;
    this.#privateRoot = resolve(options.privateStateDirectory, "watches");
    this.#executionRoot = join(this.#privateRoot, "executions", randomUUID());
    this.#workspaceManager = options.workspaceManager;
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
      await Promise.allSettled(active.map(([, watch]) => this.#stop(watch, true)));
      for (const [activationId] of active) this.#watches.delete(activationId);
    });
    this.#reconcileTail = stopped.catch(() => undefined);
    await stopped;
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
        await this.#stop(active, true);
        this.#watches.delete(activationId);
      }
    }
    for (const item of command.desired) {
      const existing = this.#watches.get(item.activationId);
      if (existing) {
        existing.desired = item;
        existing.sink = sink;
        await this.#writeCapabilities(existing);
        this.#armLease(existing);
        if (existing.observed === "expired" || existing.observed === "stopped") {
          existing.abort = new AbortController();
          existing.observed = "starting";
          existing.task = this.#run(existing);
        }
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
    await this.#evictProgramCache(new Set(command.desired.map(({ revisionId }) => revisionId)));
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
      let workspace: RunWorkspace | undefined;
      let materializationRoot: string | undefined;
      let programFile: string | undefined;
      try {
        active.observed = "starting";
        await this.#report(active);
        workspace = await this.#workspaceManager.prepare({
          instructionsPath: null,
          plan: active.desired.workspaceAccess,
          signal: active.abort.signal,
        });
        const program = await this.#cachedProgram(active);
        const materialized = await this.#materialize(active, program, workspace.path);
        materializationRoot = materialized.root;
        programFile = materialized.programFile;
        const environment = watchEnvironment(active, materialized.eventFile);
        const arguments_ = ["--enable-source-maps"];
        if (program.language === "typescript") arguments_.push("--experimental-transform-types");
        arguments_.push(materialized.runtimeFile);
        const launch = (
          await this.#planLaunch(active.desired.activationId, {
            environment,
            privateDirectory: dirname(active.capabilitiesPath),
            workspacePath: workspace.path,
          })
        )({ args: arguments_, cwd: workspace.path, environment, executable: this.#nodeExecutable });
        active.abort.signal.throwIfAborted();
        const process = spawnSupervised({
          args: launch.args,
          cwd: launch.cwd,
          environment: launch.environment,
          executable: launch.executable,
          maxOutputBytes: Number.MAX_SAFE_INTEGER,
        });
        active.process = process;
        active.healthySince = new Date().toISOString();
        active.lastError = null;
        active.observed = "running";
        await this.#report(active);
        const output = Promise.all([
          this.#consume(process.stdout, active, "stdout"),
          this.#consume(process.stderr, active, "stderr"),
        ]);
        const exit = await process.exited;
        await output;
        active.process = undefined;
        active.lastExitCode = exit.code;
        if (active.abort.signal.aborted) break;
        active.restartCount += 1;
        active.lastError = exit.signal
          ? `Watch program ended from ${exit.signal}`
          : `Watch program exited with code ${String(exit.code)}`;
      } catch (error) {
        active.process = undefined;
        if (active.abort.signal.aborted) break;
        active.restartCount += 1;
        active.lastExitCode = null;
        active.lastError = safeMessage(error, {
          fallback: "Watch program failed",
          maximumLength: 20_000,
        });
      } finally {
        if (materializationRoot) {
          await rm(materializationRoot, { force: true, recursive: true }).catch(() => undefined);
        }
        if (programFile) await rm(programFile, { force: true }).catch(() => undefined);
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
    program: TriggerProgram,
    workspacePath: string,
  ): Promise<{
    readonly eventFile: string;
    readonly programFile: string;
    readonly root: string;
    readonly runtimeFile: string;
  }> {
    const root = join(dirname(active.capabilitiesPath), `attempt-${randomUUID()}`);
    await securePrivateDirectory(root);
    const programFile = join(
      workspacePath,
      `.opensteer-watch-${active.desired.activationId}-${active.desired.executionGeneration}-${randomUUID()}.${
        program.language === "typescript" ? "ts" : "mjs"
      }`,
    );
    const runtimeFile = join(root, "runtime.mjs");
    const eventFile = join(root, "event.json");
    const event = TriggerProgramEventSchema.parse({
      id: createId("triggerOccurrence"),
      payload: null,
      receivedAt: new Date().toISOString(),
      source: { kind: "watch" },
      trigger: {
        anchorThreadId: active.desired.anchorThreadId,
        id: active.desired.triggerId,
        revisionId: active.desired.revisionId,
        workspaceId: active.desired.workspaceId,
      },
    });
    try {
      await Promise.all([
        writeFile(programFile, program.source, { flag: "wx", mode: 0o600 }).then(() =>
          setPrivateFileMode(programFile),
        ),
        replacePrivateFileAtomically(
          runtimeFile,
          triggerProgramRuntimeSource(pathToFileURL(programFile).href),
        ),
        replacePrivateFileAtomically(eventFile, JSON.stringify(event)),
      ]);
      return { eventFile, programFile, root, runtimeFile };
    } catch (error) {
      await Promise.all([
        rm(programFile, { force: true }).catch(() => undefined),
        rm(root, { force: true, recursive: true }).catch(() => undefined),
      ]);
      throw error;
    }
  }

  async #preparePrivateRoot(): Promise<void> {
    if (this.#privateRootPrepared) return;
    await securePrivateDirectory(this.#privateRoot);
    await rm(join(this.#privateRoot, "executions"), { force: true, recursive: true });
    // Program validation is an execution contract. An older Runner's
    // unversioned cache is disposable and cannot establish current semantics.
    await rm(join(this.#privateRoot, "program-cache"), { force: true, recursive: true });
    await securePrivateDirectory(this.#executionRoot);
    this.#privateRootPrepared = true;
  }

  async #evictProgramCache(desiredRevisionIds: ReadonlySet<string>): Promise<void> {
    const cacheRoot = join(this.#privateRoot, programCacheDirectory);
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

  async #cachedProgram(active: ActiveWatch): Promise<TriggerProgram> {
    const cachePath = join(
      this.#privateRoot,
      programCacheDirectory,
      `${active.desired.revisionId}.json`,
    );
    const cached = await readPrivateFileText(cachePath, maximumProgramResponseBytes, {
      exposed: () => new Error("Cached watch program permissions are unsafe"),
      invalid: () => new Error("Cached watch program is invalid"),
    });
    if (cached) return TriggerProgramSchema.parse(JSON.parse(cached));
    const url = new URL(
      `/internal/v1/triggers/revisions/${active.desired.revisionId}/program`,
      active.desired.capabilities.mcp.url,
    );
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${active.desired.capabilities.mcp.token}` },
      redirect: "error",
      signal: active.abort.signal,
    });
    if (!response.ok) throw new Error(`Watch program fetch failed (${response.status})`);
    const program = TriggerProgramSchema.parse(
      await readBoundedJson(response, {
        expectedContentType: "application/json",
        maximumBytes: maximumProgramResponseBytes,
        signal: active.abort.signal,
        sizeError: () => new Error("Watch program response exceeds its limit"),
      }),
    );
    await mkdir(dirname(cachePath), { mode: 0o700, recursive: true });
    await createPrivateFileAtomically(cachePath, JSON.stringify(program));
    return program;
  }

  /**
   * The capabilities the program reads: its stand-ins, with the Host's
   * expiries. The Host tokens behind them change with each reconcile; what the
   * program holds does not, and never works anywhere but here.
   */
  async #writeCapabilities(active: ActiveWatch): Promise<void> {
    active.endpoints ??= await startProgramEndpoints({
      capabilities: () => active.desired.capabilities,
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
        integrationMcp: {
          ...endpoints.integrationMcp,
          expiresAt: capabilities.integrationMcp.expiresAt,
        },
        mcp: { ...endpoints.mcp, expiresAt: capabilities.mcp.expiresAt },
      }),
    );
  }

  /** Ends the program's access to the Host and whatever it left running. */
  async #endExecution(active: ActiveWatch): Promise<void> {
    const endpoints = active.endpoints;
    delete active.endpoints;
    endpoints?.revoke();
    await active.process?.terminate(5_000).catch(() => undefined);
    await active.task?.catch(() => undefined);
    await endpoints?.close();
    await this.#terminate(active.desired.activationId).catch(() => undefined);
  }

  #armLease(active: ActiveWatch): void {
    if (active.leaseTimer) clearTimeout(active.leaseTimer);
    const expirations = [
      active.desired.capabilities.mcp.expiresAt,
      active.desired.capabilities.integrationMcp.expiresAt,
      active.desired.capabilities.browserCdp?.expiresAt,
    ].filter((value): value is string => value !== undefined);
    const expiresAt = Math.min(...expirations.map((value) => new Date(value).getTime()));
    active.leaseTimer = setTimeout(
      () => {
        void this.#expire(active);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    active.leaseTimer.unref();
  }

  async #expire(active: ActiveWatch): Promise<void> {
    if (this.#watches.get(active.desired.activationId) !== active) return;
    active.observed = "expired";
    active.abort.abort(new Error("Watch capability lease expired"));
    await this.#endExecution(active);
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
    await active.sink.send(message).catch(() => undefined);
  }
}

function watchTailText(value: Buffer): string {
  let bytes = Buffer.from(value.toString("utf8"), "utf8");
  if (bytes.byteLength <= WATCH_LOG_TAIL_BYTES) return bytes.toString("utf8");
  bytes = bytes.subarray(bytes.byteLength - WATCH_LOG_TAIL_BYTES);
  while (bytes.byteLength > 0 && (bytes[0]! & 0xc0) === 0x80) bytes = bytes.subarray(1);
  return bytes.toString("utf8");
}

function watchEnvironment(active: ActiveWatch, eventFile: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
  ] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  environment.OPENSTEER_ACTIVATION_ID = active.desired.activationId;
  environment.OPENSTEER_CAPABILITIES_PATH = active.capabilitiesPath;
  environment.OPENSTEER_EVENT_PATH = eventFile;
  environment.OPENSTEER_TRIGGER_ID = active.desired.triggerId;
  environment.OPENSTEER_WATCH = "1";
  environment.OPENSTEER_WORKSPACE_ID = active.desired.workspaceId;
  return environment;
}
