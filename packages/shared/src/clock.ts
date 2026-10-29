/** Time and cancellable scheduling for domain deadlines, independent of transport timers. */
export interface Clock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, milliseconds: number) => () => void;
}

export const systemClock: Clock = {
  now: Date.now,
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
