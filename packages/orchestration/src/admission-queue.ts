import { OpensteerError } from "@opensteer/core";

interface QueuedTask<T> {
  readonly bytes: number;
  readonly keys: readonly string[];
  readonly run: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface KeyedAdmissionQueueOptions {
  /**
   * Whether a failure is a transaction that lost to a concurrent one, such as a
   * deadlock, and rolled back whole. Such a command is run again.
   */
  readonly isTransactionConflict?: (error: unknown) => boolean;
  readonly maxInFlight: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedCommands: number;
}

/** How many times a command that keeps losing to concurrent transactions is run. */
const maxConflictAttempts = 4;

/**
 * Admits Host commands in order per key and concurrently across keys.
 *
 * A command names the keys it is ordered by, such as the Threads it changes:
 * it starts only after every earlier command sharing one of them has finished,
 * whether that one is running or still waiting, so one person's messages to a
 * Thread apply in the order they were sent. Commands with no key in common run
 * side by side, so a slow one never holds up an unrelated Thread. Correctness
 * still rests on the database's row locks; the keys only keep order and spread
 * load.
 */
export class KeyedAdmissionQueue {
  readonly #isTransactionConflict: (error: unknown) => boolean;
  readonly #maxInFlight: number;
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedCommands: number;
  readonly #pending: QueuedTask<unknown>[] = [];
  readonly #heldKeys = new Map<string, number>();
  #inFlight = 0;
  #queuedBytes = 0;
  #closed = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: KeyedAdmissionQueueOptions) {
    for (const [name, value] of [
      ["maxInFlight", options.maxInFlight],
      ["maxQueuedCommands", options.maxQueuedCommands],
      ["maxQueuedBytes", options.maxQueuedBytes],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.#isTransactionConflict = options.isTransactionConflict ?? (() => false);
    this.#maxInFlight = options.maxInFlight;
    this.#maxQueuedBytes = options.maxQueuedBytes;
    this.#maxQueuedCommands = options.maxQueuedCommands;
  }

  get queuedCommands(): number {
    return this.#pending.length;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  execute<T>(keys: readonly string[], estimatedBytes: number, run: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new OpensteerError({ code: "conflict", message: "Command queue is closed" }),
      );
    }
    if (!Number.isInteger(estimatedBytes) || estimatedBytes < 0) {
      return Promise.reject(new TypeError("estimatedBytes must be a non-negative integer"));
    }
    if (
      this.#pending.length >= this.#maxQueuedCommands ||
      this.#queuedBytes + estimatedBytes > this.#maxQueuedBytes
    ) {
      return Promise.reject(
        new OpensteerError({
          code: "timeout",
          details: { retryAfterMs: 250 },
          message: "Host command admission is temporarily full",
          retryable: true,
        }),
      );
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.push({
        bytes: estimatedBytes,
        keys: [...new Set(keys)],
        reject,
        resolve,
        run,
      } as QueuedTask<unknown>);
      this.#queuedBytes += estimatedBytes;
    });
    this.#pump();
    return promise;
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#waitForIdle();
    this.#closed = true;
    const error = new OpensteerError({
      code: "conflict",
      message: "Host is shutting down",
      retryable: true,
    });
    for (const task of this.#pending.splice(0)) task.reject(error);
    this.#queuedBytes = 0;
    await this.#waitForIdle();
  }

  #pump(): void {
    // Keys of earlier commands that could not start yet: a later command
    // sharing one waits behind them rather than overtaking.
    const waitingKeys = new Set<string>();
    for (let index = 0; index < this.#pending.length;) {
      if (this.#inFlight >= this.#maxInFlight) break;
      const task = this.#pending[index]!;
      const ready = task.keys.every((key) => !this.#heldKeys.has(key) && !waitingKeys.has(key));
      if (!ready) {
        for (const key of task.keys) waitingKeys.add(key);
        index += 1;
        continue;
      }
      this.#pending.splice(index, 1);
      this.#start(task);
    }
    if (this.#inFlight === 0 && this.#pending.length === 0) {
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  #start(task: QueuedTask<unknown>): void {
    this.#inFlight += 1;
    this.#queuedBytes -= task.bytes;
    for (const key of task.keys) this.#heldKeys.set(key, (this.#heldKeys.get(key) ?? 0) + 1);
    void this.#runWithConflictRetries(task)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.#inFlight -= 1;
        for (const key of task.keys) {
          const held = (this.#heldKeys.get(key) ?? 1) - 1;
          if (held > 0) this.#heldKeys.set(key, held);
          else this.#heldKeys.delete(key);
        }
        this.#pump();
      });
  }

  async #runWithConflictRetries(task: QueuedTask<unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await task.run();
      } catch (error) {
        if (attempt >= maxConflictAttempts || !this.#isTransactionConflict(error)) throw error;
        // The transaction rolled back whole and nothing was published, so the
        // command is run again after a short, jittered pause that lets the
        // transaction it lost to finish.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
      }
    }
  }

  #waitForIdle(): Promise<void> {
    if (this.#inFlight === 0 && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }
}
