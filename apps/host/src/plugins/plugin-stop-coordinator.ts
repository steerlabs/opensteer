import type { RunnerId } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import type { PluginExecutions } from "./plugin-executions.js";
import type { PluginService, PluginServiceState } from "./plugin-service.js";

const defaultAttemptTimeoutMs = 10_000;
const defaultInitialRetryMs = 500;
const defaultMaxRetryMs = 5_000;
const defaultWarnIntervalMs = 60_000;
const personalAutomaticControl = { caller: "personal", mode: "automatic" } as const;

export interface MissingStopConditions {
  readonly engine: string;
  readonly executions: string;
  readonly workflows: string;
}

type AttemptOutcome =
  | { readonly proved: true }
  | { readonly proved: false; readonly missing: MissingStopConditions };

export type PluginStopServicePort = Pick<PluginService, "state" | "agentWork"> &
  Partial<Pick<PluginService, "waitForCleanup">>;

export interface PluginStopCoordinatorOptions {
  readonly pluginService: () => PluginStopServicePort | undefined;
  readonly pluginExecutions: () => Pick<PluginExecutions, "stopAgentWork"> | undefined;
  readonly hasUnfinishedWorkflows: () => Promise<boolean>;
  readonly isCurrent: (identity: RunnerIdentity) => boolean;
  readonly log: { warn(details: Record<string, unknown>, message: string): void };
  readonly attemptTimeoutMs?: number;
  readonly initialRetryMs?: number;
  readonly maxRetryMs?: number;
  readonly warnIntervalMs?: number;
  readonly now?: () => number;
}

