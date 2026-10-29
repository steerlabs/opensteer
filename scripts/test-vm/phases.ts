/** job.json's phases: each step, and each wait before the suite, with its seconds. */
export type Phases = Record<string, { seconds: number; exitCode?: number | null }>;

/** Runs `wait` and records how long it took as phase `name`, even when it throws. */
export async function timedWait<T>(
  phases: Phases,
  name: string,
  wait: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await wait();
  } finally {
    phases[name] = { seconds: (performance.now() - started) / 1000 };
  }
}

/**
 * Prepares a job's payload, then takes its VM slot. Waiting for the payload
 * lock or storage holds no slot, so a job whose payload is ready boots
 * meanwhile.
 */
export async function payloadThenSlot<Payload, Slot>(options: {
  readonly phases: Phases;
  readonly preparePayload: () => Promise<Payload>;
  readonly takeSlot: () => Promise<Slot>;
}): Promise<{ payload: Payload; slot: Slot }> {
  const payload = await options.preparePayload();
  const slot = await timedWait(options.phases, "slot-wait", options.takeSlot);
  return { payload, slot };
}
