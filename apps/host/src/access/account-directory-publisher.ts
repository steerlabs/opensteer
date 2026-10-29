import { safeMessage } from "@opensteer/shared/safeMessage";
import type { AccountDirectoryProjection, AccountDirectoryStore } from "@opensteer/database";

export interface AccountDirectoryPublisherOptions {
  readonly intervalMs?: number;
  readonly onError: (error: unknown) => void;
  readonly publish: (projection: AccountDirectoryProjection) => Promise<void>;
  readonly store: Pick<AccountDirectoryStore, "claimPending" | "complete" | "fail">;
}

export class AccountDirectoryPublisher {
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #publish: (projection: AccountDirectoryProjection) => Promise<void>;
  readonly #store: AccountDirectoryPublisherOptions["store"];
  #active: Promise<void> | undefined;
  #started = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: AccountDirectoryPublisherOptions) {
    const intervalMs = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new TypeError("Account directory publication interval must be at least 100ms");
    }
    this.#intervalMs = intervalMs;
    this.#onError = options.onError;
    this.#publish = options.publish;
    this.#store = options.store;
  }

  start(): void {
    if (this.#started) throw new Error("Account directory publisher is already started");
    this.#started = true;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#active;
  }

  async publishOnce(): Promise<number> {
    const projections = await this.#store.claimPending();
    for (const projection of projections) {
      try {
        await this.#publish(projection);
        await this.#store.complete(projection);
      } catch (error) {
        const exponent = Math.min(projection.attempts - 1, 10);
        await this.#store.fail({
          ...projection,
          error: safeMessage(error, safeMessageOptions),
          nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 1_000 * 2 ** exponent)),
        });
        this.#report(error);
      }
    }
    return projections.length;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const active = this.publishOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.#report(error));
      this.#active = active;
      void active.finally(() => {
        if (this.#active === active) this.#active = undefined;
        this.#schedule(this.#intervalMs);
      });
    }, delay);
    this.#timer.unref();
  }

  #report(error: unknown): void {
    try {
      this.#onError(new Error(safeMessage(error, safeMessageOptions)));
    } catch {
      // Reporting cannot stop retries or Host shutdown.
    }
  }
}

const safeMessageOptions = {
  fallback: "Account directory publication failed",
  redactions: [
    { pattern: /Bearer\s+[^\s]+/giu, replacement: "Bearer [redacted]" },
    { pattern: /\b(?:osc|ocs)_[A-Za-z0-9_-]{43}\b/gu, replacement: "[redacted]" },
  ],
} as const;
