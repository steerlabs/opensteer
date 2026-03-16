import type { PageRef } from "@opensteer/browser-core";

import type { PageController } from "./types.js";

export const DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS = 5_000;

const POST_ACTION_SETTLE_QUIET_WINDOW_MS = 400;
const POST_ACTION_SETTLE_POLL_INTERVAL_MS = 100;

interface AbpSettleTrackerState {
  readonly installedAt: number;
  readonly lastMutationAt: number;
  readonly lastNetworkActivityAt: number;
  readonly now: number;
  readonly pendingFetches: number;
  readonly pendingTimeouts: number;
  readonly pendingXhrs: number;
  readonly readyState: string;
}

interface AbpActionSettlerContext {
  syncExecutionPaused(controller: PageController): Promise<boolean>;
  setExecutionPaused(controller: PageController, paused: boolean): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  throwBackgroundError(controller: PageController): void;
  isPageClosedError(error: unknown): boolean;
}

export interface AbpActionSettleOptions {
  readonly controller: PageController;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly policySettle?: (pageRef: PageRef, signal: AbortSignal | undefined) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number {
  const parsed = readFiniteNumber(value);
  return parsed === undefined || parsed < 0 ? 0 : parsed;
}

function normalizeAbpSettleTrackerState(value: unknown): AbpSettleTrackerState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const installedAt = readFiniteNumber(value.installedAt);
  const lastMutationAt = readFiniteNumber(value.lastMutationAt);
  const lastNetworkActivityAt = readFiniteNumber(value.lastNetworkActivityAt);
  const now = readFiniteNumber(value.now);
  const readyState = typeof value.readyState === "string" ? value.readyState : undefined;
  if (
    installedAt === undefined ||
    lastMutationAt === undefined ||
    lastNetworkActivityAt === undefined ||
    now === undefined ||
    readyState === undefined
  ) {
    return undefined;
  }

  return {
    installedAt,
    lastMutationAt,
    lastNetworkActivityAt,
    now,
    pendingFetches: readNonNegativeNumber(value.pendingFetches),
    pendingTimeouts: readNonNegativeNumber(value.pendingTimeouts),
    pendingXhrs: readNonNegativeNumber(value.pendingXhrs),
    readyState,
  };
}

function buildAbpSettleTrackerInstallScript(): string {
  return `(() => {
    const globalObject = globalThis;
    if (globalObject.__opensteerAbpSettleTrackerInstalled) {
      return true;
    }

    const tracker = {
      installedAt: performance.now(),
      lastMutationAt: performance.now(),
      lastNetworkActivityAt: performance.now(),
      pendingFetches: 0,
      pendingTimeouts: 0,
      pendingXhrs: 0,
      readyState: document.readyState,
      timeoutIds: new Set(),
    };
    globalObject.__opensteerAbpSettleTrackerInstalled = true;
    globalObject.__opensteerAbpSettleTracker = tracker;

    const markMutation = () => {
      tracker.lastMutationAt = performance.now();
      tracker.readyState = document.readyState;
    };
    const markNetwork = () => {
      tracker.lastNetworkActivityAt = performance.now();
      tracker.readyState = document.readyState;
    };

    const startObserver = () => {
      const target = document.documentElement ?? document;
      if (!(target instanceof Node)) {
        return;
      }
      const observer = new MutationObserver(markMutation);
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      markMutation();
    };

    if (document.documentElement) {
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    }

    document.addEventListener("readystatechange", markMutation);
    addEventListener("load", markMutation, { once: true });

    const nativeSetTimeout = globalObject.setTimeout.bind(globalObject);
    const nativeClearTimeout = globalObject.clearTimeout.bind(globalObject);
    globalObject.setTimeout = function(callback, delay, ...args) {
      tracker.pendingTimeouts += 1;
      markNetwork();
      let handle;
      const wrapped =
        typeof callback === "function"
          ? (...callbackArgs) => {
              if (tracker.timeoutIds.delete(handle)) {
                tracker.pendingTimeouts = Math.max(0, tracker.pendingTimeouts - 1);
              }
              try {
                return callback(...callbackArgs);
              } finally {
                markMutation();
              }
            }
          : callback;
      handle = nativeSetTimeout(wrapped, delay, ...args);
      tracker.timeoutIds.add(handle);
      return handle;
    };
    globalObject.clearTimeout = function(handle) {
      if (tracker.timeoutIds.delete(handle)) {
        tracker.pendingTimeouts = Math.max(0, tracker.pendingTimeouts - 1);
      }
      return nativeClearTimeout(handle);
    };

    if (typeof globalObject.fetch === "function") {
      const nativeFetch = globalObject.fetch.bind(globalObject);
      globalObject.fetch = (...args) => {
        tracker.pendingFetches += 1;
        markNetwork();
        return nativeFetch(...args)
          .finally(() => {
            tracker.pendingFetches = Math.max(0, tracker.pendingFetches - 1);
            markNetwork();
          });
      };
    }

    if (typeof globalObject.XMLHttpRequest === "function") {
      const NativeXMLHttpRequest = globalObject.XMLHttpRequest;
      const nativeSend = NativeXMLHttpRequest.prototype.send;
      NativeXMLHttpRequest.prototype.send = function(...args) {
        tracker.pendingXhrs += 1;
        markNetwork();
        const finalize = () => {
          this.removeEventListener("loadend", finalize);
          tracker.pendingXhrs = Math.max(0, tracker.pendingXhrs - 1);
          markNetwork();
        };
        this.addEventListener("loadend", finalize, { once: true });
        return nativeSend.apply(this, args);
      };
    }

    return true;
  })()`;
}

