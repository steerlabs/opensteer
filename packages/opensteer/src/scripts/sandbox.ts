import vm from "node:vm";

import type {
  OpensteerScriptSandboxInput,
  OpensteerScriptSandboxOutput,
  SandboxCapturedAjaxCall,
} from "@opensteer/protocol";

import { toCanonicalJsonValue } from "../json.js";
import { createFullSandboxGlobals } from "./sandbox-shims/full.js";
import { createMinimalSandboxGlobals, type SandboxClockApi } from "./sandbox-shims/minimal.js";
import {
  createStandardSandboxGlobals,
  type SandboxAjaxDispatcher,
  type SandboxAjaxRequest,
  type SandboxAjaxResponse,
} from "./sandbox-shims/standard.js";

export async function runScriptSandbox(
  input: OpensteerScriptSandboxInput & {
    readonly content: string;
  },
): Promise<OpensteerScriptSandboxOutput> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const capturedAjax: SandboxCapturedAjaxCall[] = [];
  const clock = new SandboxClock(input.clockMode ?? "real", (error) => {
    errors.push(normalizeErrorMessage(error));
  });
  const ajax = createSandboxAjaxDispatcher({
    routes: input.ajaxRoutes ?? [],
    capturedAjax,
    clock,
  });

  const baseGlobals = {
    ...(input.globals ?? {}),
  };
  const shimOptions = {
    clock,
    console,
    globals: baseGlobals,
    ajax,
    errors,
    ...(input.cookies === undefined ? {} : { cookies: input.cookies }),
    ...(typeof input.globals?.location === "string" ? { pageUrl: input.globals.location } : {}),
  };
  const globals =
    (input.fidelity ?? "standard") === "minimal"
      ? createMinimalSandboxGlobals(shimOptions)
      : (input.fidelity ?? "standard") === "full"
        ? createFullSandboxGlobals(shimOptions)
        : createStandardSandboxGlobals(shimOptions);

  const context = vm.createContext({
    ...globals,
  });
  Object.assign(context, {
    globalThis: context,
    self: context,
    window: context,
  });

  try {
    const script = new vm.Script(input.content, {
      filename: input.artifactId ?? "sandboxed-script.js",
    });
    const raw = script.runInContext(context, {
      timeout: input.timeoutMs,
    });
    const result = await withAsyncTimeout(Promise.resolve(raw), input.timeoutMs);
    await Promise.resolve();
    return {
      ...(result === undefined ? {} : { result: toCanonicalJsonValue(result) }),
      capturedAjax,
      errors,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    errors.push(normalizeErrorMessage(error));
    return {
      capturedAjax,
      errors,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clock.dispose();
  }
}

class SandboxClock implements SandboxClockApi {
  private readonly startedAt = Date.now();
  private readonly performanceStartedAt =
    typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : 0;
  private manualNow = this.startedAt;
  private nextTimerId = 1;
  private readonly timers = new Map<number, SandboxClockTimerRecord>();

  constructor(
    private readonly mode: "real" | "manual",
    private readonly onError: (error: unknown) => void,
  ) {}

  now(): number {
    return this.mode === "manual" ? this.manualNow : Date.now();
  }

  performanceNow(): number {
    return this.mode === "manual"
      ? this.manualNow - this.startedAt
      : (globalThis.performance?.now() ?? 0) - this.performanceStartedAt;
  }

  setTimeout(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): number {
    return this.registerTimer(false, callback, delay, args);
  }

  setInterval(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): number {
    return this.registerTimer(true, callback, delay, args);
  }

  clearTimeout(timerId: number): void {
    this.clearTimer(timerId);
  }

  clearInterval(timerId: number): void {
    this.clearTimer(timerId);
  }

  advanceClock(ms: number): number {
    if (this.mode !== "manual") {
      return this.now();
    }
    this.manualNow += Math.max(0, ms);
    this.flushManualTimers();
    return this.manualNow;
  }

  dispose(): void {
    for (const timerId of [...this.timers.keys()]) {
      this.clearTimer(timerId);
    }
  }

  private registerTimer(
    repeat: boolean,
    callback: (...args: unknown[]) => void,
    delay: number,
    args: readonly unknown[],
  ): number {
    const timerId = this.nextTimerId++;
    const normalizedDelay = Math.max(0, delay);
    const record: SandboxClockTimerRecord = {
      callback,
      args,
      delay: normalizedDelay,
      dueAt: this.now() + normalizedDelay,
      repeat,
    };
    if (this.mode === "real") {
      record.nativeTimer = (repeat ? setInterval : setTimeout)(() => {
        this.fireTimer(timerId);
      }, normalizedDelay);
    }
    this.timers.set(timerId, record);
    return timerId;
  }

  private clearTimer(timerId: number): void {
    const record = this.timers.get(timerId);
    if (record?.nativeTimer !== undefined) {
      if (record.repeat) {
        clearInterval(record.nativeTimer);
      } else {
        clearTimeout(record.nativeTimer);
      }
    }
    this.timers.delete(timerId);
  }

  private fireTimer(timerId: number): void {
    const record = this.timers.get(timerId);
    if (record === undefined) {
      return;
    }
    if (!record.repeat) {
      this.clearTimer(timerId);
    } else if (this.mode === "manual") {
      record.dueAt += record.delay;
    }
    try {
      record.callback(...record.args);
    } catch (error) {
      this.onError(error);
    }
  }

  private flushManualTimers(): void {
    let fired = true;
    while (fired) {
      fired = false;
      const dueTimers = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.manualNow)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [timerId] of dueTimers) {
        fired = true;
        this.fireTimer(timerId);
      }
    }
  }
}

function createSandboxAjaxDispatcher(input: {
  readonly routes: NonNullable<OpensteerScriptSandboxInput["ajaxRoutes"]>;
  readonly capturedAjax: SandboxCapturedAjaxCall[];
  readonly clock: SandboxClockApi;
}): SandboxAjaxDispatcher {
  return {
    async dispatch(request: SandboxAjaxRequest): Promise<SandboxAjaxResponse> {
      const route = input.routes.find((entry) => routeMatches(entry.urlPattern, request.url));
      const mode = route?.mode ?? "passthrough";
      const timestamp = input.clock.now();
      if (mode === "capture" || mode === "passthrough") {
        input.capturedAjax.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          timestamp,
        });
      }
      if (mode === "mock" || mode === "capture") {
        return {
          status: route?.mockResponse?.status ?? 200,
          ...(route?.mockResponse?.headers === undefined
            ? {}
            : { headers: route.mockResponse.headers }),
          ...(route?.mockResponse?.body === undefined ? {} : { body: route.mockResponse.body }),
        };
      }

      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    },
  };
}

function routeMatches(pattern: string, url: string): boolean {
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const lastSlash = pattern.lastIndexOf("/");
    const source = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    return new RegExp(source, flags).test(url);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(url);
  }
  return url.includes(pattern);
}

async function withAsyncTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        clearTimeout(timeout);
        reject(new Error(`script sandbox timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    }),
  ]);
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SandboxClockTimerRecord {
  callback: (...args: unknown[]) => void;
  args: readonly unknown[];
  delay: number;
  dueAt: number;
  repeat: boolean;
  nativeTimer?: NodeJS.Timeout;
}
