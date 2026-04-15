import type { DocumentRef, PageRef } from "./identity.js";
import {
  DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS,
  DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
  getPostLoadTrackerMutationQuietMs,
  postLoadTrackerHasTrackedNetworkActivitySince,
  postLoadTrackerIsSettled,
  type PostLoadTrackerSnapshot,
  type PostLoadTrackerState,
} from "./post-load-tracker.js";

export const CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS = 30_000;
export const CROSS_DOCUMENT_DETECTION_WINDOW_MS = 500;

/**
 * Maximum time (ms) to wait for post-load network quiet after a cross-document
 * navigation has been detected and bootstrap has settled.  Heavy sites may keep
 * issuing fetch/XHR requests indefinitely (analytics, ads, lazy data), so the
 * tracker would never reach zero pending requests.  Capping this phase prevents
 * the whole action from timing out just because the new page is chatty.
 */
export const CROSS_DOCUMENT_POST_LOAD_SETTLE_TIMEOUT_MS = 5_000;

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
  readonly observedMutationQuietMs?: number;
  readonly postLoadHandled?: boolean;
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
  let crossDocumentPostLoadDeadline: number | undefined;
  let lastTrackerState: PostLoadTrackerState | undefined;

  const finalizeOutcome = (
    outcome: Omit<ActionBoundaryOutcome, "observedMutationQuietMs" | "postLoadHandled">,
  ): ActionBoundaryOutcome => {
    const observedMutationQuietMs =
      !crossDocument &&
      input.snapshot?.tracker !== undefined &&
      lastTrackerState !== undefined &&
      lastTrackerState.lastMutationAt <= input.snapshot.tracker.lastMutationAt
        ? undefined
        : getPostLoadTrackerMutationQuietMs(lastTrackerState);
    return {
      ...outcome,
      ...(observedMutationQuietMs === undefined ? {} : { observedMutationQuietMs }),
      ...(crossDocument && outcome.bootstrapSettled ? { postLoadHandled: true } : {}),
    };
  };

  while (Date.now() < deadline) {
    input.throwBackgroundError();
    if (input.isPageClosed()) {
      return finalizeOutcome({
        trigger,
        crossDocument,
        bootstrapSettled: true,
      });
    }
    if (input.signal?.aborted) {
      if (isTimeoutAbort(input.signal.reason) && Date.now() >= deadline) {
        return finalizeOutcome({
          trigger,
          crossDocument,
          bootstrapSettled: false,
          timedOutPhase: "bootstrap",
        });
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
        (lastTrackerState = await input.readTrackerState()),
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
      return finalizeOutcome({
        trigger,
        crossDocument,
        bootstrapSettled: true,
      });
    }

    if (sameDocumentAsyncActivity) {
      return finalizeOutcome({
        trigger,
        crossDocument,
        bootstrapSettled: true,
      });
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
      // Start the post-load settle deadline once bootstrap is settled.
      if (crossDocumentPostLoadDeadline === undefined) {
        crossDocumentPostLoadDeadline = Math.min(
          deadline,
          Date.now() + CROSS_DOCUMENT_POST_LOAD_SETTLE_TIMEOUT_MS,
        );
      }

      // If the post-load settle sub-timeout expired, accept the navigation as
      // settled.  Heavy pages (ads, analytics, streaming data) may never reach
      // zero pending tracked requests, so waiting longer just wastes the budget.
      if (Date.now() >= crossDocumentPostLoadDeadline) {
        return finalizeOutcome({
          trigger,
          crossDocument,
          bootstrapSettled: true,
        });
      }

      if (
        !postLoadTrackerIsSettled(
          (lastTrackerState = await input.readTrackerState()),
          DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
        )
      ) {
        await delay(
          Math.min(pollIntervalMs, Math.max(0, crossDocumentPostLoadDeadline - Date.now())),
        );
        continue;
      }
      return finalizeOutcome({
        trigger,
        crossDocument,
        bootstrapSettled: true,
      });
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return finalizeOutcome({
    trigger,
    crossDocument,
    bootstrapSettled: false,
    timedOutPhase: "bootstrap",
  });
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