function buildAbpSettleTrackerReadExpression(): string {
  return `(() => {
    const tracker = globalThis.__opensteerAbpSettleTracker;
    if (!tracker) {
      return null;
    }

    return {
      installedAt: Number(tracker.installedAt ?? 0),
      lastMutationAt: Number(tracker.lastMutationAt ?? 0),
      lastNetworkActivityAt: Number(tracker.lastNetworkActivityAt ?? 0),
      now: Number(performance.now()),
      pendingFetches: Number(tracker.pendingFetches ?? 0),
      pendingTimeouts: Number(tracker.pendingTimeouts ?? 0),
      pendingXhrs: Number(tracker.pendingXhrs ?? 0),
      readyState: String(document.readyState),
    };
  })()`;
}

function trackerStateIsSettled(tracker: AbpSettleTrackerState | undefined): boolean {
  if (!tracker) {
    return false;
  }

  if (tracker.readyState !== "complete") {
    return false;
  }

  if (tracker.pendingFetches > 0 || tracker.pendingTimeouts > 0 || tracker.pendingXhrs > 0) {
    return false;
  }

  const lastActivityAt = Math.max(
    tracker.installedAt,
    tracker.lastMutationAt,
    tracker.lastNetworkActivityAt,
  );
  return tracker.now - lastActivityAt >= POST_ACTION_SETTLE_QUIET_WINDOW_MS;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw abortError(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAbpActionSettler(context: AbpActionSettlerContext) {
  const installScript = buildAbpSettleTrackerInstallScript();
  const readExpression = buildAbpSettleTrackerReadExpression();

  async function installTracker(controller: PageController): Promise<void> {
    if (!controller.settleTrackerRegistered) {
      await controller.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: installScript,
      });
      controller.settleTrackerRegistered = true;
    }

    await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.evaluate", {
      expression: installScript,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async function readTrackerState(controller: PageController) {
    const evaluated = await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.evaluate", {
      expression: readExpression,
      returnByValue: true,
      awaitPromise: true,
    });

    return normalizeAbpSettleTrackerState(evaluated.result?.value);
  }

  async function settle(options: AbpActionSettleOptions): Promise<void> {
    const { controller, timeoutMs, signal, policySettle } = options;
    if (timeoutMs <= 0) {
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const wasPaused = await context.syncExecutionPaused(controller);
    if (wasPaused) {
      await context.setExecutionPaused(controller, false);
    }

    try {
      await installTracker(controller);

      if (policySettle) {
        if (signal?.aborted) {
          throw abortError(signal);
        }
        await policySettle(controller.pageRef, signal);
      }

      while (Date.now() < deadline) {
        context.throwBackgroundError(controller);
        if (controller.lifecycleState === "closed") {
          return;
        }
        if (signal?.aborted) {
          throw abortError(signal);
        }
        const tracker = await readTrackerState(controller).catch(() => undefined);
        if (trackerStateIsSettled(tracker)) {
          break;
        }
        await delay(
          Math.min(POST_ACTION_SETTLE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          signal,
        );
      }
    } finally {
      if (wasPaused && controller.lifecycleState !== "closed") {
        try {
          await context.setExecutionPaused(controller, true);
        } catch (error) {
          if (!context.isPageClosedError(error)) {
            throw error;
          }
          return;
        }
      }

      if (controller.lifecycleState !== "closed") {
        try {
          await context.flushDomUpdateTask(controller);
        } catch (error) {
          if (!context.isPageClosedError(error)) {
            throw error;
          }
        }
      }
    }
  }

  return {
    installTracker,
    settle,
  };
}
