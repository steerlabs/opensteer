import { HostTransportError } from "./host-transport-error.js";

/** A phase deadline; body readers renew it only when nonempty bytes arrive. */
export class HostResponseDeadline {
  readonly controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #caller: AbortSignal | undefined;
  readonly #abort = () => this.controller.abort(this.#caller?.reason);

  constructor(caller?: AbortSignal) {
    this.#caller = caller;
    caller?.addEventListener("abort", this.#abort, { once: true });
    if (caller?.aborted) this.#abort();
  }

  reset(milliseconds: number): void {
    clearTimeout(this.#timer);
    if (this.controller.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.controller.abort(new HostTransportError("timed-out"));
    }, milliseconds);
  }

  async wait<Value>(pending: Promise<Value>): Promise<Value> {
    const signal = this.controller.signal;
    if (signal.aborted) {
      void pending.catch(() => undefined);
      signal.throwIfAborted();
    }
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#abort);
    // Release native sockets even when the body reader failed or was abandoned.
    this.controller.abort();
  }
}

// Headers may legitimately wait while the Host waits on a Runner, up to 30
// seconds for workspace files and harness nudges, so this sits above that.
export const hostResponseHeadersTimeoutMs = 45_000;
// Once a body flows, silence this long means a dead path, not a slow link.
export const hostResponseStallTimeoutMs = 20_000;
// Buffered adapters cannot expose progress. Allow transfers down to 1 KiB/s,
// using the accepted decoded size rather than an untrusted Content-Length.
export function bufferedHostResponseTimeoutMs(maximumBytes: number): number {
  return hostResponseHeadersTimeoutMs + Math.ceil(maximumBytes / 1_024) * 1_000;
}
