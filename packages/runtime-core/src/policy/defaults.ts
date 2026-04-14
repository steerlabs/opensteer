import {
  DEFAULT_VISUAL_STABILITY_SETTLE_MS,
  DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
  type VisualStabilityScope,
} from "@opensteer/browser-core";

import type {
  FallbackDecision,
  FallbackPolicy,
  OpensteerPolicy,
  RetryDecision,
  RetryPolicy,
  SettleObserver,
  SettlePolicy,
  TimeoutPolicy,
} from "./types.js";

const DEFAULT_TIMEOUTS: Readonly<Record<string, number>> = {
  "session.open": 30_000,
  "page.goto": 30_000,
  "page.add-init-script": 10_000,
  "page.snapshot": 15_000,
  "computer.execute": 30_000,
  "dom.click": 30_000,
  "dom.hover": 10_000,
  "dom.input": 30_000,
  "dom.scroll": 10_000,
  "dom.extract": 15_000,
  "network.query": 15_000,
  "network.detail": 15_000,
  "scripts.capture": 15_000,
  "session.cookies": 10_000,
  "session.storage": 10_000,
  "session.state": 15_000,
  "session.fetch": 30_000,
  "session.close": 10_000,
};

const DEFAULT_SETTLE_DELAYS: Readonly<Record<string, number>> = {
  navigation: 500,
  "dom-action": 100,
  snapshot: 0,
};

const defaultSnapshotSettleObserver: SettleObserver = {
  async settle(input) {
    if (input.trigger !== "snapshot") {
      return false;
    }

    await input.engine.waitForVisualStability({
      pageRef: input.pageRef,
      ...(input.remainingMs === undefined ? {} : { timeoutMs: input.remainingMs }),
      settleMs: DEFAULT_VISUAL_STABILITY_SETTLE_MS,
      scope: "visible-frames",
    });
    return true;
  },
};
Object.freeze(defaultSnapshotSettleObserver);

interface VisualStabilityProfile {
  readonly settleMs: number;
  readonly scope: VisualStabilityScope;
  readonly timeoutMs: number;
}

const DOM_ACTION_VISUAL_STABILITY_PROFILES: Readonly<Record<string, VisualStabilityProfile>> = {
  "dom.click": { settleMs: 750, scope: "visible-frames", timeoutMs: 7_000 },
  "dom.input": { settleMs: 750, scope: "visible-frames", timeoutMs: 7_000 },
  "dom.scroll": { settleMs: 600, scope: "visible-frames", timeoutMs: 7_000 },
  "dom.hover": { settleMs: 200, scope: "main-frame", timeoutMs: 2_500 },
};

const DEFAULT_DOM_ACTION_VISUAL_STABILITY_PROFILE: VisualStabilityProfile = {
  settleMs: 750,
  scope: "visible-frames",
  timeoutMs: 7_000,
};

const NAVIGATION_VISUAL_STABILITY_PROFILE: VisualStabilityProfile = {
  settleMs: 750,
  scope: "visible-frames",
  timeoutMs: 7_000,
};

const NAVIGATION_POST_LOAD_CAPTURE_WINDOW_MS = 1_000;

const defaultDomActionSettleObserver: SettleObserver = {
  async settle(input) {
    if (input.trigger !== "dom-action") {
      return false;
    }

    const profile =
      DOM_ACTION_VISUAL_STABILITY_PROFILES[input.operation] ??
      DEFAULT_DOM_ACTION_VISUAL_STABILITY_PROFILE;

    const effectiveTimeout =
      input.remainingMs === undefined
        ? profile.timeoutMs
        : Math.min(profile.timeoutMs, input.remainingMs);

    if (effectiveTimeout <= 0) {
      return false;
    }

    try {
      await input.engine.waitForVisualStability({
        pageRef: input.pageRef,
        timeoutMs: effectiveTimeout,
        settleMs: profile.settleMs,
        scope: profile.scope,
      });
      return true;
    } catch {
      return false;
    }
  },
};
Object.freeze(defaultDomActionSettleObserver);

const defaultNavigationSettleObserver: SettleObserver = {
  async settle(input) {
    if (input.trigger !== "navigation") {
      return false;
    }

    const profile = NAVIGATION_VISUAL_STABILITY_PROFILE;

    const effectiveTimeout =
      input.remainingMs === undefined
        ? profile.timeoutMs
        : Math.min(profile.timeoutMs, input.remainingMs);

    if (effectiveTimeout <= 0) {
      return false;
    }

    try {
      const startedAt = Date.now();
      await input.engine.waitForPostLoadQuiet({
        pageRef: input.pageRef,
        timeoutMs: effectiveTimeout,
        quietMs: DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
        captureWindowMs: Math.min(NAVIGATION_POST_LOAD_CAPTURE_WINDOW_MS, effectiveTimeout),
        signal: input.signal,
      });
      const visualTimeout = Math.max(0, effectiveTimeout - (Date.now() - startedAt));
      if (visualTimeout <= 0) {
        return true;
      }
      await input.engine.waitForVisualStability({
        pageRef: input.pageRef,
        timeoutMs: visualTimeout,
        settleMs: profile.settleMs,
        scope: profile.scope,
      });
      return true;
    } catch {
      return false;
    }
  },
};
Object.freeze(defaultNavigationSettleObserver);

const DEFAULT_SETTLE_OBSERVERS: NonNullable<SettlePolicy["observers"]> = Object.freeze([
  defaultSnapshotSettleObserver,
  defaultDomActionSettleObserver,
  defaultNavigationSettleObserver,
]);

export const defaultTimeoutPolicy: TimeoutPolicy = {
  resolveTimeoutMs(input) {
    return DEFAULT_TIMEOUTS[input.operation];
  },
};
Object.freeze(defaultTimeoutPolicy);

export const defaultSettlePolicy: SettlePolicy = {
  observers: DEFAULT_SETTLE_OBSERVERS,
  resolveDelayMs(input) {
    return DEFAULT_SETTLE_DELAYS[input.trigger] ?? 0;
  },
};
Object.freeze(defaultSettlePolicy);

export const defaultRetryPolicy: RetryPolicy = {
  evaluate() {
    return { retry: false } satisfies RetryDecision;
  },
};
Object.freeze(defaultRetryPolicy);

export const defaultFallbackPolicy: FallbackPolicy = {
  evaluate() {
    return { fallback: false } satisfies FallbackDecision;
  },
};
Object.freeze(defaultFallbackPolicy);

const DEFAULT_POLICY: OpensteerPolicy = {
  timeout: defaultTimeoutPolicy,
  settle: defaultSettlePolicy,
  retry: defaultRetryPolicy,
  fallback: defaultFallbackPolicy,
};
Object.freeze(DEFAULT_POLICY);

export function defaultPolicy(): OpensteerPolicy {
  return DEFAULT_POLICY;
}
