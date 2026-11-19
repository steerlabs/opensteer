import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";
import type { Clock } from "@opensteer/shared/clock";

interface RequestDeadlineOptions {
  readonly next: () => Promise<Date | null>;
  /** Settles what is due and answers how many items it settled (its own progress). */
  readonly settle: (now: Date) => Promise<number>;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
  readonly clock?: Clock;
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
        // Sweeps are capped: a deadline still due after a pass that settled
        // something is the next page and runs at once; a pass that settled
        // nothing backs off.
        const settled = await options.settle(time);
        const after = await options.next();
        if (!after || after > time) return after;
        return settled > 0 ? after : retryWithBackoff;
      },
    });
  }

  async settle(): Promise<void> {
    this.wake();
    await this.settled();
  }
}
