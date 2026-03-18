import { DEFAULT_VISUAL_STABILITY_SETTLE_MS } from "@opensteer/browser-core";

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
  "dom.click": 10_000,
  "dom.hover": 10_000,
  "dom.input": 10_000,
  "dom.scroll": 10_000,
  "dom.extract": 15_000,
  "network.query": 15_000,
  "network.save": 15_000,
  "network.clear": 10_000,
  "scripts.capture": 15_000,
  "request.raw": 30_000,
  "request-plan.infer": 15_000,
  "request-plan.write": 10_000,
  "request-plan.get": 10_000,
  "request-plan.list": 10_000,
  "request.execute": 30_000,
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

const DEFAULT_SETTLE_OBSERVERS: NonNullable<SettlePolicy["observers"]> = Object.freeze([
  defaultSnapshotSettleObserver,
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
