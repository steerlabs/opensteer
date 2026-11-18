import { DeadlineDrain } from "../runtime/deadline-drain.js";
import type { Clock } from "@opensteer/shared/clock";

interface RequestDeadlineOptions {
  readonly next: () => Promise<Date | null>;
  readonly settle: (now: Date) => Promise<void>;
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
        await options.settle(time);
        return options.next();
      },
    });
  }

  async settle(): Promise<void> {
    this.wake();
    await this.settled();
  }
}
