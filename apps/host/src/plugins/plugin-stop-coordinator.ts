import type { RunnerId } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import type { PluginExecutions } from "./plugin-executions.js";
import type { PluginService, PluginServiceState } from "./plugin-service.js";

const defaultAttemptTimeoutMs = 10_000;
const defaultInitialRetryMs = 500;
const defaultMaxRetryMs = 5_000;
const personalAutomaticControl = { caller: "personal", mode: "automatic" } as const;

export interface PluginStopCoordinatorOptions {
  readonly pluginService: () => Pick<PluginService, "state" | "agentWork"> | undefined;
  readonly pluginExecutions: () => Pick<PluginExecutions, "stopAgentWork"> | undefined;
  readonly hasUnfinishedWorkflows: () => Promise<boolean>;
  readonly isCurrent: (identity: RunnerIdentity) => boolean;
  readonly log: { warn(details: Record<string, unknown>, message: string): void };
  readonly attemptTimeoutMs?: number;
  readonly initialRetryMs?: number;
  readonly maxRetryMs?: number;
}

function engineNotRunning(status: PluginServiceState["status"]): boolean {
  return status === "stopped" || status === "idle" || status === "unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks whether plugin agent work is proven stopped for the hosting computer's
 * current Stop mode.
 *
 * When the plugin engine is idle/stopped and PostgreSQL has no unfinished
 * workflows, Stop is proven without cold-starting workerd (a later engine start
 * reads `agentWorkStopped()` during `init`). When the engine is starting or
 * running, or workflows are still unfinished, attempts retry with backoff while
 * that Stop and Runner connection remain current.
 */
export class PluginStopCoordinator {
  readonly #options: PluginStopCoordinatorOptions;
  readonly #attemptTimeoutMs: number;
  readonly #initialRetryMs: number;
  readonly #maxRetryMs: number;
  #hostingRunner: RunnerId | undefined;
  #lastMode: string | null = null;
  #proof: string | undefined;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();
  #retryTimer: NodeJS.Timeout | undefined;
  #attemptAbort: AbortController | undefined;
  #closed = false;

  constructor(options: PluginStopCoordinatorOptions) {
    this.#options = options;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
    this.#initialRetryMs = options.initialRetryMs ?? defaultInitialRetryMs;
    this.#maxRetryMs = options.maxRetryMs ?? defaultMaxRetryMs;
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

  #retryDelayMs(attempt: number): number {
    return Math.min(this.#maxRetryMs, this.#initialRetryMs * 2 ** Math.max(0, attempt - 1));
  }

  #scheduleRetry(
    identity: RunnerIdentity,
    mode: string | null,
    generation: number,
    attempt: number,
  ): number {
    const retryInMs = this.#retryDelayMs(attempt);
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
        this.#options.log.warn(
          {
            attempt,
            err: error,
            mode,
            retryInMs,
            runnerId: identity.runnerId,
          },
          "Plugin Stop proof attempt failed; retrying",
        );
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

    const statusBefore = service.state().status;
    if (mode === null) {
      if (engineNotRunning(statusBefore)) return;
      const attemptAbort = new AbortController();
      this.#attemptAbort = attemptAbort;
      try {
        const signal = AbortSignal.any([
          attemptAbort.signal,
          AbortSignal.timeout(this.#attemptTimeoutMs),
        ]);
        const resumed = await service.agentWork(
          { stopped: false },
          personalAutomaticControl,
          signal,
        );
        if (resumed) return;
        if (!this.#stillActive(identity, generation)) return;
        const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
        this.#options.log.warn(
          {
            attempt,
            engineStatus: service.state().status,
            retryInMs,
            runnerId: identity.runnerId,
          },
          "Plugin Resume did not complete; retrying",
        );
      } catch (error: unknown) {
        if (!this.#stillActive(identity, generation)) return;
        const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
        this.#options.log.warn(
          {
            attempt,
            engineStatus: service.state().status,
            err: error,
            retryInMs,
            runnerId: identity.runnerId,
          },
          "Plugin Resume failed; retrying",
        );
      } finally {
        if (this.#attemptAbort === attemptAbort) this.#attemptAbort = undefined;
      }
      return;
    }

    // Stop mode: fast path when the engine is not running and no workflows are unfinished.
    if (engineNotRunning(statusBefore)) {
      const [execResult, workflowsResult] = await Promise.allSettled([
        executions.stopAgentWork(),
        this.#options.hasUnfinishedWorkflows(),
      ]);
      if (!this.#stillActive(identity, generation)) return;
      const statusAfter = service.state().status;
      const executionsOk = execResult.status === "fulfilled" && execResult.value === true;
      const executionsError =
        execResult.status === "rejected" ? errorMessage(execResult.reason) : undefined;
      const workflowsDone =
        workflowsResult.status === "fulfilled" && workflowsResult.value === false;
      const workflowsError =
        workflowsResult.status === "rejected" ? errorMessage(workflowsResult.reason) : undefined;
      const unfinishedWorkflows =
        workflowsResult.status === "fulfilled" ? workflowsResult.value : undefined;

      if (executionsOk && workflowsDone && engineNotRunning(statusAfter)) {
        this.#proof = mode;
        return;
      }
      // If the engine was not started and only executions/DB failed, retry without
      // cold-starting workerd. If the engine started concurrently or unfinished
      // workflows exist in PostgreSQL, fall through to stop the engine explicitly.
      if (engineNotRunning(statusAfter) && unfinishedWorkflows !== true) {
        const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
        this.#options.log.warn(
          {
            attempt,
            engineStatus: statusAfter,
            executionsError,
            executionsOk,
            retryInMs,
            runnerId: identity.runnerId,
            unfinishedWorkflows,
            workflowsError,
          },
          "Plugin Stop proof incomplete while engine idle; retrying",
        );
        return;
      }
    }

    // Engine is starting/running/restarting or workflows are unfinished: tell the
    // engine to stop agent work, stop in-flight executions, and recheck workflows.
    const attemptAbort = new AbortController();
    this.#attemptAbort = attemptAbort;
    let backgroundResult: PromiseSettledResult<boolean>;
    let execResult: PromiseSettledResult<boolean>;
    try {
      const signal = AbortSignal.any([
        attemptAbort.signal,
        AbortSignal.timeout(this.#attemptTimeoutMs),
      ]);
      [backgroundResult, execResult] = await Promise.allSettled([
        service.agentWork({ stopped: true }, personalAutomaticControl, signal),
        executions.stopAgentWork(),
      ]);
    } finally {
      if (this.#attemptAbort === attemptAbort) this.#attemptAbort = undefined;
    }
    if (!this.#stillActive(identity, generation)) return;

    const backgroundOk = backgroundResult.status === "fulfilled" && backgroundResult.value === true;
    const backgroundError =
      backgroundResult.status === "rejected" ? errorMessage(backgroundResult.reason) : undefined;
    const executionsOk = execResult.status === "fulfilled" && execResult.value === true;
    const executionsError =
      execResult.status === "rejected" ? errorMessage(execResult.reason) : undefined;

    let unfinishedWorkflows: boolean | undefined;
    let workflowsError: string | undefined;
    try {
      unfinishedWorkflows = await this.#options.hasUnfinishedWorkflows();
    } catch (error: unknown) {
      workflowsError = errorMessage(error);
    }
    if (!this.#stillActive(identity, generation)) return;

    if (backgroundOk && executionsOk && unfinishedWorkflows === false) {
      this.#proof = mode;
      return;
    }

    const retryInMs = this.#scheduleRetry(identity, mode, generation, attempt);
    this.#options.log.warn(
      {
        attempt,
        backgroundError,
        backgroundOk,
        engineStatus: service.state().status,
        executionsError,
        executionsOk,
        retryInMs,
        runnerId: identity.runnerId,
        unfinishedWorkflows,
        workflowsError,
      },
      "Plugin Stop proof incomplete; retrying",
    );
  }
}
