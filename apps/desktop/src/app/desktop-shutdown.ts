import { withTimeout } from "@opensteer/shared/withTimeout";
import type { App, PowerMonitor } from "electron";

export const desktopShutdownTimeoutMs = 30_000;
export type ShutdownLog = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface DesktopShutdownStep {
  readonly component: string;
  readonly step: string;
  readonly order: number;
  readonly timeoutMs: number;
  stop(signal: AbortSignal): Promise<void> | void;
}

/** One irreversible quit transition, installed before startup can launch children. */
export class DesktopShutdown {
  readonly #application: Pick<App, "on" | "exit">;
  readonly #log: ShutdownLog;
  readonly #steps: DesktopShutdownStep[] = [];
  readonly #startup = new AbortController();
  #stopping = false;

  constructor(options: {
    readonly application: Pick<App, "on" | "exit">;
    readonly power: Pick<PowerMonitor, "on">;
    readonly log: ShutdownLog;
  }) {
    this.#application = options.application;
    this.#log = options.log;
    options.application.on("before-quit", (event) => {
      event.preventDefault();
      this.request("before-quit");
    });
    options.power.on("shutdown", (event?: { preventDefault(): void }) => {
      event?.preventDefault();
      this.request("system-shutdown");
    });
    process.on("SIGTERM", () => this.request("SIGTERM"));
    process.on("SIGINT", () => this.request("SIGINT"));
  }

  get requested(): boolean {
    return this.#stopping;
  }

  /** Startup and background admission stop synchronously with the first request. */
  get signal(): AbortSignal {
    return this.#startup.signal;
  }

  add(step: DesktopShutdownStep): void {
    this.signal.throwIfAborted();
    this.#steps.push(step);
  }

  request(reason: string): void {
    if (this.#stopping) {
      this.#log("desktop.shutdown.request-repeated", { reason });
      return;
    }
    this.#stopping = true;
    const started = performance.now();
    const deadline = started + desktopShutdownTimeoutMs;
    this.#log("desktop.shutdown.started", { reason, timeoutMs: desktopShutdownTimeoutMs });
    // app.exit bypasses window beforeunload handlers, including hidden pages.
    // The watchdog also covers a cleanup implementation that fails to settle.
    const watchdog = setTimeout(() => {
      this.#log("desktop.shutdown.deadline", { elapsedMs: performance.now() - started });
      this.#application.exit(1);
    }, desktopShutdownTimeoutMs);
    this.#startup.abort(new Error("The desktop is quitting."));
    void (async () => {
      let failed = false;
      for (const step of this.#steps.toSorted((a, b) => a.order - b.order)) {
        // Reserve time to dispatch every owner's cancellation and finish exit.
        const timeoutMs = Math.max(1, Math.min(step.timeoutMs, deadline - performance.now() - 500));
        try {
          await runShutdownStep(this.#log, step.component, step.step, timeoutMs, step.stop);
        } catch {
          failed = true;
        }
      }
      clearTimeout(watchdog);
      this.#log("desktop.shutdown.finished", { failed, elapsedMs: performance.now() - started });
      this.#application.exit(failed ? 1 : 0);
    })();
  }
}

export async function runShutdownStep<T>(
  log: ShutdownLog,
  component: string,
  step: string,
  timeoutMs: number,
  stop: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const started = performance.now();
  const controller = new AbortController();
  log("desktop.shutdown.step.started", { component, step, timeoutMs });
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => stop(controller.signal)),
      timeoutMs,
      {
        timeoutError: () => {
          const error = new Error(`${component}: ${step} exceeded ${Math.round(timeoutMs)}ms.`);
          controller.abort(error);
          return error;
        },
      },
    );
    log("desktop.shutdown.step.finished", {
      component,
      step,
      elapsedMs: performance.now() - started,
    });
    return result;
  } catch (error) {
    logShutdownError(log, component, step, error, performance.now() - started);
    throw error;
  }
}

/** Emit each cause separately so AggregateError never hides the failing owner. */
export function logShutdownError(
  log: ShutdownLog,
  component: string,
  step: string,
  error: unknown,
  elapsedMs = 0,
): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown, chain: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    const message = (value instanceof Error ? (value.stack ?? value.message) : String(value))
      .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
      .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[redacted]@")
      .replace(/(password|secret)=([^\s&]+)/giu, "$1=[redacted]")
      .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]")
      .replace(/((?:tunnel[_ -]?token|token)\s*[:=]\s*)[^\s,}]+/giu, "$1[redacted]");
    log("desktop.shutdown.step.failed", { component, step, chain, elapsedMs, message });
    if (value instanceof AggregateError) {
      value.errors.forEach((cause: unknown, index: number) =>
        visit(cause, `${chain}.errors[${index}]`),
      );
    }
    if (value instanceof Error && value.cause !== undefined) visit(value.cause, `${chain}.cause`);
  };
  visit(error, "error");
}
