interface Step {
  readonly due: number;
  readonly order: number;
  readonly track: string;
  readonly run: () => void;
  timer: number;
}

export interface Clock {
  /** Runs `run` after `ms` of unpaused time. */
  at(ms: number, run: () => void, track: string): void;
  clear(track: string): void;
  pause(): void;
  resume(): void;
  /** Runs every pending step of a track now, in order, including steps those steps add. */
  flush(track: string): void;
  readonly paused: boolean;
}

const inOrder = (a: Step, b: Step): number => a.due - b.due || a.order - b.order;

/** A clock that stops while paused, so a pause freezes a script and a resume picks up the remainders. */
export function createClock(): Clock {
  let steps: Step[] = [];
  let order = 0;
  let paused = true;
  let elapsed = 0;
  let resumedAt = 0;
  let flushing: number | null = null;
  const now = (): number =>
    flushing ?? (paused ? elapsed : elapsed + performance.now() - resumedAt);
  const arm = (step: Step): void => {
    step.timer = window.setTimeout(
      () => {
        steps = steps.filter((other) => other !== step);
        step.run();
      },
      Math.max(0, step.due - now()),
    );
  };
  return {
    at(ms, run, track) {
      const step: Step = { due: now() + ms, order: order++, track, run, timer: 0 };
      steps.push(step);
      if (!paused) arm(step);
    },
    clear(track) {
      steps = steps.filter((step) => {
        if (step.track !== track) return true;
        clearTimeout(step.timer);
        return false;
      });
    },
    pause() {
      if (paused) return;
      elapsed = now();
      paused = true;
      steps.forEach((step) => clearTimeout(step.timer));
    },
    resume() {
      if (!paused) return;
      paused = false;
      resumedAt = performance.now();
      [...steps].sort(inOrder).forEach(arm);
    },
    flush(track) {
      for (;;) {
        const next = steps.filter((step) => step.track === track).sort(inOrder)[0];
        if (!next) break;
        steps = steps.filter((step) => step !== next);
        flushing = next.due;
        next.run();
      }
      flushing = null;
    },
    get paused() {
      return paused;
    },
  };
}
