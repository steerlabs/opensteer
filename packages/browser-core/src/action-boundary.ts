import type { DocumentRef, PageRef } from "./identity.js";
import {
  DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS,
  postLoadTrackerIsSettled,
  type PostLoadTrackerState,
} from "./post-load-tracker.js";

export interface ActionBoundarySnapshot {
  readonly pageRef: PageRef;
  readonly documentRef: DocumentRef;
}

export type ActionBoundarySettleTrigger = "dom-action" | "navigation";

export interface WaitForActionBoundaryInput {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly snapshot?: ActionBoundarySnapshot;
  readonly pollIntervalMs?: number;
  getCurrentMainFrameDocumentRef(): DocumentRef | undefined;
  waitForNavigationContentLoaded(timeoutMs: number): Promise<void>;
  readTrackerState(): Promise<PostLoadTrackerState | undefined>;
  throwBackgroundError(): void;
  isPageClosed(): boolean;
}

export async function waitForActionBoundary(
  input: WaitForActionBoundaryInput,
): Promise<ActionBoundarySettleTrigger> {
  if (input.timeoutMs <= 0) {
    return "dom-action";
  }

  const deadline = Date.now() + input.timeoutMs;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_ACTION_BOUNDARY_POLL_INTERVAL_MS;
  let trigger: ActionBoundarySettleTrigger = "dom-action";
  let waitedForNavigationContentLoaded = false;

  while (Date.now() < deadline) {
    input.throwBackgroundError();
    if (input.isPageClosed()) {
      return trigger;
    }
    if (input.signal?.aborted) {
      throw abortError(input.signal);
    }

    const currentDocumentRef = input.getCurrentMainFrameDocumentRef();
    if (
      input.snapshot !== undefined &&
      currentDocumentRef !== undefined &&
      currentDocumentRef !== input.snapshot.documentRef
    ) {
      trigger = "navigation";
      if (!waitedForNavigationContentLoaded) {
        waitedForNavigationContentLoaded = true;
        const remaining = Math.max(0, deadline - Date.now());
        if (remaining > 0) {
          await input.waitForNavigationContentLoaded(remaining);
        }
      }
    }

    if (postLoadTrackerIsSettled(await input.readTrackerState())) {
      return trigger;
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), input.signal);
  }

  return trigger;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw abortError(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
