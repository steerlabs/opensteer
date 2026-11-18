import { DeadlineDrain } from "../runtime/deadline-drain.js";

interface RequestDeadlineOptions {
  readonly next: () => Promise<Date | null>;
  readonly settle: (now: Date) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
}

export class RequestDeadlines extends DeadlineDrain {
  constructor(options: RequestDeadlineOptions) {
    const now = options.now ?? Date.now;
    super({
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
