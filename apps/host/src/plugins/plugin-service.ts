import { pluginEngineEntry, pluginEngineUnavailableReason } from "./engine-resources.js";
import { PluginSkillCache } from "./plugin-skill-cache.js";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { fork, type ChildProcess } from "node:child_process";
import { hkdfSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stopProcessGroup } from "@opensteer/shared/processGroup";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { engineDemand } from "./engine-storage.js";
import {
  EngineMessageSchema,
  HostMessageSchema,
  operations,
  callbackOperations,
  PluginServiceError,
  PluginBrokerError,
  checkPluginOutputSize,
  parseIpcMessage,
  jsonBytes,
  interactionBytes,
  pluginResultTooLarge,
  type PluginBrokerOperation,
  type PluginBrokerInput,
  type PluginBrokerOutput,
  type PluginOAuthConfiguration,
  type EngineInit,
  type PluginOperation,
  type PluginInput,
  type PluginOutput,
  type PluginCaller,
  type PluginAuthorization,
  type PluginAuthorizationResult,
  type PluginExecution,
  type PluginHostProvider,
  type PluginJson,
} from "./engine-protocol.js";
export { PluginServiceError } from "./engine-protocol.js";
export type {
  PluginCaller,
  PluginExecution,
  PluginHostProvider,
  PluginConsent,
  PluginJson,
} from "./engine-protocol.js";

