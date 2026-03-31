export const DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS = 400;
export const DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS = 100;

export interface PostLoadTrackerState {
  readonly installedAt: number;
  readonly lastMutationAt: number;
  readonly lastNetworkActivityAt: number;
  readonly now: number;
  readonly pendingFetches: number;
  readonly pendingTimeouts: number;
  readonly pendingXhrs: number;
  readonly readyState: string;
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

export function normalizePostLoadTrackerState(value: unknown): PostLoadTrackerState | undefined {
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

export function buildPostLoadTrackerInstallScript(): string {
  return `(() => {
    const globalObject = globalThis;
    if (globalObject.__opensteerActionBoundaryTrackerInstalled) {
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
    globalObject.__opensteerActionBoundaryTrackerInstalled = true;
    globalObject.__opensteerActionBoundaryTracker = tracker;

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

export function buildPostLoadTrackerReadExpression(): string {
  return `(() => {
    const tracker = globalThis.__opensteerActionBoundaryTracker;
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

export function postLoadTrackerIsSettled(
  tracker: PostLoadTrackerState | undefined,
  quietWindowMs = DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
): boolean {
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
  return tracker.now - lastActivityAt >= quietWindowMs;
}
