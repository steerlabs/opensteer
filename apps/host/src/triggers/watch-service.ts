import {
  triggerProgramCompatibilityReason,
  type TriggerProgramRunnerStore,
} from "./trigger-program-compatibility.js";
import { runnerAgentToolsFailure, type EnvironmentId, type TriggerId } from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
import type { RunnerIdentity, RunnerRegistry } from "@opensteer/orchestration";
import type { WatchReconcileActivation } from "@opensteer/protocol";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { WATCH_CAPABILITY_RENEWAL_MS, WATCH_START_RETRY_MS } from "@opensteer/triggers";
import type { BrowserService } from "../browser/browser-service.js";
import type { FolderAdmissionService } from "../threads/folder-admission-service.js";
import type {
  WatchCapabilityScope,
  WatchCapabilityTokenService,
  WatchControlTokenService,
} from "./watch-capability.js";
const watchReconcileRetryInitialMs = 5_000;
const watchReconcileRetryMaximumMs = 60_000;
type WatchBrowserTokenService = WatchCapabilityTokenService<"opensteer-watch-browser-cdp">;
type WatchStore = Pick<
  TriggerStore,
  | "applyWatchStatus"
  | "recordWatchUnavailable"
  | "reconcileWatchesForRunner"
  | "watchEnvironmentForTrigger"
  | "watchEnvironments"
