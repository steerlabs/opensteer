/**
 * The signal of the agent's step that a piece of host work runs for (round E, E2). Every host
 * tool started inside it takes it: once the step is given up on, no further tool is started,
 * and one already running is ended.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<AbortSignal>();

export function withStepSignal<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return signal ? storage.run(signal, work) : work();
}

export function currentStepSignal(): AbortSignal | undefined {
  return storage.getStore();
}
