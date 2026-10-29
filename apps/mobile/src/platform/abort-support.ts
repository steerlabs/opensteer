/** Complete React Native's legacy AbortSignal before shared clients create leases. */
export function installAbortSupport(
  controller: typeof AbortController,
  signal: typeof AbortSignal,
): void {
  if (!("reason" in signal.prototype)) {
    const reasons = new WeakMap<AbortSignal, unknown>();
    const abort = controller.prototype.abort;
    Object.defineProperty(signal.prototype, "reason", {
      configurable: true,
      get(this: AbortSignal): unknown {
        return reasons.get(this);
      },
    });
    Object.defineProperty(controller.prototype, "abort", {
      configurable: true,
      writable: true,
      value(this: AbortController, reason?: unknown): void {
        if (this.signal.aborted) return;
        // Listeners run synchronously, so the reason must exist before dispatch.
        reasons.set(
          this.signal,
          reason === undefined
            ? new DOMException("The operation was aborted.", "AbortError")
            : reason,
        );
        abort.call(this);
      },
    });
  }
  if (typeof signal.prototype.throwIfAborted !== "function") {
    Object.defineProperty(signal.prototype, "throwIfAborted", {
      configurable: true,
      writable: true,
      value(this: AbortSignal): void {
        if (this.aborted) throw this.reason;
      },
    });
  }
}
