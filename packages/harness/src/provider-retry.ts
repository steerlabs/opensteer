import { runRetryMessageMaxLength, utf8Prefix, type RunRetry } from "@opensteer/core";
import { networkCredentialSecrets, redactNetworkCredentials } from "@opensteer/shared/safeMessage";
import type { HarnessDurableEvent, HarnessLog } from "./types.js";

/**
 * Longest wall-clock window a single provider retry episode may hold a turn
 * without producing model output before the harness interrupts and fails it.
 *
 * Matches T3 Code's `PROVIDER_RETRY_BUDGET_MS`: providers such as Codex can
 * retry for 25+ minutes (or indefinitely while waiting on the network), so
 * counting attempts alone never bounds how long a task can sit silent.
 */
export const providerRetryBudgetMs = 10 * 60 * 1_000;

const defaultRetrySource = "root";

export interface ProviderRetryInput {
  readonly source?: string | undefined;
  readonly attempt?: number | null;
  readonly maxAttempts?: number | null;
  readonly retryDelayMs?: number | null;
  readonly code?: string | null;
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ProviderRetryRecord {
  readonly source: string;
  readonly attempt: number;
  readonly maxAttempts: number | null;
  readonly retryDelayMs: number | null;
  readonly code: string | null;
  readonly message: string;
  readonly startedAtMs: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ProviderRetryTrackerOptions {
  readonly publish: (event: HarnessDurableEvent) => void;
  readonly onBudgetExceeded: (record: ProviderRetryRecord) => void;
  readonly budgetMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: HarnessLog | undefined;
  readonly logContext?: Readonly<Record<string, unknown>> | undefined;
  readonly secrets?: readonly string[] | undefined;
}

export function formatRetryBudgetMessage(
  record: Pick<ProviderRetryRecord, "message">,
  budgetMs: number,
): string {
  const detail = record.message.trim();
  const mins = Math.round(budgetMs / 60_000);
  const window =
    budgetMs >= 60_000 && budgetMs % 60_000 === 0
      ? `${mins} ${mins === 1 ? "minute" : "minutes"}`
      : `${Math.max(1, Math.round(budgetMs / 1_000))}s`;
  const prefix = `Provider stayed in retries for ${window}`;
  return detail ? `${prefix}: ${detail}` : prefix;
}

interface ActiveRetryEpisode {
  record: ProviderRetryRecord;
  timer: ReturnType<typeof setTimeout>;
}

function retryingEventData(record: ProviderRetryRecord): RunRetry {
  return {
    status: "retrying",
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    ...(record.retryDelayMs !== null ? { retryDelayMs: record.retryDelayMs } : {}),
    ...(record.code !== null ? { code: record.code } : {}),
    message: record.message,
  };
}

/**
 * Tracks a turn's active provider-retry episodes by source (root turn or child
 * session/thread), emits durable `run.retry` transitions, logs retries to the
 * Runner log, and enforces one wall-clock deadline per source anchored to its
 * first retry notice so repeated notices or output from an unrelated source
 * cannot extend or clear a stalled source's budget.
 */
export class ProviderRetryTracker {
  readonly #publish: (event: HarnessDurableEvent) => void;
  readonly #onBudgetExceeded: (record: ProviderRetryRecord) => void;
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #log: HarnessLog | undefined;
  readonly #logContext: Readonly<Record<string, unknown>> | undefined;
  readonly #secrets: readonly string[] | undefined;
  readonly #episodes = new Map<string, ActiveRetryEpisode>();
  #disposed = false;

  constructor(options: ProviderRetryTrackerOptions) {
    this.#publish = options.publish;
    this.#onBudgetExceeded = options.onBudgetExceeded;
    this.#budgetMs =
      options.budgetMs !== undefined && Number.isFinite(options.budgetMs) && options.budgetMs > 0
        ? options.budgetMs
        : providerRetryBudgetMs;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#logContext = options.logContext;
    this.#secrets = options.secrets;
  }

  /** Most recently updated active retry episode across all sources, or null. */
  get current(): ProviderRetryRecord | null {
    let latest: ProviderRetryRecord | null = null;
    for (const episode of this.#episodes.values()) latest = episode.record;
    return latest;
  }

  get budgetMs(): number {
    return this.#budgetMs;
  }

  noteRetry(input: ProviderRetryInput): void {
    if (this.#disposed) return;
    const source = input.source?.trim() || defaultRetrySource;
    const now = this.#now();
    const existing = this.#episodes.get(source);
    const previous = existing?.record;
    const startedAtMs = previous ? previous.startedAtMs : now;
    const attempt =
      typeof input.attempt === "number" && Number.isFinite(input.attempt) && input.attempt >= 1
        ? Math.trunc(input.attempt)
        : (previous?.attempt ?? 0) + 1;
    const maxAttempts =
      typeof input.maxAttempts === "number" &&
      Number.isFinite(input.maxAttempts) &&
      input.maxAttempts >= 1
        ? Math.trunc(input.maxAttempts)
        : null;
    const retryDelayMs =
      typeof input.retryDelayMs === "number" &&
      Number.isFinite(input.retryDelayMs) &&
      input.retryDelayMs >= 0
        ? Math.trunc(input.retryDelayMs)
        : null;
    const rawCode = input.code?.trim();
    const code = rawCode ? utf8Prefix(rawCode, 128) : null;
    const secrets = this.#secrets ?? networkCredentialSecrets(process.env);
    const message =
      utf8Prefix(
        redactNetworkCredentials(input.message.trim(), secrets),
        runRetryMessageMaxLength,
      ) || "Provider is retrying";
    const record: ProviderRetryRecord = {
      source,
      attempt,
      maxAttempts,
      retryDelayMs,
      code,
      message,
      startedAtMs,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    if (existing) {
      // Refresh insertion order so `current` reflects the latest notice without resetting the timer.
      existing.record = record;
      this.#episodes.delete(source);
      this.#episodes.set(source, existing);
    } else {
      const remainingMs = Math.max(0, this.#budgetMs - (now - startedAtMs));
      const timer = setTimeout(() => {
        if (this.#disposed) return;
        const expiredEpisode = this.#episodes.get(source);
        if (!expiredEpisode) return;
        const expired = expiredEpisode.record;
        this.dispose();
        this.#log?.("warn", "Provider retry budget exhausted; failing turn", {
          ...this.#logContext,
          source: expired.source,
          attempt: expired.attempt,
          maxAttempts: expired.maxAttempts,
          budgetMs: this.#budgetMs,
          ...(expired.code !== null ? { code: expired.code } : {}),
          message: expired.message,
        });
        try {
          this.#onBudgetExceeded(expired);
        } catch (error) {
          this.#log?.("warn", "Provider retry budget handler failed", {
            ...this.#logContext,
            error: redactNetworkCredentials(
              error instanceof Error ? error.message : String(error),
              this.#secrets ?? networkCredentialSecrets(process.env),
            ),
          });
        }
      }, remainingMs);
      this.#episodes.set(source, { record, timer });
    }
    this.#log?.("warn", "Provider retrying turn", {
      ...this.#logContext,
      source,
      attempt,
      maxAttempts,
      ...(retryDelayMs !== null ? { retryDelayMs } : {}),
      ...(code !== null ? { code } : {}),
      message,
    });
    this.#publish({ type: "run.retry", data: retryingEventData(record) });
  }

  /**
   * Fast O(1) no-op unless `source` is currently inside a retry episode.
   * When another source is still retrying, republishes that active source so
   * the Host/UI continues showing the remaining retry instead of clearing it.
   */
  recover(source = defaultRetrySource): void {
    if (this.#disposed || this.#episodes.size === 0) return;
    const key = source.trim() || defaultRetrySource;
    const episode = this.#episodes.get(key);
    if (!episode) return;
    clearTimeout(episode.timer);
    this.#episodes.delete(key);
    const remaining = this.current;
    if (remaining) {
      this.#publish({ type: "run.retry", data: retryingEventData(remaining) });
      return;
    }
    const last = episode.record;
    const data: RunRetry = {
      status: "recovered",
      attempt: last.attempt,
      maxAttempts: last.maxAttempts,
      ...(last.code !== null ? { code: last.code } : {}),
      message: last.message,
    };
    this.#publish({ type: "run.retry", data });
  }

  dispose(): void {
    this.#disposed = true;
    for (const episode of this.#episodes.values()) clearTimeout(episode.timer);
    this.#episodes.clear();
  }
}
