import { withTimeout } from "./withTimeout.js";

export interface Observation<T> {
  readonly promise: Promise<T>;
  dispose(): void;
}

/** Notifications are wakeups; read supplies the authoritative state. */
export function observe<T>(options: {
  readonly label: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly subscribe: (notify: () => void) => () => void;
  readonly read: (signal: AbortSignal) => T | Promise<T>;
  readonly matches: (value: T) => boolean;
}): Observation<T> {
  const result = Promise.withResolvers<T>();
  const cancellation = new AbortController();
  let active = true;
  let dirty = true;
  let reading = false;
  let unsubscribe: (() => void) | undefined;
  const abort = () =>
    cancellation.abort(options.signal?.reason ?? new Error(`${options.label} aborted`));
  const cleanup = () => {
    active = false;
    try {
      unsubscribe?.();
    } finally {
      unsubscribe = undefined;
      options.signal?.removeEventListener("abort", abort);
      cancellation.abort(new Error(`${options.label} finished`));
    }
  };
  const pump = async () => {
    if (!active || cancellation.signal.aborted || reading) return;
    reading = true;
    try {
      while (dirty && active && !cancellation.signal.aborted) {
        dirty = false;
        const value = await options.read(cancellation.signal);
        if (!active || cancellation.signal.aborted) return;
        if (options.matches(value) && !dirty) {
          active = false;
          result.resolve(value);
        }
      }
    } catch (error) {
      active = false;
      result.reject(error);
    } finally {
      reading = false;
    }
  };
  // Queue reads so even a synchronous notification during registration cannot read early.
  const notify = () => {
    if (!active || cancellation.signal.aborted) return;
    dirty = true;
    void Promise.resolve().then(pump);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (!cancellation.signal.aborted) unsubscribe = options.subscribe(notify);
  } catch (error) {
    active = false;
    result.reject(error);
  }
  const promise = withTimeout(result.promise, options.deadlineMs, {
    signal: cancellation.signal,
    timeoutError: () => new Error(`${options.label} timed out after ${options.deadlineMs} ms`),
  }).finally(cleanup);
  // A fixture may trigger work before awaiting its observation.
  void promise.catch(() => undefined);
  notify();
  return {
    promise,
    dispose: () => {
      if (!active) return;
      active = false;
      cancellation.abort(new Error(`${options.label} disposed`));
    },
  };
}

/** One-shot rendezvous. The caller still owns and joins the producer. */
export function gate(options: {
  readonly label: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}) {
  const arrival = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  const abort = () => {
    cancellation.abort(options.signal?.reason ?? new Error(`${options.label} aborted`));
    released.resolve();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const entered = withTimeout(arrival.promise, options.deadlineMs, {
    signal: cancellation.signal,
    timeoutError: () => new Error(`${options.label} never entered within ${options.deadlineMs} ms`),
  });
  void Promise.allSettled([entered, released.promise]).then(() =>
    options.signal?.removeEventListener("abort", abort),
  );
  void entered.catch(() => released.resolve());
  return {
    entered,
    enter: () => {
      arrival.resolve();
      return released.promise;
    },
    release: () => released.resolve(),
    abort: (reason: Error = new Error(`${options.label} aborted`)) => {
      cancellation.abort(reason);
      released.resolve();
    },
  };
}
