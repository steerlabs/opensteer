import { idleCompactionWindow, type ThreadId } from "@opensteer/core";
import type { idleCompactionCandidates } from "@opensteer/database/idle-compaction";

type Candidate = Awaited<ReturnType<typeof idleCompactionCandidates>>[number];

interface IdleCompactionServiceOptions {
  readonly list: (threadId?: ThreadId) => Promise<readonly Candidate[]>;
  readonly admit: (candidate: Candidate) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export class IdleCompactionService {
  readonly #options: IdleCompactionServiceOptions;
  readonly #timers = new Map<ThreadId, NodeJS.Timeout>();
  readonly #pending = new Set<Promise<void>>();
  readonly #revisions = new Map<ThreadId, number>();
  #closed = false;
  #started = false;
  constructor(options: IdleCompactionServiceOptions) {
    this.#options = options;
  }
  start(): Promise<void> {
    if (this.#closed || this.#started) return Promise.resolve();
    this.#started = true;
    return this.#track(async () => {
      for (const candidate of await this.#options.list())
        if (!this.#revisions.has(candidate.threadId)) this.#schedule(candidate);
    });
  }
  arm(threadId: ThreadId): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const revision = (this.#revisions.get(threadId) ?? 0) + 1;
    this.#revisions.set(threadId, revision);
    const timer = this.#timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(threadId);
    return this.#track(async () => {
      const candidates = await this.#options.list(threadId);
      if (this.#revisions.get(threadId) !== revision) return;
      for (const candidate of candidates) this.#schedule(candidate);
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all(this.#pending);
    this.#revisions.clear();
  }
  #schedule(candidate: Candidate): void {
    if (this.#closed || !candidate.contextSnapshot) return;
    const window = idleCompactionWindow(candidate.contextSnapshot, Date.now());
    if (!window) return;
    const prior = this.#timers.get(candidate.threadId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(
      () => {
        this.#timers.delete(candidate.threadId);
        void this.#track(async () => {
          const current = (await this.#options.list(candidate.threadId))[0];
          if (this.#closed || !current?.contextSnapshot) return;
          const window = idleCompactionWindow(current.contextSnapshot, Date.now());
          if (!window || Date.now() < window.startMs) return;
          await this.#options.admit(current);
        });
      },
      Math.max(0, window.startMs - Date.now()),
    );
    timer.unref();
    this.#timers.set(candidate.threadId, timer);
  }
  #track(work: () => Promise<void>): Promise<void> {
    const pending = work()
      .catch(this.#options.onError)
      .finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return pending;
  }
}
