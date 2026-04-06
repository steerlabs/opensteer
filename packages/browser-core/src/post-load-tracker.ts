export const DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS = 400;
export const DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS = 100;

export interface PostLoadTrackerState {
  readonly installedAt: number;
  readonly lastMutationAt: number;
  readonly lastNetworkActivityAt: number;
  readonly lastTrackedNetworkActivityAt: number;
  readonly now: number;
  readonly pendingFetches: number;
  readonly pendingTimeouts: number;
  readonly pendingXhrs: number;
  readonly trackedPendingFetches: number;
  readonly trackedPendingXhrs: number;
  readonly collecting: boolean;
  readonly readyState: string;
}

export interface PostLoadTrackerSnapshot {
  readonly lastTrackedNetworkActivityAt: number;
  readonly trackedPendingFetches: number;
  readonly trackedPendingXhrs: number;
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
  const lastTrackedNetworkActivityAt = readFiniteNumber(value.lastTrackedNetworkActivityAt);
  const now = readFiniteNumber(value.now);
  const readyState = typeof value.readyState === "string" ? value.readyState : undefined;
  if (
    installedAt === undefined ||
    lastMutationAt === undefined ||
    lastNetworkActivityAt === undefined ||
    lastTrackedNetworkActivityAt === undefined ||
    now === undefined ||
    readyState === undefined
  ) {
    return undefined;
  }

  return {
    installedAt,
    lastMutationAt,
    lastNetworkActivityAt,
    lastTrackedNetworkActivityAt,
    now,
    pendingFetches: readNonNegativeNumber(value.pendingFetches),
    pendingTimeouts: readNonNegativeNumber(value.pendingTimeouts),
    pendingXhrs: readNonNegativeNumber(value.pendingXhrs),
    trackedPendingFetches: readNonNegativeNumber(value.trackedPendingFetches),
    trackedPendingXhrs: readNonNegativeNumber(value.trackedPendingXhrs),
    collecting: value.collecting === true,
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
      lastTrackedNetworkActivityAt: performance.now(),
      pendingFetches: 0,
      pendingTimeouts: 0,
      pendingXhrs: 0,
      trackedPendingFetches: 0,
      trackedPendingXhrs: 0,
      collecting: true,
      readyState: document.readyState,
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
    const markTrackedNetwork = () => {
      tracker.lastTrackedNetworkActivityAt = performance.now();
      markNetwork();
    };
    const resetTracking = () => {
      const now = performance.now();
      tracker.lastTrackedNetworkActivityAt = now;
      tracker.trackedPendingFetches = 0;
      tracker.trackedPendingXhrs = 0;
      tracker.collecting = true;
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

    if (typeof globalObject.fetch === "function") {
      const nativeFetch = globalObject.fetch.bind(globalObject);
      globalObject.fetch = (...args) => {
        const tracked = tracker.collecting === true;
        tracker.pendingFetches += 1;
        if (tracked) {
          tracker.trackedPendingFetches += 1;
          markTrackedNetwork();
        } else {
          markNetwork();
        }
        return nativeFetch(...args)
          .finally(() => {
            tracker.pendingFetches = Math.max(0, tracker.pendingFetches - 1);
            if (tracked) {
              tracker.trackedPendingFetches = Math.max(0, tracker.trackedPendingFetches - 1);
              markTrackedNetwork();
            } else {
              markNetwork();
            }
          });
      };
    }

    if (typeof globalObject.XMLHttpRequest === "function") {
      const NativeXMLHttpRequest = globalObject.XMLHttpRequest;
      const nativeSend = NativeXMLHttpRequest.prototype.send;
      NativeXMLHttpRequest.prototype.send = function(...args) {
        const tracked = tracker.collecting === true;
        tracker.pendingXhrs += 1;
        if (tracked) {
          tracker.trackedPendingXhrs += 1;
          markTrackedNetwork();
        } else {
          markNetwork();
        }
        const finalize = () => {
          this.removeEventListener("loadend", finalize);
          tracker.pendingXhrs = Math.max(0, tracker.pendingXhrs - 1);
          if (tracked) {
            tracker.trackedPendingXhrs = Math.max(0, tracker.trackedPendingXhrs - 1);
            markTrackedNetwork();
          } else {
            markNetwork();
          }
        };
        this.addEventListener("loadend", finalize, { once: true });
        return nativeSend.apply(this, args);
      };
    }

    tracker.beginObservation = () => {
      resetTracking();
      return true;
    };
    tracker.freezeObservation = () => {
      tracker.collecting = false;
      tracker.readyState = document.readyState;
      return true;
    };

    return true;
  })()`;
}

export function buildPostLoadTrackerBeginExpression(): string {
  return `(() => {
    const tracker = globalThis.__opensteerActionBoundaryTracker;
    if (!tracker || typeof tracker.beginObservation !== "function") {
      return false;
    }
    return tracker.beginObservation();
  })()`;
}

export function buildPostLoadTrackerFreezeExpression(): string {
  return `(() => {
    const tracker = globalThis.__opensteerActionBoundaryTracker;
    if (!tracker || typeof tracker.freezeObservation !== "function") {
      return false;
    }
    return tracker.freezeObservation();
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
      lastTrackedNetworkActivityAt: Number(tracker.lastTrackedNetworkActivityAt ?? 0),
      now: Number(performance.now()),
      pendingFetches: Number(tracker.pendingFetches ?? 0),
      pendingTimeouts: Number(tracker.pendingTimeouts ?? 0),
      pendingXhrs: Number(tracker.pendingXhrs ?? 0),
      trackedPendingFetches: Number(tracker.trackedPendingFetches ?? 0),
      trackedPendingXhrs: Number(tracker.trackedPendingXhrs ?? 0),
      collecting: tracker.collecting === true,
      readyState: String(document.readyState),
    };
  })()`;
}

export function capturePostLoadTrackerSnapshot(
  tracker: PostLoadTrackerState,
): PostLoadTrackerSnapshot {
  return {
    lastTrackedNetworkActivityAt: tracker.lastTrackedNetworkActivityAt,
    trackedPendingFetches: tracker.trackedPendingFetches,
    trackedPendingXhrs: tracker.trackedPendingXhrs,
  };
}

export function postLoadTrackerHasTrackedNetworkActivitySince(
  snapshot: PostLoadTrackerSnapshot,
  tracker: PostLoadTrackerState | undefined,
): boolean {
  if (!tracker) {
    return false;
  }

  return (
    tracker.trackedPendingFetches > snapshot.trackedPendingFetches ||
    tracker.trackedPendingXhrs > snapshot.trackedPendingXhrs ||
    tracker.lastTrackedNetworkActivityAt > snapshot.lastTrackedNetworkActivityAt
  );
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

  if (tracker.trackedPendingFetches > 0 || tracker.trackedPendingXhrs > 0) {
    return false;
  }

  const lastActivityAt = Math.max(
    tracker.installedAt,
    tracker.lastMutationAt,
    tracker.lastTrackedNetworkActivityAt,
  );
  return tracker.now - lastActivityAt >= quietWindowMs;
}
