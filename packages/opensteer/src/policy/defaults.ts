import type {
  FallbackDecision,
  FallbackPolicy,
  OpensteerPolicy,
  RetryDecision,
  RetryPolicy,
  SettlePolicy,
  TimeoutPolicy,
} from "./types.js";
import { defaultActionabilityPolicy } from "./actionability.js";

const DEFAULT_TIMEOUTS: Readonly<Record<string, number>> = {
  "session.open": 30_000,
  "page.goto": 30_000,
  "page.snapshot": 15_000,
  "computer.execute": 30_000,
  "dom.click": 10_000,
  "dom.hover": 10_000,
  "dom.input": 10_000,
  "dom.scroll": 10_000,
  "dom.extract": 15_000,
  "session.close": 10_000,
};

const DEFAULT_SETTLE_DELAYS: Readonly<Record<string, number>> = {
  navigation: 500,
  "dom-action": 100,
  snapshot: 0,
};

const EMPTY_SETTLE_OBSERVERS: NonNullable<SettlePolicy["observers"]> = Object.freeze([]);

export const defaultTimeoutPolicy: TimeoutPolicy = {
  resolveTimeoutMs(input) {
    return DEFAULT_TIMEOUTS[input.operation];
  },
};
Object.freeze(defaultTimeoutPolicy);

export const defaultSettlePolicy: SettlePolicy = {
  observers: EMPTY_SETTLE_OBSERVERS,
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
  actionability: defaultActionabilityPolicy,
  timeout: defaultTimeoutPolicy,
  settle: defaultSettlePolicy,
  retry: defaultRetryPolicy,
  fallback: defaultFallbackPolicy,
};
Object.freeze(DEFAULT_POLICY);

export function defaultPolicy(): OpensteerPolicy {
  return DEFAULT_POLICY;
}
