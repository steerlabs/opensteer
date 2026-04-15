import vm from "node:vm";

import { describe, expect, test } from "vitest";

import {
  waitForActionBoundary,
  buildPostLoadTrackerBeginExpression,
  buildPostLoadTrackerFreezeExpression,
  buildPostLoadTrackerInstallScript,
  buildPostLoadTrackerReadExpression,
  postLoadTrackerHasTrackedNetworkActivitySince,
  postLoadTrackerIsSettled,
} from "../../packages/browser-core/src/index.js";

describe("post-load tracker", () => {
  test("ignores scheduled timeouts when determining settle state", () => {
    expect(
      postLoadTrackerIsSettled({
        installedAt: 0,
        lastMutationAt: 0,
        lastNetworkActivityAt: 0,
        lastTrackedNetworkActivityAt: 0,
        now: 1_000,
        pendingFetches: 0,
        pendingTimeouts: 9,
        pendingXhrs: 0,
        trackedPendingFetches: 0,
        trackedPendingXhrs: 0,
        collecting: false,
        readyState: "complete",
      }),
    ).toBe(true);
  });

  test("install script does not treat setTimeout scheduling as live activity", () => {
    let now = 100;
    const listeners = new Map<string, Set<() => void>>();
    const documentListeners = new Map<string, Set<() => void>>();

    class FakeNode {}

    class FakeMutationObserver {
      constructor(private readonly callback: () => void) {}

      observe() {
        this.callback();
      }
    }

    const nativeSetTimeout = (callback: (...args: unknown[]) => unknown, _delay?: number) => {
      return { callback };
    };
    const nativeClearTimeout = () => undefined;

    const document = {
      readyState: "complete",
      documentElement: new FakeNode(),
      addEventListener(type: string, listener: () => void) {
        let set = documentListeners.get(type);
        if (!set) {
          set = new Set();
          documentListeners.set(type, set);
        }
        set.add(listener);
      },
    };

    const context = vm.createContext({
      Node: FakeNode,
      MutationObserver: FakeMutationObserver,
      document,
      performance: {
        now: () => now,
      },
      addEventListener(type: string, listener: () => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      setTimeout: nativeSetTimeout,
      clearTimeout: nativeClearTimeout,
      globalThis: undefined as unknown,
    });
    context.globalThis = context;

    vm.runInContext(buildPostLoadTrackerInstallScript(), context);

    const trackerBefore = vm.runInContext(buildPostLoadTrackerReadExpression(), context) as {
      readonly lastNetworkActivityAt: number;
      readonly pendingTimeouts: number;
    };

    now = 175;
    context.setTimeout(() => undefined, 0);

    const trackerAfter = vm.runInContext(buildPostLoadTrackerReadExpression(), context) as {
      readonly lastNetworkActivityAt: number;
      readonly pendingTimeouts: number;
    };

    expect(trackerAfter.pendingTimeouts).toBe(0);
    expect(trackerAfter.lastNetworkActivityAt).toBe(trackerBefore.lastNetworkActivityAt);
  });

  test("tracked network activity can be reset and frozen per action", async () => {
    let now = 100;
    const listeners = new Map<string, Set<() => void>>();
    const documentListeners = new Map<string, Set<() => void>>();

    class FakeNode {}

    class FakeMutationObserver {
      constructor(private readonly callback: () => void) {}

      observe() {
        this.callback();
      }
    }

    const document = {
      readyState: "complete",
      documentElement: new FakeNode(),
      addEventListener(type: string, listener: () => void) {
        let set = documentListeners.get(type);
        if (!set) {
          set = new Set();
          documentListeners.set(type, set);
        }
        set.add(listener);
      },
    };

    const context = vm.createContext({
      Node: FakeNode,
      MutationObserver: FakeMutationObserver,
      document,
      performance: {
        now: () => now,
      },
      addEventListener(type: string, listener: () => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      setTimeout: (_callback: (...args: unknown[]) => unknown, _delay?: number) => ({
        callback: _callback,
      }),
      clearTimeout: () => undefined,
      globalThis: undefined as unknown,
    });
    context.globalThis = context;
    context.fetch = () => Promise.resolve(undefined);

    vm.runInContext(buildPostLoadTrackerInstallScript(), context);
    vm.runInContext(buildPostLoadTrackerBeginExpression(), context);
    const baseline = vm.runInContext(buildPostLoadTrackerReadExpression(), context) as {
      readonly lastTrackedNetworkActivityAt: number;
      readonly trackedPendingFetches: number;
    };

    now = 140;
    const fetchPromise = context.fetch("https://example.test");
    const duringFetch = vm.runInContext(buildPostLoadTrackerReadExpression(), context) as {
      readonly lastTrackedNetworkActivityAt: number;
      readonly trackedPendingFetches: number;
    };
    expect(
      postLoadTrackerHasTrackedNetworkActivitySince(baseline, {
        installedAt: 0,
        lastMutationAt: 0,
        lastNetworkActivityAt: duringFetch.lastTrackedNetworkActivityAt,
        lastTrackedNetworkActivityAt: duringFetch.lastTrackedNetworkActivityAt,
        now,
        pendingFetches: duringFetch.trackedPendingFetches,
        pendingTimeouts: 0,
        pendingXhrs: 0,
        trackedPendingFetches: duringFetch.trackedPendingFetches,
        trackedPendingXhrs: 0,
        collecting: true,
        readyState: "complete",
      }),
    ).toBe(true);

    vm.runInContext(buildPostLoadTrackerFreezeExpression(), context);
    await fetchPromise;
    now = 600;
    const settled = vm.runInContext(buildPostLoadTrackerReadExpression(), context);
    expect(postLoadTrackerIsSettled(settled as never)).toBe(true);
  });

  test("same-document tracked network activity promotes the action boundary to navigation", async () => {
    let reads = 0;
    const boundary = await waitForActionBoundary({
      timeoutMs: 1_000,
      snapshot: {
        pageRef: "page-1" as never,
        documentRef: "doc-1" as never,
        url: "https://example.test/search",
        tracker: {
          lastMutationAt: 100,
          lastTrackedNetworkActivityAt: 100,
          trackedPendingFetches: 0,
          trackedPendingXhrs: 0,
        },
      },
      getCurrentMainFrameDocumentRef: () => "doc-1" as never,
      getCurrentPageUrl: () => "https://example.test/search",
      isCurrentMainFrameBootstrapSettled: () => true,
      readTrackerState: async () => {
        reads += 1;
        if (reads < 2) {
          return {
            installedAt: 100,
            lastMutationAt: 100,
            lastNetworkActivityAt: 100,
            lastTrackedNetworkActivityAt: 100,
            now: 100,
            pendingFetches: 0,
            pendingTimeouts: 0,
            pendingXhrs: 0,
            trackedPendingFetches: 0,
            trackedPendingXhrs: 0,
            collecting: true,
            readyState: "complete",
          };
        }
        return {
          installedAt: 100,
          lastMutationAt: 120,
          lastNetworkActivityAt: 140,
          lastTrackedNetworkActivityAt: 140,
          now: 140,
          pendingFetches: 1,
          pendingTimeouts: 0,
          pendingXhrs: 0,
          trackedPendingFetches: 1,
          trackedPendingXhrs: 0,
          collecting: true,
          readyState: "complete",
        };
      },
      throwBackgroundError: () => undefined,
      isPageClosed: () => false,
    });

    expect(boundary).toEqual({
      trigger: "navigation",
      crossDocument: false,
      bootstrapSettled: true,
      observedMutationQuietMs: 20,
    });
  });
});
