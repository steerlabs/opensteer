import type { DocumentRef, PageRef } from "./identity.js";
import {
  DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS,
  postLoadTrackerHasTrackedNetworkActivitySince,
  type PostLoadTrackerSnapshot,
  type PostLoadTrackerState,
} from "./post-load-tracker.js";

export const CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS = 30_000;
export const CROSS_DOCUMENT_DETECTION_WINDOW_MS = 500;

export interface ActionBoundarySnapshot {
  readonly pageRef: PageRef;
  readonly documentRef: DocumentRef;
  readonly url?: string;
  readonly tracker?: PostLoadTrackerSnapshot;
}

export type ActionBoundarySettleTrigger = "dom-action" | "navigation";
export type ActionBoundaryTimedOutPhase = "bootstrap";

export interface ActionBoundaryOutcome {
  readonly trigger: ActionBoundarySettleTrigger;
  readonly crossDocument: boolean;
  readonly bootstrapSettled: boolean;
  readonly timedOutPhase?: ActionBoundaryTimedOutPhase;
}

export interface WaitForActionBoundaryInput {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly snapshot?: ActionBoundarySnapshot;
  readonly pollIntervalMs?: number;
  getCurrentMainFrameDocumentRef(): DocumentRef | undefined;
  getCurrentPageUrl?(): string | undefined;
  isCurrentMainFrameBootstrapSettled?(): boolean;
  readTrackerState(): Promise<PostLoadTrackerState | undefined>;
  throwBackgroundError(): void;
  isPageClosed(): boolean;
}

export async function waitForActionBoundary(
  input: WaitForActionBoundaryInput,
): Promise<ActionBoundaryOutcome> {
  if (input.timeoutMs <= 0) {
    return {
      trigger: "dom-action",
      crossDocument: false,
      bootstrapSettled: false,
      timedOutPhase: "bootstrap",
    };
  }

  const deadline = Date.now() + input.timeoutMs;
  const crossDocumentDetectionDeadline =
    input.snapshot === undefined
      ? undefined
      : Math.min(deadline, Date.now() + CROSS_DOCUMENT_DETECTION_WINDOW_MS);
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS;
  let trigger: ActionBoundarySettleTrigger = "dom-action";
  let crossDocument = false;
  let sameDocumentAsyncActivity = false;

  while (Date.now() < deadline) {
    input.throwBackgroundError();
    if (input.isPageClosed()) {
      return {
        trigger,
        crossDocument,
        bootstrapSettled: true,
      };
    }
    if (input.signal?.aborted) {
      if (isTimeoutAbort(input.signal.reason) && Date.now() >= deadline) {
        return {
          trigger,
          crossDocument,
          bootstrapSettled: false,
          timedOutPhase: "bootstrap",
        };
      }
      throw abortError(input.signal);
    }

    const currentDocumentRef = input.getCurrentMainFrameDocumentRef();
    const currentPageUrl = input.getCurrentPageUrl?.();
    if (
      input.snapshot !== undefined &&
      currentDocumentRef !== undefined &&
      currentDocumentRef !== input.snapshot.documentRef
    ) {
      trigger = "navigation";
      crossDocument = true;
    }
    if (
      !crossDocument &&
      !sameDocumentAsyncActivity &&
      input.snapshot?.tracker !== undefined &&
      postLoadTrackerHasTrackedNetworkActivitySince(
        input.snapshot.tracker,
        await input.readTrackerState(),
      )
    ) {
      trigger = "navigation";
      sameDocumentAsyncActivity = true;
    }
    if (
      !crossDocument &&
      input.snapshot?.url !== undefined &&
      currentPageUrl !== undefined &&
      currentPageUrl !== input.snapshot.url &&
      input.isCurrentMainFrameBootstrapSettled !== undefined &&
      !input.isCurrentMainFrameBootstrapSettled()
    ) {
      trigger = "navigation";
      crossDocument = true;
    }

    if (
      !crossDocument &&
      crossDocumentDetectionDeadline !== undefined &&
      Date.now() >= crossDocumentDetectionDeadline
    ) {
      return {
        trigger,
        crossDocument,
        bootstrapSettled: true,
      };
    }

    if (sameDocumentAsyncActivity) {
      return {
        trigger,
        crossDocument,
        bootstrapSettled: true,
      };
    }

    if (
      crossDocument &&
      input.isCurrentMainFrameBootstrapSettled !== undefined &&
      !input.isCurrentMainFrameBootstrapSettled()
    ) {
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      continue;
    }

    if (crossDocument) {
      return {
        trigger,
        crossDocument,
        bootstrapSettled: true,
      };
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return {
    trigger,
    crossDocument,
    bootstrapSettled: false,
    timedOutPhase: "bootstrap",
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeoutAbort(reason: unknown): reason is { readonly code: string } {
  return (
    typeof reason === "object" && reason !== null && "code" in reason && reason.code === "timeout"
  );
}