function engineNotRunning(status: PluginServiceState["status"]): boolean {
  return status === "stopped" || status === "idle" || status === "unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

function settledBool(result: PromiseSettledResult<boolean>, expected: boolean): string {
  if (result.status === "rejected") return errorMessage(result.reason);
  return result.value === expected ? "ok" : "not-ok";
}

function settledVoid(result: PromiseSettledResult<void>): string {
  return result.status === "fulfilled" ? "ok" : errorMessage(result.reason);
}

/**
 * Tracks whether plugin agent work is proven stopped for the hosting computer's
 * current Stop mode.
 *
 * When the plugin engine is not running, its exited process tree cleanup has
 * completed, and PostgreSQL has no unfinished workflows, Stop is proven without
 * cold-starting workerd (a later engine start reads `agentWorkStopped()` during
 * `init`). Otherwise attempts retry with backoff while that Stop and Runner
 * connection remain current.
 */
export class PluginStopCoordinator {
  readonly #options: PluginStopCoordinatorOptions;
  readonly #attemptTimeoutMs: number;
  readonly #initialRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #warnIntervalMs: number;
  readonly #now: () => number;
  #hostingRunner: RunnerId | undefined;
  #lastMode: string | null = null;
  #proof: string | undefined;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();
  #retryTimer: NodeJS.Timeout | undefined;
  #attemptAbort: AbortController | undefined;
  #lastWarn: { readonly key: string; readonly at: number } | undefined;
  #closed = false;

  constructor(options: PluginStopCoordinatorOptions) {
    this.#options = options;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
    this.#initialRetryMs = options.initialRetryMs ?? defaultInitialRetryMs;
    this.#maxRetryMs = options.maxRetryMs ?? defaultMaxRetryMs;
    this.#warnIntervalMs = options.warnIntervalMs ?? defaultWarnIntervalMs;
    this.#now = options.now ?? (() => Date.now());
  }

  get hostingRunner(): RunnerId | undefined {
    return this.#hostingRunner;
  }

  proofFor(runnerId: RunnerId, computerStopped: boolean): string | undefined {
    return runnerId === this.#hostingRunner && computerStopped ? this.#proof : undefined;
  }

  onHostingRunnerRegistered(identity: RunnerIdentity): void {
    this.#hostingRunner = identity.runnerId;
    const mode = identity.agentsStoppedSince;
    // Normal (not-stopped) Runner registration runs no plugin or database work.
    if (mode === undefined || (mode === null && this.#lastMode === null)) return;
    this.#lastMode = mode;
    this.#proof = undefined;
    this.#cancelPending();
    if (this.#closed) return;
    this.#enqueueAttempt(identity, mode, this.#generation, 1);
  }

  close(): void {
    this.#closed = true;
    this.#cancelPending();
  }

  #cancelPending(): void {
    this.#generation += 1;
    this.#lastWarn = undefined;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#attemptAbort?.abort();
    this.#attemptAbort = undefined;
  }

  #stillActive(identity: RunnerIdentity, generation: number): boolean {
    return !this.#closed && generation === this.#generation && this.#options.isCurrent(identity);
  }

  #scheduleRetry(
    identity: RunnerIdentity,
    mode: string | null,
    generation: number,
    attempt: number,
  ): number {
    const retryInMs = Math.min(
      this.#maxRetryMs,
      this.#initialRetryMs * 2 ** Math.max(0, attempt - 1),
    );
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#stillActive(identity, generation)) return;
      this.#enqueueAttempt(identity, mode, generation, attempt + 1);
    }, retryInMs);
    this.#retryTimer.unref();
    return retryInMs;
  }

  #enqueueAttempt(
    identity: RunnerIdentity,
    mode: string | null,
    generation: number,
    attempt: number,
  ): void {
    this.#tail = this.#tail
      .then(() => this.#runAttempt(identity, mode, generation, attempt))
      .catch((error: unknown) => {
        if (!this.#stillActive(identity, generation)) return;
        const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
        const msg = errorMessage(error);
        this.#warnIfDue(identity, mode, attempt, retryInMs, "unknown", {
          engine: msg,
          executions: msg,
          workflows: msg,
        });
      });
  }

  async #runAttempt(
    identity: RunnerIdentity,
    mode: string | null,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (!this.#stillActive(identity, generation)) return;
    const service = this.#options.pluginService();
    const executions = this.#options.pluginExecutions();
    if (!service || !executions) return;

    const outcome = await this.#attempt(service, executions, mode);
    if (!this.#stillActive(identity, generation)) return;
    if (outcome.proved) {
      if (mode !== null) this.#proof = mode;
      this.#lastWarn = undefined;
      return;
    }
    const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
    this.#warnIfDue(identity, mode, attempt, retryInMs, service.state().status, outcome.missing);
  }

  async #attempt(
    service: PluginStopServicePort,
    executions: Pick<PluginExecutions, "stopAgentWork">,
    mode: string | null,
  ): Promise<AttemptOutcome> {
    const stateBefore = service.state();
    if (mode === null) {
      if (engineNotRunning(stateBefore.status)) return { proved: true };
      const engine = settledBool(await settle(this.#callAgentWork(service, false)), true);
      return engine === "ok"
        ? { proved: true }
        : { proved: false, missing: { engine, executions: "ok", workflows: "ok" } };
    }

    if (engineNotRunning(stateBefore.status)) {
      const [cleanupResult, execResult, workflowsResult] = await Promise.allSettled([
        service.waitForCleanup?.() ?? Promise.resolve(),
        executions.stopAgentWork(),
        this.#options.hasUnfinishedWorkflows(),
      ]);
      const stateAfter = service.state();
      const sameIdle =
        engineNotRunning(stateAfter.status) && stateAfter.generation === stateBefore.generation;
      const missing: MissingStopConditions = {
        engine: settledVoid(cleanupResult),
        executions: settledBool(execResult, true),
        workflows: settledBool(workflowsResult, false),
      };
      if (
        sameIdle &&
        missing.engine === "ok" &&
        missing.executions === "ok" &&
        missing.workflows === "ok"
      )
        return { proved: true };
      // If the engine stayed idle and no unfinished workflows appeared, retry
      // without cold-starting workerd. Otherwise fall through to stop it explicitly.
      if (sameIdle && missing.workflows !== "not-ok") return { proved: false, missing };
    }

    const [engineResult, execResult] = await Promise.allSettled([
      this.#callAgentWork(service, true),
      executions.stopAgentWork(),
    ]);
    const workflowsResult = await settle(this.#options.hasUnfinishedWorkflows());
    const missing: MissingStopConditions = {
      engine: settledBool(engineResult, true),
      executions: settledBool(execResult, true),
      workflows: settledBool(workflowsResult, false),
    };
    return missing.engine === "ok" && missing.executions === "ok" && missing.workflows === "ok"
      ? { proved: true }
      : { proved: false, missing };
  }

  async #callAgentWork(service: PluginStopServicePort, stopped: boolean): Promise<boolean> {
    const attemptAbort = new AbortController();
    this.#attemptAbort = attemptAbort;
    try {
      const signal = AbortSignal.any([
        attemptAbort.signal,
        AbortSignal.timeout(this.#attemptTimeoutMs),
      ]);
      return await service.agentWork({ stopped }, personalAutomaticControl, signal);
    } finally {
      if (this.#attemptAbort === attemptAbort) this.#attemptAbort = undefined;
    }
  }

  #warnIfDue(
    identity: RunnerIdentity,
    mode: string | null,
    attempt: number,
    retryInMs: number,
    engineStatus: string,
    missing: MissingStopConditions,
  ): void {
    const key = `${missing.engine}\0${missing.executions}\0${missing.workflows}`;
    const now = this.#now();
    if (
      this.#lastWarn &&
      this.#lastWarn.key === key &&
      now - this.#lastWarn.at < this.#warnIntervalMs
    )
      return;
    this.#lastWarn = { key, at: now };
    this.#options.log.warn(
      {
        attempt,
        engineStatus,
        missing,
        mode,
        retryInMs,
        runnerId: identity.runnerId,
      },
      mode === null
        ? "Plugin Resume incomplete; retrying"
        : "Plugin Stop proof incomplete; retrying",
    );
  }
}
