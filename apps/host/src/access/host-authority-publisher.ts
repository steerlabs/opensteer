import { safeMessage } from "@opensteer/shared/safeMessage";

export interface HostAuthorityPublisherOptions {
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly onError: (error: unknown) => void;
  readonly publish: () => Promise<void>;
}

/**
 * The Account's copy of this Host's signed identity document is only as fresh
 * as the last Host that asserted it, and every client refuses a Deployment
 * whose copy it cannot verify. A start that cannot reach the Account must
 * therefore keep trying until it succeeds — but nothing else in the process may
 * wait on it, so the attempt runs on its own unref'd timer and the Host serves
 * traffic while the identity publication is still catching up.
 */
export class HostAuthorityPublisher {
  readonly #baseDelayMs: number;
  readonly #maximumDelayMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #publish: () => Promise<void>;
  #active: Promise<void> | undefined;
  #failures = 0;
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #started = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: HostAuthorityPublisherOptions) {
    const baseDelayMs = options.baseDelayMs ?? 5_000;
    const maximumDelayMs = options.maximumDelayMs ?? 60 * 60_000;
    if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) {
      throw new TypeError("Host authority publication base delay must be at least 1ms");
    }
    if (!Number.isSafeInteger(maximumDelayMs) || maximumDelayMs < baseDelayMs) {
      throw new TypeError("Host authority publication delay cap must not be below its base delay");
    }
    this.#baseDelayMs = baseDelayMs;
    this.#maximumDelayMs = maximumDelayMs;
    this.#onError = options.onError;
    this.#publish = options.publish;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  /**
   * Settles once the Account has accepted this Host's identity. Membership
   * projections are only listable against a published identity, so the
   * directory publisher starts from here rather than racing the first attempt.
   * It never rejects: a Host that cannot reach the Account keeps retrying, and
   * whatever waited simply never starts, which is the correct outcome.
   */
  ready(): Promise<void> {
    return this.#ready;
  }

  start(): void {
    if (this.#started) throw new Error("Host authority publisher is already started");
    this.#started = true;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#active;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const active = this.#attempt();
      this.#active = active;
      void active.finally(() => {
        if (this.#active === active) this.#active = undefined;
      });
    }, delay);
    this.#timer.unref();
  }

  async #attempt(): Promise<void> {
    try {
      await this.#publish();
      this.#failures = 0;
      this.#resolveReady();
    } catch (error) {
      this.#failures += 1;
      this.#report(error);
      this.#schedule(Math.min(this.#maximumDelayMs, this.#baseDelayMs * 2 ** (this.#failures - 1)));
    }
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
  fallback: "Host authority publication failed",
  redactions: [
    { pattern: /Bearer\s+[^\s]+/giu, replacement: "Bearer [redacted]" },
    { pattern: /\b(?:osc|ocs)_[A-Za-z0-9_-]{43}\b/gu, replacement: "[redacted]" },
  ],
} as const;
