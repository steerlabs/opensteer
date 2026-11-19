import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";
import type { Clock } from "@opensteer/shared/clock";

interface RequestDeadlineOptions {
  readonly next: () => Promise<Date | null>;
  readonly settle: (now: Date) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
  readonly clock?: Clock;
  /**
   * Changes whenever settling committed anything (the personal commit head).
   * Sweeps are capped, so a deadline still due after a pass that made progress
   * is the next page and runs at once; only a pass with no progress backs off.
   */
  readonly progressMark?: () => unknown;
}

export class RequestDeadlines extends DeadlineDrain {
  constructor(options: RequestDeadlineOptions) {
    const now = options.clock?.now ?? options.now ?? Date.now;
    super({
      ...(options.clock ? { clock: options.clock } : {}),
      onError: options.onError,
      drain: async () => {
        const next = await options.next();
        const time = new Date(now());
        if (!next || next > time) return next;
        const before = options.progressMark?.();
        await options.settle(time);
        const after = await options.next();
        if (!after || after > time) return after;
        const progressed = options.progressMark !== undefined && options.progressMark() !== before;
        return progressed ? after : retryWithBackoff;
      },
    });
  }

  async settle(): Promise<void> {
    this.wake();
    await this.settled();
  }
}