/** Ask the person a form question for the provider call in flight, through its own execution. */
export type PluginElicit = (
  request: Record<string, PluginJson>,
  signal: AbortSignal,
) => Promise<PluginAnswer>;
export type PluginAnswer = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, PluginJson> | undefined;
};
export interface PluginServiceOptions {
  readonly databaseUrl: string;
  readonly dataDirectory: string;
  readonly owner: string;
  readonly credentialKey: Uint8Array;
  readonly origin: string;
  readonly webhookOrigin?: () => Promise<string | undefined>;
  readonly bridge?: string;
  readonly processEntry?: URL;
  readonly catalogUrl?: string;
  readonly npmRegistry?: string;
  readonly selfOrigin?: { origin: string; address: string };
  readonly limits?: Partial<EngineInit["limits"]>;
  /** Quiet time after which an engine with nothing to do is stopped. Default five minutes. */
  readonly idleMs?: number;
  readonly authorize?: (
    input: PluginAuthorization,
    signal: AbortSignal,
  ) => Promise<PluginAuthorizationResult>;
  readonly providers?: (caller: PluginCaller, signal: AbortSignal) => Promise<PluginHostProvider[]>;
  readonly providerCall?: (
    input: PluginCaller & { execution: string; plugin: string; tool: string; input: PluginJson },
    signal: AbortSignal,
    elicit: PluginElicit,
  ) => Promise<PluginJson>;
  readonly eventAuthorize?: (
    input: Record<string, PluginJson>,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly oauthConfiguration?: (linked: boolean) => Promise<PluginOAuthConfiguration>;
  readonly oauthBroker?: <K extends PluginBrokerOperation>(
    operation: K,
    input: PluginBrokerInput<K>,
    signal: AbortSignal,
  ) => Promise<PluginBrokerOutput<K>>;
  readonly onResourcesChanged?: () => void;
  readonly onExecution?: (execution: PluginExecution) => void;
  readonly onDiagnostic?: (phase: string) => void;
  readonly onState?: (state: PluginServiceState) => void;
}
export type PluginServiceState = {
  /** `idle`: not running; the next request or due background work starts it. */
  status: "stopped" | "idle" | "starting" | "ready" | "restarting" | "unavailable";
  generation: number;
  pid?: number;
  startupMs?: number;
  reason?: string;
  unavailable?: { code: "unsupported-system" | "missing-runtime"; minimumMacOS?: string };
};
const idleCheckMs = 60_000;
/** Saved background work due sooner than this keeps the engine running. */
const keepForMs = 120_000;
/** A stopped engine starts this long before its next saved background work is due. */
const wakeLeadMs = 15_000;
const liveExecution = new Set(["running", "waiting", "answered"]);
// Agent programs run in the engine process. An explicit heap bound stops a runaway one at 1 GiB
// instead of V8's machine-sized default; the supervisor then restarts the lost process.
const engineFlags = ["--max-old-space-size=1024", "--max-semi-space-size=16"];

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Host-owned Promise boundary. Its callbacks are the only route back to Host authority and tools. */
export class PluginService {
  readonly #admissions = new Map<string, { authority: PluginAuthorization; callback: string }>();
  readonly skillCache: PluginSkillCache;
  readonly #versionChanges = new MutationQueue();
  readonly #config: EngineInit;
  readonly #options: PluginServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #callbacks = new Map<string, AbortController>();
  readonly #elicits = new Map<
    string,
    { resolve(value: PluginAnswer): void; reject(error: Error): void }
  >();
  readonly #pulls = new Map<
    string,
    {
      resolve(value: {
        done: boolean;
        chunk?: string | undefined;
        error?: string | undefined;
      }): void;
      reject(error: Error): void;
    }
  >();
  readonly #executions = new Map<string, PluginExecution>();
  #child: ChildProcess | undefined;
  #state: PluginServiceState = { status: "stopped", generation: 0 };
  #closed = false;
  #starting: Promise<void> | undefined;
  #resourceCheck: Promise<void> | undefined;
  #resourcesReady = false;
  #resourceAbort = new AbortController();
  #restart: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #healthySince: number | undefined;
  #cleaning: Promise<void> = Promise.resolve();
  #changed = Promise.withResolvers<void>();
  #idleCheck: ReturnType<typeof setInterval> | undefined;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
  #idleStop: { child: ChildProcess; dueInMs: number | null } | undefined;
  #stopping: Promise<void> | undefined;
  #streams = 0;
  #activity = 0;
  #lastActivity = Date.now();
  readonly #idleMs: number;
  constructor(options: PluginServiceOptions) {
    this.#options = options;
    this.skillCache = new PluginSkillCache(options.dataDirectory, options.databaseUrl);
    this.#idleMs = options.idleMs ?? 300_000;
    const source = import.meta.url.endsWith(".ts");
    this.#config = {
      databaseUrl: options.databaseUrl,
      directory: join(options.dataDirectory, "plugins"),
      owner: options.owner,
      secret: Buffer.from(
        hkdfSync("sha256", options.credentialKey, "", "opensteer/plugin-engine/credentials/v1", 32),
      ).toString("hex"),
      origin: options.origin,
      bridge:
        options.bridge ??
        fileURLToPath(
          new URL(
            source
              ? "../../node_modules/.cache/plugin-engine-bridge.json"
              : "./plugin-engine-bridge.json",
            import.meta.url,
          ),
        ),
      limits: {
        timeoutMs: 300_000,
        maxToolCalls: 100,
        interactionTtlMs: 24 * 60 * 60_000,
        ...options.limits,
      },
      ...(options.catalogUrl === undefined ? {} : { catalogUrl: options.catalogUrl }),
      ...(options.npmRegistry === undefined ? {} : { npmRegistry: options.npmRegistry }),
      ...(options.selfOrigin === undefined ? {} : { selfOrigin: options.selfOrigin }),
    };
  }
  webhookOrigin(): Promise<string | undefined> {
    return this.#options.webhookOrigin?.() ?? Promise.resolve(undefined);
  }
  state(): PluginServiceState {
    return { ...this.#state };
  }
  #set(state: PluginServiceState) {
    this.#state = state;
    this.#options.onState?.(this.state());
    const changed = this.#changed;
    this.#changed = Promise.withResolvers<void>();
    changed.resolve();
  }
  #touch() {
    this.#activity += 1;
    this.#lastActivity = Date.now();
  }
  /**
   * Begin supervising. The engine process runs only while there is work: a request starts it,
   * saved background work starts it when due, and it stops after `idleMs` with nothing to do.
   */
  async start(): Promise<void> {
    if (this.#closed) throw new PluginServiceError("unavailable", "Plugin service is closed");
    await this.#checkResources();
    if (this.#closed || this.#state.status === "unavailable") return;
    this.#idleCheck ??= setInterval(() => {
      if (this.#state.status === "ready") void this.stopIfIdle().catch(() => {});
    }, idleCheckMs).unref();
    await this.#wake();
  }
  #checkResources(): Promise<void> {
    return (this.#resourceCheck ??= pluginEngineUnavailableReason(
      undefined,
      undefined,
      undefined,
      this.#resourceAbort.signal,
    ).then((reason) => {
      if (this.#closed) return;
      if (reason) {
        const { detail, ...unavailable } = reason;
        this.#set({
          status: "unavailable",
          generation: this.#state.generation,
          reason: detail,
          unavailable,
        });
      } else this.#resourcesReady = true;
    }));
  }
  #launchOnce(): Promise<void> {
    if (this.#state.status === "ready" && this.#child) return Promise.resolve();
    this.#starting ??= this.#launch().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }
  async #wake() {
    const stopped = () =>
      !this.#closed &&
      !this.#starting &&
      (this.#state.status === "stopped" || this.#state.status === "idle");
    if (!stopped()) return;
    // Unreadable engine tables start the engine, which owns and migrates them.
    const demand = await engineDemand(this.#options.databaseUrl).catch(() => ({
      busy: true,
      dueInMs: null,
    }));
    if (!stopped()) return;
    if (demand.busy || (demand.dueInMs !== null && demand.dueInMs < keepForMs))
      return this.#launchOnce();
    if (this.#state.status === "stopped")
      this.#set({ status: "idle", generation: this.#state.generation });
    this.#armWake(demand.dueInMs);
  }
  #armWake(dueInMs: number | null) {
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer =
      dueInMs === null
        ? undefined
        : setTimeout(
            () => void this.#wake().catch(() => {}),
            Math.min(Math.max(dueInMs - wakeLeadMs, 0), 3_600_000),
          ).unref();
  }
  #quiet() {
    if (this.#pending.size > 0 || this.#callbacks.size > 0 || this.#streams > 0) return false;
    for (const execution of this.#executions.values())
      if (liveExecution.has(execution.state)) return false;
    return Date.now() - this.#lastActivity >= this.#idleMs;
  }
  /**
   * Stop the engine process when nothing needs it: no request, callback or page stream in flight,
   * no execution running or waiting on the person (paused programs live only in the process), no
   * open workflow or claimed scheduled run, and no saved background work due within two minutes.
   * Resolves true when the engine is not running afterwards.
   */
  async stopIfIdle(): Promise<boolean> {
    const child = this.#child;
    if (this.#state.status === "idle" || this.#state.status === "stopped") return true;
    if (!child || this.#state.status !== "ready" || this.#stopping || !this.#quiet()) return false;
    const activity = this.#activity;
    const demand = await engineDemand(this.#options.databaseUrl).catch(() => undefined);
    if (!demand || demand.busy || (demand.dueInMs !== null && demand.dueInMs < keepForMs))
      return false;
    if (
      activity !== this.#activity ||
      child !== this.#child ||
      this.#stopping ||
      this.#closed ||
      !this.#quiet()
    )
      return false;
    this.#idleStop = { child, dueInMs: demand.dueInMs };
    const stopping = this.#stopChild(child)
      .then(() => this.#cleaning)
      .finally(() => {
        this.#stopping = undefined;
      });
    this.#stopping = stopping;
    await stopping;
    return true;
  }
  async #stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.#send(child, { type: "stop" });
    try {
      await withTimeout(exited, 10_000, {
        timeoutError: () => new Error("Plugin engine did not stop gracefully"),
      });
    } catch {
      if (child.pid) await this.#cleanupTree(child.pid);
      await exited;
    }
  }
  /** The ready engine for a request, starting it first when it is idle. */
  async #ready(signal?: AbortSignal): Promise<ChildProcess> {
    while (true) {
      signal?.throwIfAborted();
      if (this.#stopping) {
        await this.#stopping;
        continue;
      }
      const child = this.#child;
      if (this.#state.status === "ready" && child) return child;
      if (this.#closed) throw new PluginServiceError("unavailable", "Plugin service is closed");
      if (this.#state.status === "unavailable")
        throw new PluginServiceError(
          "unavailable",
          this.#state.reason ?? "Plugin engine is unavailable",
        );
      const waiting = !this.#resourcesReady
        ? this.#checkResources()
        : this.#state.status === "restarting"
          ? this.#changed.promise
          : this.#launchOnce();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        waiting.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
      });
    }
  }
  async #launch() {
    await this.#cleaning;
    if (this.#closed) return;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    const generation = this.#state.generation + 1;
    this.#set({ status: "starting", generation });
    const entry = this.#options.processEntry ?? pluginEngineEntry(import.meta.url);
    const child = fork(entry, [], {
      execArgv: [...engineFlags, ...(entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : [])],
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.#child = child;
    let ready = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    child.on("message", (raw: unknown) => {
      const parsed = EngineMessageSchema.safeParse(raw);
      if (!parsed.success) {
        child.kill("SIGTERM");
        rejectReady(new PluginServiceError("invalid", "Plugin engine sent an invalid message"));
        return;
      }
      const message = parsed.data;
      if (message.type === "resourcesChanged") {
        this.#options.onResourcesChanged?.();
      } else if (message.type === "diagnostic") {
        this.#options.onDiagnostic?.(message.phase);
      } else if (message.type === "ready") {
        ready = true;
        this.#healthySince = Date.now();
        this.#touch();
        this.#set({ status: "ready", generation, pid: message.pid, startupMs: message.startupMs });
        resolveReady();
      } else if (message.type === "fatal") {
        rejectReady(
          new PluginServiceError(message.error.code, message.error.message, message.error.tag),
        );
      } else if (message.type === "streamChunk") {
        this.#pulls.get(message.id)?.resolve(message);
        this.#pulls.delete(message.id);
      } else if (message.type === "execution") {
        this.#report(message.execution);
      } else if (message.type === "callback") {
        void this.#callback(child, message);
      } else if (message.type === "callbackCancel") {
        this.#callbacks.get(message.id)?.abort();
        for (const [lease, entry] of this.#admissions)
          if (entry.callback === message.id) {
            this.#admissions.delete(lease);
            void this.#options
              .authorize?.(
                { ...entry.authority, admission: false, lease },
                new AbortController().signal,
              )
              .catch(() => undefined);
          }
      } else if (message.type === "elicitResult" || message.type === "elicitError") {
        const pending = this.#elicits.get(message.id);
        this.#elicits.delete(message.id);
        if (message.type === "elicitResult") pending?.resolve(message.response);
        else pending?.reject(new PluginServiceError(message.error.code, message.error.message));
      } else {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        pending.cleanup();
        if (message.type === "error")
          pending.reject(
            new PluginServiceError(message.error.code, message.error.message, message.error.tag),
          );
        else pending.resolve(message.result);
      }
    });
    child.once("error", (error) => rejectReady(error));
    child.once("exit", () => {
      const error = new PluginServiceError(
        "interrupted",
        "Plugin engine stopped; earlier calls may have taken effect. Check current state before repeating them.",
      );
      rejectReady(error);
      this.#child = undefined;
      for (const [lease, { authority }] of this.#admissions)
        void this.#options
          .authorize?.({ ...authority, admission: false, lease }, new AbortController().signal)
          .catch(() => undefined);
      this.#admissions.clear();
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.#pending.clear();
      for (const pull of this.#pulls.values()) pull.reject(error);
      this.#pulls.clear();
      for (const callback of this.#callbacks.values()) callback.abort();
      for (const elicit of this.#elicits.values()) elicit.reject(error);
      this.#elicits.clear();
      for (const execution of this.#executions.values())
        if (["running", "waiting", "answered"].includes(execution.state))
          this.#report({
            ...execution,
            state: "interrupted",
            interaction: null,
            reason: error.message,
          });
      const pid = child.pid;
      this.#cleaning = pid === undefined ? Promise.resolve() : this.#cleanupTree(pid);
      if (this.#closed) return;
      const healthy =
        ready && this.#healthySince !== undefined && Date.now() - this.#healthySince >= 60_000;
      if (this.#idleStop?.child === child) {
        const { dueInMs } = this.#idleStop;
        this.#idleStop = undefined;
        if (healthy) this.#failures = 0;
        this.#set({ status: "idle", generation });
        this.#armWake(dueInMs);
        return;
      }
      this.#failures = healthy ? 1 : this.#failures + 1;
      if (this.#failures >= 3) {
        this.#set({
          status: "unavailable",
          generation,
          reason: "Plugin engine repeatedly stopped",
        });
        return;
      }
      this.#set({
        status: "restarting",
        generation,
        reason: ready ? error.message : "Plugin engine could not start",
      });
      this.#restart = setTimeout(
        () => {
          this.#restart = undefined;
          void this.#launchOnce().catch(() => {});
        },
        250 * 2 ** (this.#failures - 1),
      );
    });
    this.#send(child, { type: "init", config: this.#config });
    try {
      await withTimeout(started, 30_000, {
        timeoutError: () =>
          new PluginServiceError("unavailable", "Plugin engine readiness timed out"),
      });
    } catch (error) {
      child.kill("SIGTERM");
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
        await this.#cleanupTree(child.pid);
      throw error;
    }
  }
  async #cleanupTree(pid: number) {
    if (process.platform !== "win32") await stopProcessGroup(pid, { graceMs: 250 });
    else {
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) =>
        execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => resolve()),
      );
    }
  }
  #report(execution: PluginExecution) {
    if (liveExecution.has(execution.state)) this.#executions.set(execution.id, execution);
    else this.#executions.delete(execution.id);
    this.#options.onExecution?.(execution);
  }
  #send(child: ChildProcess, value: unknown) {
    if (child.connected) child.send(parseIpcMessage(HostMessageSchema, value), () => {});
  }
  #elicit(
    child: ChildProcess,
    callback: string,
    request: Record<string, PluginJson>,
    signal: AbortSignal,
  ): Promise<PluginAnswer> {
    if (jsonBytes(request) > interactionBytes)
      return Promise.reject(new PluginServiceError("invalid", pluginResultTooLarge));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        if (!this.#elicits.delete(id)) return;
        this.#send(child, { type: "elicitCancel", id });
        reject(new PluginServiceError("cancelled", "The question was cancelled"));
      };
      this.#elicits.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else {
        try {
          this.#send(child, { type: "elicit", id, callback, request });
        } catch (error) {
          this.#elicits.delete(id);
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      }
    });
  }
  async #callback(
    child: ChildProcess,
    message: Extract<ReturnType<typeof EngineMessageSchema.parse>, { type: "callback" }>,
  ) {
    const controller = new AbortController();
    this.#callbacks.set(message.id, controller);
    this.#touch();
    try {
      let result: unknown;
      if (message.operation === "oauthConfiguration")
        result = (await this.#options.oauthConfiguration?.(
          callbackOperations.oauthConfiguration.input.parse(message.input).linked,
        )) ?? { clients: [] };
      else if (message.operation.startsWith("oauth")) {
        if (!this.#options.oauthBroker) throw new PluginBrokerError("unavailable");
        const operation = message.operation as PluginBrokerOperation;
        result = await this.#options.oauthBroker(
          operation,
          callbackOperations[operation].input.parse(message.input),
          controller.signal,
        );
      } else if (message.operation === "authorize") {
        result = this.#options.authorize
          ? await this.#options.authorize(
              callbackOperations.authorize.input.parse(message.input),
              controller.signal,
            )
          : {
              allowed:
                callbackOperations.authorize.input.parse(message.input).caller ===
                  this.#options.owner ||
                callbackOperations.authorize.input
                  .parse(message.input)
                  .caller.startsWith(this.#options.owner + ":"),
            };
        const authority = callbackOperations.authorize.input.parse(message.input);
        const permission = callbackOperations.authorize.output.parse(result);
        if (authority.lease) this.#admissions.delete(authority.lease);
        else if (permission.lease) {
          if (controller.signal.aborted || !child.connected) {
            await this.#options.authorize?.(
              { ...authority, admission: false, lease: permission.lease },
              new AbortController().signal,
            );
            throw new PluginServiceError("cancelled", "Plugin admission was cancelled");
          }
          this.#admissions.set(permission.lease, { authority, callback: message.id });
        }
      } else if (message.operation === "webhookOrigin")
        result = (await this.webhookOrigin()) ?? null;
      else if (message.operation === "providers")
        result =
          (await this.#options.providers?.(
            callbackOperations.providers.input.parse(message.input),
            controller.signal,
          )) ?? [];
      else if (message.operation === "providerCall") {
        if (!this.#options.providerCall)
          throw new PluginServiceError("unavailable", "Host provider is unavailable");
        result = await this.#options.providerCall(
          callbackOperations.providerCall.input.parse(message.input),
          controller.signal,
          (request, signal) => this.#elicit(child, message.id, request, signal),
        );
      } else
        result =
          (await this.#options.eventAuthorize?.(
            callbackOperations.eventAuthorize.input.parse(message.input),
            controller.signal,
          )) ?? false;
      this.#send(child, {
        type: "callbackResult",
        id: message.id,
        result:
          callbackOperations[message.operation as keyof typeof callbackOperations].output.parse(
            result,
          ),
      });
    } catch (error) {
      this.#send(child, {
        type: "callbackError",
        id: message.id,
        error: {
          code: error instanceof PluginServiceError ? error.code : "engine",
          message:
            error instanceof PluginServiceError
              ? error.message.slice(0, 4000)
              : "Host callback failed",
          ...(error instanceof PluginBrokerError ? { brokerReason: error.reason } : {}),
        },
      });
    } finally {
      this.#callbacks.delete(message.id);
      this.#touch();
    }
  }
  request<K extends PluginOperation>(
    operation: K,
    input: PluginInput<K>,
    context: PluginCaller,
    signal?: AbortSignal,
  ): Promise<PluginOutput<K>> {
    return operation === "install" || operation === "activate" || operation === "remove"
      ? this.#versionChanges.run(() => this.#request(operation, input, context, signal))
      : this.#request(operation, input, context, signal);
  }
  resourcesRead = (
    input: PluginInput<"resourcesRead">,
    context: PluginCaller,
    signal?: AbortSignal,
  ) => this.#request("resourcesRead", input, context, signal);
  resourcesUpdate = (
    input: PluginInput<"resourcesUpdate">,
    context: PluginCaller,
    signal?: AbortSignal,
  ) => this.#request("resourcesUpdate", input, context, signal);
  async #request<K extends PluginOperation>(
    operation: K,
    input: PluginInput<K>,
    context: PluginCaller,
    signal?: AbortSignal,
  ): Promise<PluginOutput<K>> {
    signal?.throwIfAborted();
    this.#touch();
    const child = await this.#ready(signal);
    signal?.throwIfAborted();
    const id = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        this.#send(child, { type: "cancel", id });
        reject(
          new PluginServiceError(
            "cancelled",
            "Plugin operation cancelled; earlier calls may have taken effect",
          ),
        );
      };
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.#send(child, {
          type: "request",
          id,
          operation,
          context,
          input: operations[operation].input.parse(input),
        });
      } catch (error) {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    }).finally(() => this.#touch());
    checkPluginOutputSize(operation, result);
    const parsed = operations[operation].output.parse(result) as PluginOutput<K>;
    if (operation === "list") {
      const plugins = await Promise.all(
        operations.list.output.parse(parsed).map(async (plugin) => ({
          ...plugin,
          ...((await this.skillCache.get(plugin.id))?.hasPage
            ? { page: { kind: "plugin" as const, pluginId: plugin.id } }
            : {}),
        })),
      );
      return operations.list.output.parse(plugins) as PluginOutput<K>;
    }
    if (operation === "install") {
      const installed = operations.install.output.parse(parsed);
      if (installed.status === "installed") await this.#cacheVersion(installed.plugin.id, signal);
    } else if (operation === "activate") {
      await this.#cacheVersion(operations.activate.input.parse(input).plugin, signal);
    } else if (operation === "remove") {
      await this.skillCache.remove(operations.remove.input.parse(input).plugin);
    }
    return parsed;
  }
  async #cacheVersion(plugin: string, signal?: AbortSignal) {
    const context: PluginCaller = { caller: this.#options.owner, mode: "automatic" };
    const [bundle, source, plugins] = await Promise.all([
      this.skillFiles({ plugin }, context, signal),
      this.export({ plugin }, context, signal),
      this.list({}, context, signal),
    ]);
    const current = plugins.find((entry) => entry.id === plugin);
    if (!current) throw new PluginServiceError("invalid", "Plugin disappeared during activation");
    await this.skillCache.record(
      current,
      bundle,
      source.some((file) => file.path === "ui/index.html"),
    );
  }
  discardStream(id: string): void {
    if (this.#child) this.#send(this.#child, { type: "cancel", id });
  }
  async *readStream(id: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const child = this.#child;
    if (!child) throw new PluginServiceError("unavailable", "Plugin engine is unavailable");
    const abort = () => {
      this.#send(child, { type: "cancel", id });
      this.#pulls
        .get(id)
        ?.reject(new PluginServiceError("cancelled", "Plugin page stream cancelled"));
      this.#pulls.delete(id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.#streams += 1;
    try {
      while (true) {
        signal?.throwIfAborted();
        this.#touch();
        const chunk = await new Promise<{
          done: boolean;
          chunk?: string | undefined;
          error?: string | undefined;
        }>((resolve, reject) => {
          this.#pulls.set(id, { resolve, reject });
          this.#send(child, { type: "streamPull", id });
        });
        if (chunk.error) throw new PluginServiceError("interrupted", chunk.error);
        if (chunk.done) return;
        if (chunk.chunk) yield Buffer.from(chunk.chunk, "base64");
      }
    } finally {
      this.#streams -= 1;
      this.#touch();
      signal?.removeEventListener("abort", abort);
      this.#send(child, { type: "cancel", id });
      this.#pulls.delete(id);
    }
  }
  #method<K extends PluginOperation>(operation: K) {
    return (
      input: PluginInput<K>,
      context: PluginCaller,
      signal?: AbortSignal,
    ): Promise<PluginOutput<K>> => this.request(operation, input, context, signal);
  }
  readonly health = this.#method("health");
  readonly catalogList = this.#method("catalogList");
  readonly catalogDetail = this.#method("catalogDetail");
  readonly list = this.#method("list");
  readonly installed = this.#method("installed");
  readonly detail = this.#method("detail");
  readonly install = this.#method("install");
  readonly export = this.#method("export");
  readonly versions = this.#method("versions");
  readonly activate = this.#method("activate");
  readonly remove = this.#method("remove");
  readonly accounts = this.#method("accounts");
  readonly pinOAuth = this.#method("pinOAuth");
  readonly prepareOAuth = this.#method("prepareOAuth");
  readonly oauthMethods = this.#method("oauthMethods");
  readonly startOAuth = this.#method("startOAuth");
  readonly completeOAuth = this.#method("completeOAuth");
  readonly cancelOAuth = this.#method("cancelOAuth");
  readonly oauthStatus = this.#method("oauthStatus");
  readonly detailSection = this.#method("detailSection");
  readonly saveOAuthApp = this.#method("saveOAuthApp");
  readonly removeOAuthApp = this.#method("removeOAuthApp");
  readonly createApiKeyAccount = this.#method("createApiKeyAccount");
  readonly removeAccount = this.#method("removeAccount");
  readonly reviewAccountLink = this.#method("reviewAccountLink");
  readonly linkAccount = this.#method("linkAccount");
  readonly unlinkAccount = this.#method("unlinkAccount");
  readonly search = this.#method("search");
  readonly describe = this.#method("describe");
  readonly call = this.#method("call");
  readonly execute = this.#method("execute");
  readonly resume = this.#method("resume");
  readonly answer = this.#method("answer");
  readonly cancel = this.#method("cancel");
  readonly executions = this.#method("executions");
  readonly skills = this.#method("skills");
  readonly skillFiles = this.#method("skillFiles");
  readonly manage = this.#method("manage");
  readonly webhook = this.#method("webhook");
  readonly page = this.#method("page");
  listExecutions(): PluginExecution[] {
    return [...this.#executions.values()];
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#resourceAbort.abort();
    await this.#resourceCheck;
    if (this.#restart) clearTimeout(this.#restart);
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    if (this.#idleCheck) clearInterval(this.#idleCheck);
    const child = this.#child;
    if (child) await this.#stopChild(child);
    await this.#stopping;
    await this.#cleaning;
    this.#config.secret = "0".repeat(64);
    this.#set({ status: "stopped", generation: this.#state.generation });
  }
}
