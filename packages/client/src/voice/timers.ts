export type VoiceTimer = ReturnType<typeof globalThis.setTimeout> | number;

export interface VoiceTimers {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => VoiceTimer;
  readonly clearTimer?: (timer: VoiceTimer) => void;
}

export function voiceTimers(input: VoiceTimers) {
  return {
    now: input.now ?? Date.now,
    set:
      input.setTimer ??
      ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs)),
    clear: (timer: VoiceTimer | null) => {
      if (timer !== null) (input.clearTimer ?? globalThis.clearTimeout)(timer);
    },
  };
}
