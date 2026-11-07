import type { ThreadId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";

const passIntervalMs = 60 * 60 * 1_000;
const pageSize = 100;

interface QuietTasksDependencies {
  readonly store: Pick<OpensteerStore, "listQuietTasks">;
  readonly commands: Pick<CommandService, "setThreadDone">;
  readonly onError: (error: unknown) => void;
  readonly now?: () => Date;
}

/**
 * Moves each person's quiet tasks to Done for them: once when the Host starts,
 * then every hour. A task that is touched between the scan and its turn stays
 * where it is, because the Done command checks again under its locks.
 */
export class QuietTasks {
  readonly #dependencies: QuietTasksDependencies;
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #pass: Promise<void> | null = null;

  constructor(dependencies: QuietTasksDependencies) {
    this.#dependencies = dependencies;
  }

  start(): void {
    if (this.#timer || this.#shutdown.signal.aborted) return;
    void this.run();
    this.#timer = setInterval(() => void this.run(), passIntervalMs);
    this.#timer.unref();
  }

  /** One pass, or the one already under way. */
  run(): Promise<void> {
    this.#pass ??= this.#movePass()
      .catch(this.#dependencies.onError)
      .finally(() => (this.#pass = null));
    return this.#pass;
  }

  async stop(): Promise<void> {
    this.#shutdown.abort();
    clearInterval(this.#timer);
    await this.#pass;
  }

  async #movePass(): Promise<void> {
    const { store, commands, onError } = this.#dependencies;
    const now = this.#dependencies.now?.() ?? new Date();
    let after: ThreadId | undefined;
    while (!this.#shutdown.signal.aborted) {
      const page = await store.listQuietTasks({
        now,
        limit: pageSize,
        ...(after ? { after } : {}),
      });
      for (const task of page) {
        if (this.#shutdown.signal.aborted) return;
        await commands
          .setThreadDone({
            threadId: task.threadId,
            requestedBy: task.createdBy,
            done: true,
            quiet: true,
            idempotencyKey: `quiet-done:${task.threadId}:${task.updatedAt.toISOString()}`,
          })
          .catch(onError);
      }
      if (page.length < pageSize) return;
      after = page.at(-1)!.threadId;
    }
  }
}
