import type {
  BrowserCoreEngine,
  DocumentEpoch,
  DocumentRef,
  DomSnapshot,
  NodeRef,
  PageRef,
  Point,
  Rect,
} from "@opensteer/browser-core";
import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

import type { ResolvedDomTarget } from "../runtimes/dom/types.js";

export type DomActionPolicyOperation = "dom.click" | "dom.hover" | "dom.input" | "dom.scroll";

export type ActionabilityFailureReason =
  | "missing-geometry"
  | "not-visible"
  | "disabled"
  | "not-in-viewport"
  | "obscured";

export interface ActionabilityFailureDetails {
  readonly rect?: Rect;
  readonly point?: Point;
  readonly viewportRect?: Rect;
  readonly attribute?: string;
  readonly hitNodeRef?: NodeRef;
  readonly hitDocumentRef?: DocumentRef;
  readonly hitDocumentEpoch?: DocumentEpoch;
  readonly hitObscured?: boolean;
  readonly pointerEventsSkipped?: boolean;
}

export type ActionabilityCheckResult =
  | {
      readonly actionable: true;
      readonly point: Point;
    }
  | {
      readonly actionable: false;
      readonly reason: ActionabilityFailureReason;
      readonly message: string;
      readonly details?: ActionabilityFailureDetails;
    };

export interface ActionabilityCheckInput {
  readonly engine: BrowserCoreEngine;
  readonly operation: DomActionPolicyOperation;
  readonly resolved: ResolvedDomTarget;
  readonly position?: Point;
  readonly loadDocumentSnapshot: (documentRef: DocumentRef) => Promise<DomSnapshot>;
}

export interface ActionabilityPolicy {
  check(input: ActionabilityCheckInput): Promise<ActionabilityCheckResult>;
}

export interface TimeoutResolutionInput {
  readonly operation: OpensteerSemanticOperationName;
}

export interface TimeoutExecutionContext extends TimeoutResolutionInput {
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
  readonly deadlineAt?: number;
  remainingMs(): number | undefined;
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
  readonly actionability: ActionabilityPolicy;
  readonly timeout: TimeoutPolicy;
  readonly settle: SettlePolicy;
  readonly retry: RetryPolicy;
  readonly fallback: FallbackPolicy;
}
