import { classifyClientFailure } from "../connections/operation-error.js";

/**
 * What one run of a read can ask while it is in flight. `current()` is the
 * install gate: a result is written into a store only while it is true.
 */
export interface FencedRead {
  readonly signal: AbortSignal;
  /** The epoch it started in, this key's change count, and its observation all still hold. */
  current(): boolean;
}

/**
 * A read job for one key. It may span several pages, checking `current()` before each
 * install and stopping when it reaches its depth or the end.
 */
export type FencedJob = (read: FencedRead) => Promise<void>;

export interface FencedReadsOptions {
  /**
   * The scope's epoch: its generation and repair count, or a viewer's generation. A read
   * started in an older epoch never installs; one still wanted runs again in the new one.
   */
  readonly epoch: () => string;
  /** The first retry waits this long, doubling to `maxBackoffMs`. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * A key superseded twice running waits until it has been this long without a change before it
   * runs again (the trailing edge of the churn), and never longer than `maxBackoffMs` in all.
   */
  readonly quietMs?: number;
}

/** How a request runs: whether a retryable failure tries again by itself. */
export interface FencedRequestOptions {
  readonly observed?: () => boolean;
  /**
   * True (the default) for reads nobody waits on, which recover by themselves. False for a read a
   * person asked for and is watching: a failure settles its request so the screen can say so.
   */
  readonly retry?: boolean;
}

interface Slot {
  job: FencedJob;
  observed: () => boolean;
  retry: boolean;
  controller: AbortController | null;
  /** Something changed, or a newer request came, while it flew: run again when it lands. */
  dirty: boolean;
  attempt: number;
  /** Runs in a row that landed already superseded by a change. */
  superseded: number;
  /** A newer request came while it flew: a need someone waits on, which runs at once. */
  asked: boolean;
  /** When the key last changed, and when its current wait for quiet began. */
  changedAt: number;
  waitingSince: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: { resolve(): void; reject(error: unknown): void }[];
}

/**
 * Reads that install into a store while the socket keeps changing it. One read per key is in
 * flight; each run carries a token (the epoch, the key's change count) and installs only while
 * that token holds. A change, epoch move or newer request during a run marks it dirty, and it
 * runs again once it lands rather than being dropped or blocking the newer need. A retryable
 * failure tries again with backoff while the key is observed. `stop` and `dispose` end it.
 */
export class FencedReads {
  readonly #options: Required<FencedReadsOptions>;
  readonly #slots = new Map<string, Slot>();
  readonly #changes = new Map<string, number>();
  #disposed = false;

  constructor(options: FencedReadsOptions) {
    this.#options = { minBackoffMs: 1_000, maxBackoffMs: 30_000, quietMs: 250, ...options };
  }

