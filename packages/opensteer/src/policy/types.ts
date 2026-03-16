import type { BrowserCoreEngine, PageRef } from "@opensteer/browser-core";
import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

export type DomActionPolicyOperation = "dom.click" | "dom.hover" | "dom.input" | "dom.scroll";

export interface TimeoutResolutionInput {
  readonly operation: OpensteerSemanticOperationName;
}

export interface TimeoutExecutionContext extends TimeoutResolutionInput {
  readonly signal: AbortSignal;
  readonly budgetMs: number | undefined;
  readonly deadlineAt: number | undefined;
  remainingMs(): number | undefined;
  throwIfAborted(): void;
  runStep<T>(step: () => Promise<T>): Promise<T>;
}

export interface TimeoutPolicy {
  resolveTimeoutMs(input: TimeoutResolutionInput): number | undefined;
}

export type SettleTrigger = "navigation" | "dom-action" | "snapshot";

export interface SettleDelayInput {
  readonly operation: OpensteerSemanticOperationName;
  readonly trigger: SettleTrigger;
}

export interface SettleContext extends SettleDelayInput {
  readonly engine: BrowserCoreEngine;
  readonly pageRef: PageRef;
  readonly signal: AbortSignal;
}

export interface SettleObserver {
  settle(input: SettleContext): Promise<boolean>;
}

export interface SettlePolicy {
  readonly observers?: readonly SettleObserver[];
  resolveDelayMs(input: SettleDelayInput): number;
}

export interface RetryEvaluationInput {
  readonly operation: OpensteerSemanticOperationName;
  readonly error: unknown;
}

export interface RetryDecision {
  readonly retry: false;
}

export interface RetryPolicy {
  evaluate(input: RetryEvaluationInput): RetryDecision | Promise<RetryDecision>;
}

export interface FallbackEvaluationInput {
  readonly operation: OpensteerSemanticOperationName;
  readonly error: unknown;
}

export interface FallbackDecision {
  readonly fallback: false;
}

export interface FallbackPolicy {
  evaluate(input: FallbackEvaluationInput): FallbackDecision | Promise<FallbackDecision>;
}

export interface OpensteerPolicy {
  readonly timeout: TimeoutPolicy;
  readonly settle: SettlePolicy;
  readonly retry: RetryPolicy;
  readonly fallback: FallbackPolicy;
}
