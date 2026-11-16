import { fork, type ChildProcess } from "node:child_process";
import { hkdfSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stopProcessGroup } from "@opensteer/shared/processGroup";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  EngineMessageSchema,
  HostMessageSchema,
  operations,
  callbackOperations,
  PluginServiceError,
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

export interface PluginServiceOptions {
  readonly deployment: "personal" | "team";
  readonly databaseUrl: string;
  readonly dataDirectory: string;
  readonly owner: string;
  readonly credentialKey: Uint8Array;
  readonly origin: string;
  readonly bridge?: string;
  readonly processEntry?: URL;
  readonly catalogUrl?: string;
  readonly npmRegistry?: string;
  readonly selfOrigin?: { origin: string; address: string };
  readonly limits?: Partial<EngineInit["limits"]>;
  readonly authorize?: (
    input: PluginAuthorization,
    signal: AbortSignal,
  ) => Promise<PluginAuthorizationResult>;
  readonly providers?: (caller: PluginCaller, signal: AbortSignal) => Promise<PluginHostProvider[]>;
  readonly providerCall?: (
    input: PluginCaller & { execution: string; plugin: string; tool: string; input: PluginJson },
    signal: AbortSignal,
  ) => Promise<PluginJson>;
  readonly eventAuthorize?: (
    input: Record<string, PluginJson>,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly onExecution?: (execution: PluginExecution) => void;
  readonly onDiagnostic?: (phase: string) => void;
  readonly onState?: (state: PluginServiceState) => void;
}
export type PluginServiceState = {
  status: "stopped" | "starting" | "ready" | "restarting" | "unavailable";
  generation: number;
  pid?: number;
  startupMs?: number;
  reason?: string;
};
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Host-owned Promise boundary. Its callbacks are the only route back to Host authority and tools. */
export class PluginService {
  readonly #config: EngineInit;
  readonly #options: PluginServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #callbacks = new Map<string, AbortController>();
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
  #restart: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #healthySince: number | undefined;
  #cleaning: Promise<void> = Promise.resolve();
  constructor(options: PluginServiceOptions) {
    this.#options = options;
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
  state(): PluginServiceState {
    return { ...this.#state };
  }
  #set(state: PluginServiceState) {
    this.#state = state;
    this.#options.onState?.(this.state());
  }
  async start(): Promise<void> {
    if (this.#closed) throw new PluginServiceError("unavailable", "Plugin service is closed");
    if (this.#options.deployment === "team") {
      this.#set({
        status: "unavailable",
        generation: 0,
        reason: "Team Deployments do not run plugins",
      });
      return;
    }
    if (this.#state.status === "ready") return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#launch().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }
  async #launch() {
    await this.#cleaning;
    if (this.#closed) return;
    const generation = this.#state.generation + 1;
    this.#set({ status: "starting", generation });
    const source = import.meta.url.endsWith(".ts");
    const entry =
      this.#options.processEntry ??
      new URL(source ? "./plugin-engine.ts" : "./plugin-engine.js", import.meta.url);
    const child = fork(entry, [], {
      execArgv: entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : [],
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
      if (message.type === "diagnostic") {
        this.#options.onDiagnostic?.(message.phase);
      } else if (message.type === "ready") {
        ready = true;
        this.#healthySince = Date.now();
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
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.#pending.clear();
      for (const pull of this.#pulls.values()) pull.reject(error);
      this.#pulls.clear();
      for (const callback of this.#callbacks.values()) callback.abort();
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
      this.#failures =
        ready && this.#healthySince !== undefined && Date.now() - this.#healthySince >= 60_000
          ? 1
          : this.#failures + 1;
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
          void this.start().catch(() => {});
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
    this.#executions.set(execution.id, execution);
    this.#options.onExecution?.(execution);
  }
  #send(child: ChildProcess, value: unknown) {
    if (child.connected) child.send(HostMessageSchema.parse(value), () => {});
  }
  async #callback(
    child: ChildProcess,
    message: Extract<ReturnType<typeof EngineMessageSchema.parse>, { type: "callback" }>,
  ) {
    const controller = new AbortController();
    this.#callbacks.set(message.id, controller);
    try {
      let result: unknown;
      if (message.operation === "authorize")
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
          message: error instanceof PluginServiceError ? error.message : "Host callback failed",
        },
      });
    } finally {
      this.#callbacks.delete(message.id);
    }
  }
  async request<K extends PluginOperation>(
    operation: K,
    input: PluginInput<K>,
    context: PluginCaller,
    signal?: AbortSignal,
  ): Promise<PluginOutput<K>> {
    signal?.throwIfAborted();
    const child = this.#child;
    if (!child || this.#state.status !== "ready")
      throw new PluginServiceError(
        "unavailable",
        this.#state.reason ?? "Plugin engine is not ready",
      );
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
    });
    return operations[operation].output.parse(result) as PluginOutput<K>;
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
    try {
      while (true) {
        signal?.throwIfAborted();
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
  readonly detail = this.#method("detail");
  readonly install = this.#method("install");
  readonly export = this.#method("export");
  readonly versions = this.#method("versions");
  readonly activate = this.#method("activate");
  readonly remove = this.#method("remove");
  readonly accounts = this.#method("accounts");
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
    if (this.#restart) clearTimeout(this.#restart);
    const child = this.#child;
    if (child) {
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
    await this.#cleaning;
    this.#config.secret = "0".repeat(64);
    this.#set({ status: "stopped", generation: this.#state.generation });
  }
}