  /**
   * Runs `job` for `key`, or, when one is in flight, takes `job` as the newest need and runs it
   * once the current run lands. The promise settles when the key has no newer need left: it
   * rejects only on a failure that will not be retried.
   */
  request(key: string, job: FencedJob, options: FencedRequestOptions = {}): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const observed = options.observed ?? (() => true);
    const retry = options.retry ?? true;
    const promise = new Promise<void>((resolve, reject) => {
      const slot = this.#slots.get(key);
      if (slot) {
        slot.job = job;
        slot.observed = observed;
        slot.retry = retry;
        slot.waiters.push({ resolve, reject });
        // A newer need supersedes what flies: its result is not installed.
        if (slot.controller) {
          this.#bump(key);
          slot.dirty = true;
          slot.asked = true;
        } else if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
          this.#start(key, slot);
        }
        return;
      }
      const created: Slot = {
        job,
        observed,
        retry,
        controller: null,
        dirty: false,
        attempt: 0,
        superseded: 0,
        asked: false,
        changedAt: 0,
        waitingSince: 0,
        timer: null,
        waiters: [{ resolve, reject }],
      };
      this.#slots.set(key, created);
      this.#start(key, created);
    });
    return promise;
  }

  /** What a run of `key` read may be out of date: it will not install, and runs again. */
  changed(key: string) {
    this.#bump(key);
    const slot = this.#slots.get(key);
    if (slot) slot.changedAt = Date.now();
    if (slot?.controller) slot.dirty = true;
  }

  /** The epoch moved (a repair, a new generation): every run in flight starts over. */
  restart() {
    for (const slot of this.#slots.values()) if (slot.controller) slot.dirty = true;
  }

  /** Whether a run of `key` is in flight or waiting to retry. */
  busy(key: string) {
    return this.#slots.has(key);
  }

  /** Ends `key`: what flies is aborted and installs nothing. */
  stop(key: string) {
    const slot = this.#slots.get(key);
    if (!slot) return;
    this.#slots.delete(key);
    this.#bump(key);
    slot.controller?.abort();
    if (slot.timer) clearTimeout(slot.timer);
    for (const waiter of slot.waiters) waiter.resolve();
  }

  /** Ends every key, as `stop` does; later requests still run. */
  stopAll() {
    for (const key of this.#slots.keys()) this.stop(key);
  }

  dispose() {
    this.#disposed = true;
    this.stopAll();
  }

  #bump(key: string) {
    this.#changes.set(key, (this.#changes.get(key) ?? 0) + 1);
  }

  #start(key: string, slot: Slot) {
    const controller = new AbortController();
    slot.controller = controller;
    slot.dirty = false;
    const epoch = this.#options.epoch();
    const change = this.#changes.get(key) ?? 0;
    const read: FencedRead = {
      signal: controller.signal,
      current: () =>
        !controller.signal.aborted &&
        this.#slots.get(key) === slot &&
        slot.controller === controller &&
        !slot.dirty &&
        this.#options.epoch() === epoch &&
        (this.#changes.get(key) ?? 0) === change &&
        slot.observed(),
    };
    const stale = () =>
      slot.dirty || this.#options.epoch() !== epoch || (this.#changes.get(key) ?? 0) !== change;
    // The job starts at once, so its request is out before the caller's next step.
    let running: Promise<void>;
    try {
      running = slot.job(read);
    } catch (error) {
      running = Promise.reject(error);
    }
    void running.then(
      () => {
        if (this.#slots.get(key) !== slot || slot.controller !== controller) return;
        slot.controller = null;
        slot.attempt = 0;
        if (stale() && slot.observed()) this.#rerun(key, slot);
        else {
          slot.superseded = 0;
          this.#settle(key, slot);
        }
      },
      (error: unknown) => {
        if (this.#slots.get(key) !== slot || slot.controller !== controller) return;
        slot.controller = null;
        if (!slot.observed()) return this.#settle(key, slot);
        if (stale()) return this.#rerun(key, slot);
        // Cut off because the attachment moved (or the read was aborted): it installed nothing,
        // is no failure to show or retry, and the next attach reads again.
        if (classifyClientFailure(error).kind === "cancelled") return this.#settle(key, slot);
        if (!slot.retry || !classifyClientFailure(error).retryable)
          return this.#settle(key, slot, error);
        const delay = Math.min(
          this.#options.maxBackoffMs,
          this.#options.minBackoffMs * 2 ** slot.attempt++,
        );
        slot.timer = setTimeout(() => {
          slot.timer = null;
          if (this.#slots.get(key) !== slot) return;
          if (slot.observed()) this.#start(key, slot);
          else this.#settle(key, slot);
        }, delay);
      },
    );
  }

  /**
   * Runs a superseded key again. Under churn (superseded twice running) it waits for the trailing
   * edge, a quiet moment, so a read is not restarted by every change and still lands; the wait is
   * bounded by `maxBackoffMs`.
   */
  #rerun(key: string, slot: Slot) {
    if (slot.asked) {
      slot.asked = false;
      slot.superseded = 0;
      return this.#start(key, slot);
    }
    slot.superseded++;
    if (slot.superseded < 2) return this.#start(key, slot);
    slot.waitingSince = Date.now();
    const wait = () => {
      const now = Date.now();
      const quietAt = slot.changedAt + this.#options.quietMs;
      const latest = slot.waitingSince + this.#options.maxBackoffMs;
      if (now >= quietAt || now >= latest) {
        slot.timer = null;
        if (this.#slots.get(key) !== slot) return;
        if (slot.observed()) this.#start(key, slot);
        else this.#settle(key, slot);
        return;
      }
      slot.timer = setTimeout(wait, Math.min(quietAt, latest) - now);
    };
    wait();
  }

  #settle(key: string, slot: Slot, error?: unknown) {
    this.#slots.delete(key);
    for (const waiter of slot.waiters)
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
  }
}
