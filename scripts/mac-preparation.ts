type Preparation = (signal: AbortSignal) => Promise<void>;
interface Job {
  work: Preparation;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** One two-worker compiler pool, shared with the image lane's phone promise.
 * A failure is observable only after every active branch has joined cleanup. */
export class MacPreparationPool {
  readonly signal: AbortSignal;
  #stop = new AbortController();
  #queue: Job[] = [];
  #pending = new Set<Job>();
  #active = 0;
  #failure: unknown;

  constructor(parent?: AbortSignal) {
    this.signal = parent ? AbortSignal.any([parent, this.#stop.signal]) : this.#stop.signal;
  }

  run(work: Preparation): Promise<void> {
    const job = { ...Promise.withResolvers<void>(), work };
    this.#pending.add(job);
    this.#queue.push(job);
    this.#drain();
    return job.promise;
  }

  cancel(error: unknown): void {
    if (!this.#stop.signal.aborted) {
      this.#failure = error;
      this.#stop.abort(error);
    }
    this.#drain();
  }

  async join(): Promise<void> {
    await Promise.allSettled([...this.#pending].map((job) => job.promise));
    if (this.#stop.signal.aborted) throw this.#failure;
    this.signal.throwIfAborted();
  }

  #drain(): void {
    if (this.signal.aborted) {
      if (this.#active === 0) {
        const error = this.#stop.signal.aborted ? this.#failure : this.signal.reason;
        for (const job of this.#pending) job.reject(error);
        this.#pending.clear();
        this.#queue = [];
      }
      return;
    }
    while (this.#active < 2 && this.#queue.length) {
      const job = this.#queue.shift();
      if (job) void this.#start(job);
    }
  }

  async #start(job: Job): Promise<void> {
    this.#active++;
    try {
      this.signal.throwIfAborted();
      await job.work(this.signal);
      this.signal.throwIfAborted();
      job.resolve();
      this.#pending.delete(job);
    } catch (error) {
      this.cancel(error);
    } finally {
      this.#active--;
      this.#drain();
    }
  }
}

export async function runMacPreparations(
  branches: readonly Preparation[],
  parent?: AbortSignal,
  pool = new MacPreparationPool(parent),
): Promise<void> {
  const abort = () => pool.cancel(parent?.reason);
  if (parent?.aborted) abort();
  else if (parent !== pool.signal) parent?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.allSettled(branches.map((branch) => pool.run(branch)));
    await pool.join();
  } finally {
    parent?.removeEventListener("abort", abort);
  }
}
