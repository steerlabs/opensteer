/**
 * A promise a driver settles from somewhere other than where it created it —
 * a turn that completes on a provider notification, a sign-in that completes
 * on a browser callback. Settling twice is ignored rather than refused: the
 * second caller is a race the first already answered.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  readonly #resolvePromise: (value: T | PromiseLike<T>) => void;
  #settled = false;

  constructor() {
    let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
    this.promise = new Promise<T>((resolve) => {
      resolvePromise = resolve;
    });
    if (!resolvePromise) throw new Error("Deferred failed to initialize");
    this.#resolvePromise = resolvePromise;
  }

  resolve(...args: [T] extends [void] ? [] : [T]): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolvePromise(args[0] as T);
  }
}