>;
export interface WatchServiceOptions {
  readonly browser: Pick<BrowserService, "hasBrowserProfiles">;
  readonly browserCdpUrl: string;
  readonly controlTokens: Pick<WatchControlTokenService, "issue">;
  readonly mcpUrl: string;
  readonly onChanged: () => void;
  readonly onError: (error: unknown, environmentId: EnvironmentId) => void;
  readonly runners: Pick<RunnerRegistry, "identityForEnvironment" | "reconcileWatches">;
  readonly store: WatchStore;
  readonly runnerStore: TriggerProgramRunnerStore;
  readonly watchBrowserTokens: Pick<WatchBrowserTokenService, "issue">;
  readonly folders: Pick<FolderAdmissionService, "assertAvailable">;
}
export class WatchService {
  readonly #browser: WatchServiceOptions["browser"];
  readonly #browserCdpUrl: string;
  readonly #controlTokens: WatchServiceOptions["controlTokens"];
  readonly #mcpUrl: string;
  readonly #onChanged: WatchServiceOptions["onChanged"];
  readonly #onError: WatchServiceOptions["onError"];
  readonly #runners: WatchServiceOptions["runners"];
  readonly #store: WatchStore;
  readonly #runnerStore: TriggerProgramRunnerStore;
  readonly #watchBrowserTokens: WatchServiceOptions["watchBrowserTokens"];
  readonly #folders: WatchServiceOptions["folders"];
  readonly #lifetime = new AbortController();
  readonly #pending = new Map<EnvironmentId, Promise<void>>();
  readonly #knownEnvironments = new Set<EnvironmentId>();
  readonly #reconcileRetryAttempts = new Map<EnvironmentId, number>();
  readonly #reconcileRetryTimers = new Map<EnvironmentId, NodeJS.Timeout>();
  readonly #startRetryTimers = new Map<EnvironmentId, NodeJS.Timeout>();
  #closed = false;
  #renewalTimer: NodeJS.Timeout | undefined;
  constructor(options: WatchServiceOptions) {
    this.#browser = options.browser;
    this.#browserCdpUrl = options.browserCdpUrl;
    this.#controlTokens = options.controlTokens;
    this.#mcpUrl = options.mcpUrl;
    this.#onChanged = options.onChanged;
    this.#onError = options.onError;
    this.#runners = options.runners;
    this.#store = options.store;
    this.#runnerStore = options.runnerStore;
    this.#watchBrowserTokens = options.watchBrowserTokens;
    this.#folders = options.folders;
  }
  start(): void {
    if (this.#closed || this.#renewalTimer) return;
    this.#renewalTimer = setInterval(() => {
      for (const environmentId of this.#connectedEnvironments()) this.changed(environmentId);
    }, WATCH_CAPABILITY_RENEWAL_MS);
    this.#renewalTimer.unref();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort(new Error("Watch service is closing"));
    if (this.#renewalTimer) clearInterval(this.#renewalTimer);
    this.#renewalTimer = undefined;
    for (const timer of this.#startRetryTimers.values()) clearTimeout(timer);
    this.#startRetryTimers.clear();
    for (const timer of this.#reconcileRetryTimers.values()) clearTimeout(timer);
    this.#reconcileRetryTimers.clear();
    this.#reconcileRetryAttempts.clear();
    await Promise.allSettled(this.#pending.values());
  }
  changed(environmentId: EnvironmentId): void {
    void this.#schedule(environmentId, true);
  }
  #schedule(environmentId: EnvironmentId, resetRetryBackoff: boolean): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#knownEnvironments.add(environmentId);
    this.#clearStartRetry(environmentId);
    if (resetRetryBackoff) {
      this.#clearReconcileRetry(environmentId);
      this.#reconcileRetryAttempts.delete(environmentId);
    }
    const prior = this.#pending.get(environmentId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.reconcile(environmentId))
      .then(() => {
        this.#clearReconcileRetry(environmentId);
        this.#reconcileRetryAttempts.delete(environmentId);
      })
      .catch((error: unknown) => {
        this.#onError(error, environmentId);
        this.#scheduleReconcileRetry(environmentId);
      })
      .finally(() => {
        if (this.#pending.get(environmentId) === next) this.#pending.delete(environmentId);
      });
    this.#pending.set(environmentId, next);
    return next;
  }
  async triggerChanged(triggerId: TriggerId): Promise<void> {
    const environmentId = await this.#store.watchEnvironmentForTrigger(triggerId);
    if (environmentId) this.changed(environmentId);
  }
  async deploymentChanged(): Promise<void> {
    const environmentIds = await this.#store.watchEnvironments();
    for (const environmentId of environmentIds) this.changed(environmentId);
  }
  runnerRegistered(identity: RunnerIdentity): void {
    for (const environmentId of identity.environmentIds) this.#knownEnvironments.add(environmentId);
    for (const environmentId of identity.environmentIds) void this.#schedule(environmentId, true);
  }
  async applyStatus(
    identity: RunnerIdentity,
    // The fence is the registry's business and was checked before this runs,
    // so what a watch status means here is only what the Runner observed.
    status: Extract<
      import("@opensteer/protocol").RunnerOperationalReport,
      {
        readonly type: "runner.watch-status";
      }
    >,
  ): Promise<void> {
    const result = await this.#store.applyWatchStatus({
      activationId: status.activationId,
      executionGeneration: status.executionGeneration,
      healthySince: status.healthySince ? new Date(status.healthySince) : null,
      lastError: status.lastError,
      lastExitCode: status.lastExitCode,
      observed: status.observed,
      restartCount: status.restartCount,
      runnerBootId: identity.bootId,
      runnerConnectionGeneration: identity.connectionGeneration,
      runnerId: identity.runnerId,
      stderrTail: status.stderrTail,
      stdoutTail: status.stdoutTail,
    });
    this.#onChanged();
    if (result.autoPaused) this.changed(result.activation.environmentId);
  }
  async reconcile(environmentId: EnvironmentId): Promise<void> {
    const identity = this.#runners.identityForEnvironment(environmentId);
    if (!identity) return;
    const leaseExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const snapshot = await this.#store.reconcileWatchesForRunner({
      environmentId,
      leaseExpiresAt,
      runnerBootId: identity.bootId,
      runnerConnectionGeneration: identity.connectionGeneration,
      runnerId: identity.runnerId,
    });
    const desired: WatchReconcileActivation[] = [];
    const unavailable: {
      readonly activationId: (typeof snapshot.activations)[number]["activation"]["id"];
      readonly executionGeneration: number;
      readonly reason: string;
    }[] = [];
    for (const context of snapshot.activations) {
      const incompatibility =
        runnerAgentToolsFailure(identity.capabilities) ??
        (await triggerProgramCompatibilityReason(
          this.#runnerStore,
          context.activation.environmentId,
          context.toolContractVersion,
        ));
      if (incompatibility) {
        unavailable.push({
          activationId: context.activation.id,
          executionGeneration: context.activation.executionGeneration,
          reason: incompatibility,
        });
        continue;
      }
      const scope: WatchCapabilityScope = {
        activationId: context.activation.id,
        anchorThreadId: context.activation.anchorThreadId,
        createdBy: context.activation.createdBy,
        environmentId: context.activation.environmentId,
        executionGeneration: context.activation.executionGeneration,
        revisionId: context.activation.revisionId,
        triggerId: context.activation.triggerId,
        toolContractVersion: context.toolContractVersion,
      };
      try {
        await this.#folders.assertAvailable(context.location.folder);
      } catch (error) {
        unavailable.push({
          activationId: context.activation.id,
          executionGeneration: context.activation.executionGeneration,
          reason: safeMessage(error, {
            fallback: "The anchor task folder is unavailable",
            maximumLength: 20_000,
          }),
        });
        continue;
      }
      const mcp = this.#controlTokens.issue(scope);
      const hasBrowser = await this.#browser.hasBrowserProfiles(context.activation.createdBy);
      const browserCdp = hasBrowser ? this.#watchBrowserTokens.issue(scope) : null;
      desired.push({
        activationId: context.activation.id,
        anchorThreadId: context.activation.anchorThreadId,
        capabilities: {
          browserCdp: browserCdp
            ? {
                ...browserCdp,
                url: this.#browserCdpUrl,
              }
            : null,
          mcp: {
            ...mcp,
            url: this.#mcpUrl,
          },
        },
        executionGeneration: context.activation.executionGeneration,
        revisionId: context.activation.revisionId,
        triggerId: context.activation.triggerId,
        location: context.location,
      });
    }
    await this.#runners.reconcileWatches(
      environmentId,
      snapshot.reconcileGeneration,
      desired,
      AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]),
    );
    for (const activation of unavailable) {
      await this.#store.recordWatchUnavailable({
        ...activation,
        runnerBootId: identity.bootId,
        runnerConnectionGeneration: identity.connectionGeneration,
        runnerId: identity.runnerId,
      });
      this.#onChanged();
    }
    this.#scheduleStartRetry(environmentId, unavailable.length > 0);
  }
  #scheduleStartRetry(environmentId: EnvironmentId, waiting: boolean): void {
    this.#clearStartRetry(environmentId);
    if (!waiting || this.#closed) return;
    const timer = setTimeout(() => {
      this.#startRetryTimers.delete(environmentId);
      this.changed(environmentId);
    }, WATCH_START_RETRY_MS);
    timer.unref();
    this.#startRetryTimers.set(environmentId, timer);
  }
  #scheduleReconcileRetry(environmentId: EnvironmentId): void {
    if (this.#closed || this.#reconcileRetryTimers.has(environmentId)) return;
    const attempt = (this.#reconcileRetryAttempts.get(environmentId) ?? 0) + 1;
    this.#reconcileRetryAttempts.set(environmentId, attempt);
    const delayMs = Math.min(
      watchReconcileRetryMaximumMs,
      watchReconcileRetryInitialMs * 2 ** Math.min(attempt - 1, 4),
    );
    const timer = setTimeout(() => {
      this.#reconcileRetryTimers.delete(environmentId);
      void this.#schedule(environmentId, false);
    }, delayMs);
    timer.unref();
    this.#reconcileRetryTimers.set(environmentId, timer);
  }
  #clearStartRetry(environmentId: EnvironmentId): void {
    const timer = this.#startRetryTimers.get(environmentId);
    if (timer) clearTimeout(timer);
    this.#startRetryTimers.delete(environmentId);
  }
  #clearReconcileRetry(environmentId: EnvironmentId): void {
    const timer = this.#reconcileRetryTimers.get(environmentId);
    if (timer) clearTimeout(timer);
    this.#reconcileRetryTimers.delete(environmentId);
  }
  *#connectedEnvironments(): Iterable<EnvironmentId> {
    for (const environmentId of this.#knownEnvironments) {
      if (this.#runners.identityForEnvironment(environmentId)) yield environmentId;
    }
  }
}
