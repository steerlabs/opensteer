/**
 * Keeps the device-local Deployment catalog a live projection of the Account
 * directory without polling the control plane on a hot loop.
 *
 * The catalog only learns about a Deployment created elsewhere (the web portal,
 * another device) when a directory sync runs, so the main process asks for one
 * when the app becomes interesting again: a window gains focus, or the machine
 * wakes. Those signals are noisy, so every trigger passes through one cooldown
 * and one in-flight sync. A trigger inside the cooldown is dropped rather than
 * queued: the next trigger after the cooldown performs the sync, so a user
 * clicking between windows never accumulates a backlog of directory fetches.
 *
 * Nothing here touches Electron. The main process injects the clock, the
 * eligibility predicate, and the refresh itself, and the desktop bridge attaches
 * the operation that reconciles the catalog and republishes the selection.
 */

/** One directory sync per window, regardless of how many triggers arrive. */
export const accountDirectoryRefreshCooldownMilliseconds = 5 * 60 * 1_000;

export type AccountDirectoryRefreshTrigger =
  /** An Account credential changed, or the renderer read the auth state. */
  | "account-state"
  /** A desktop window gained focus. */
  | "app-focus"
  /** The existing bridge heartbeat performed its staleness check. */
  | "heartbeat"
  /** The renderer explicitly asked for a directory sync. */
  | "renderer"
  /** The machine resumed from sleep. */
  | "system-resume";

export type AccountDirectoryRefreshOutcome =
  /** Another sync was already running; this trigger waited for it. */
  | "coalesced"
  /** The sync ran and failed. Directory freshness is best effort. */
  | "failed"
  /** No Account credential, so there is no directory to project. */
  | "not-eligible"
  /** The sync ran to completion. */
  | "refreshed"
  /** A sync ran recently, so this trigger was dropped without queueing. */
  | "throttled"
  /** Nothing has attached a refresh operation yet. */
  | "unavailable";

export interface AccountDirectoryRefreshEvent {
  readonly error?: unknown;
  readonly outcome: AccountDirectoryRefreshOutcome;
  readonly trigger: AccountDirectoryRefreshTrigger;
}

interface AccountDirectoryRefreshServiceOptions {
  readonly cooldownMilliseconds?: number;
  /**
   * Whether a background sync is worth attempting at all. This mirrors the
   * predicate the bridge already uses before it refreshes the directory: an
   * Account credential must be present, which a build without an Account origin
   * can never satisfy.
   */
  readonly eligible: () => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly observe?: (event: AccountDirectoryRefreshEvent) => void;
}

export class AccountDirectoryRefreshService<T = unknown> {
  readonly #cooldownMilliseconds: number;
  readonly #eligible: () => boolean | Promise<boolean>;
  readonly #now: () => number;
  readonly #observe: (event: AccountDirectoryRefreshEvent) => void;
  #inFlight: Promise<T> | null = null;
  #lastAttemptFinishedAt: number | null = null;
  #refresh: (() => Promise<T>) | null = null;

  constructor(options: AccountDirectoryRefreshServiceOptions) {
    const cooldownMilliseconds =
      options.cooldownMilliseconds ?? accountDirectoryRefreshCooldownMilliseconds;
    if (!Number.isFinite(cooldownMilliseconds) || cooldownMilliseconds < 0) {
      throw new TypeError("The Account directory refresh cooldown must be a non-negative number.");
    }
    this.#cooldownMilliseconds = cooldownMilliseconds;
    this.#eligible = options.eligible;
    this.#now = options.now ?? (() => Date.now());
    this.#observe = options.observe ?? (() => undefined);
  }

  get cooldownMilliseconds(): number {
    return this.#cooldownMilliseconds;
  }

  /**
   * Publish the operation that performs one directory sync. The bridge owns it
   * because a sync also republishes the Deployment selection to the renderer.
   */
  attach(refresh: () => Promise<T>): () => void {
    if (this.#refresh !== null) {
      throw new Error("The Account directory refresh source is already attached.");
    }
    this.#refresh = refresh;
    return () => {
      if (this.#refresh === refresh) this.#refresh = null;
    };
  }

  /**
   * Run a sync the user asked for. It ignores the cooldown, coalesces with any
   * sync already running, and restarts the cooldown so a background trigger
   * arriving moments later does not repeat the work.
   */
  refreshNow(trigger: AccountDirectoryRefreshTrigger = "renderer"): Promise<T> {
    const refresh = this.#refresh;
    if (refresh === null) {
      return Promise.reject(new Error("The Account directory refresh source is unavailable."));
    }
    const operation = this.#run(refresh);
    void operation.then(
      () => this.#report(trigger, "refreshed"),
      (error: unknown) => this.#report(trigger, "failed", error),
    );
    return operation;
  }

  /**
   * Ask for a background sync. Never rejects: a directory that cannot be
   * reached is reported to the observer and retried on a later trigger.
   */
  async request(trigger: AccountDirectoryRefreshTrigger): Promise<AccountDirectoryRefreshOutcome> {
    const refresh = this.#refresh;
    if (refresh === null) return this.#report(trigger, "unavailable");
    const running = this.#inFlight;
    if (running !== null) {
      await running.catch(() => undefined);
      return this.#report(trigger, "coalesced");
    }
    const lastAttemptFinishedAt = this.#lastAttemptFinishedAt;
    if (
      lastAttemptFinishedAt !== null &&
      this.#now() - lastAttemptFinishedAt < this.#cooldownMilliseconds
    ) {
      return this.#report(trigger, "throttled");
    }
    let eligible: boolean;
    try {
      eligible = await this.#eligible();
    } catch {
      eligible = false;
    }
    if (!eligible) return this.#report(trigger, "not-eligible");
    // The predicate is asynchronous, so another trigger may have started a sync
    // while it resolved. Join that one instead of opening a second.
    const started = this.#inFlight;
    if (started !== null) {
      await started.catch(() => undefined);
      return this.#report(trigger, "coalesced");
    }
    try {
      await this.#run(refresh);
      return this.#report(trigger, "refreshed");
    } catch (error) {
      return this.#report(trigger, "failed", error);
    }
  }

  #run(refresh: () => Promise<T>): Promise<T> {
    const running = this.#inFlight;
    if (running !== null) return running;
    // A failed attempt restarts the cooldown too, so an unreachable control
    // plane cannot turn window focus into a retry loop.
    const operation = (async () => refresh())().finally(() => {
      this.#inFlight = null;
      this.#lastAttemptFinishedAt = this.#now();
    });
    this.#inFlight = operation;
    return operation;
  }

  #report(
    trigger: AccountDirectoryRefreshTrigger,
    outcome: AccountDirectoryRefreshOutcome,
    error?: unknown,
  ): AccountDirectoryRefreshOutcome {
    try {
      this.#observe(error === undefined ? { outcome, trigger } : { error, outcome, trigger });
    } catch {
      // Observation is diagnostic only and never changes refresh behavior.
    }
    return outcome;
  }
}
