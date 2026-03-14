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

export const defaultTimeoutPolicy: TimeoutPolicy = {
  resolveTimeoutMs(input) {
    return DEFAULT_TIMEOUTS[input.operation];
  },
};

export const defaultSettlePolicy: SettlePolicy = {
  observers: [],
  resolveDelayMs(input) {
    return DEFAULT_SETTLE_DELAYS[input.trigger] ?? 0;
  },
};

export const defaultRetryPolicy: RetryPolicy = {
  evaluate() {
    return { retry: false } satisfies RetryDecision;
  },
};

export const defaultFallbackPolicy: FallbackPolicy = {
  evaluate() {
    return { fallback: false } satisfies FallbackDecision;
  },
};

export function defaultPolicy(): OpensteerPolicy {
  return {
    actionability: defaultActionabilityPolicy,
    timeout: defaultTimeoutPolicy,
    settle: defaultSettlePolicy,
    retry: defaultRetryPolicy,
    fallback: defaultFallbackPolicy,
  };
}
