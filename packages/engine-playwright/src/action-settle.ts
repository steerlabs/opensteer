import {
  CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS,
  capturePostLoadTrackerSnapshot,
  buildPostLoadTrackerBeginExpression,
  buildPostLoadTrackerFreezeExpression,
  buildPostLoadTrackerInstallScript,
  buildPostLoadTrackerReadExpression,
  normalizePostLoadTrackerState,
  DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
  postLoadTrackerIsSettled,
  waitForActionBoundary,
  type ActionBoundaryOutcome,
  type ActionBoundarySettleTrigger,
  type ActionBoundarySnapshot,
  type DocumentRef,
  type PageRef,
} from "@opensteer/browser-core";

import { isContextClosedError, normalizePlaywrightError } from "./errors.js";
import type { PageController } from "./types.js";

export const DEFAULT_PLAYWRIGHT_ACTION_SETTLE_TIMEOUT_MS = CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS;
export const DEFAULT_PLAYWRIGHT_POST_LOAD_CAPTURE_WINDOW_MS = 1_000;

interface PlaywrightActionSettlerContext {
  flushPendingPageTasks(sessionRef: PageController["sessionRef"]): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  getMainFrameDocumentRef(controller: PageController): DocumentRef | undefined;
  isCurrentMainFrameBootstrapSettled(controller: PageController): boolean;
  throwBackgroundError(controller: PageController): void;
}

export interface PlaywrightActionSettleOptions {
  readonly controller: PageController;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly snapshot?: ActionBoundarySnapshot;
  readonly policySettle?: (pageRef: PageRef, trigger: ActionBoundarySettleTrigger) => Promise<void>;
}

export interface PlaywrightActionBoundaryOptions {
  readonly signal?: AbortSignal;
  readonly snapshot?: ActionBoundarySnapshot;
  readonly policySettle?: (pageRef: PageRef, trigger: ActionBoundarySettleTrigger) => Promise<void>;
  remainingMs(): number | undefined;
}

interface RuntimeEvaluateValueResponse {
  readonly result?: {
    readonly value?: unknown;
  };
}

export function clampPlaywrightActionSettleTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_PLAYWRIGHT_ACTION_SETTLE_TIMEOUT_MS;
  }
  return Math.max(0, Math.min(DEFAULT_PLAYWRIGHT_ACTION_SETTLE_TIMEOUT_MS, timeoutMs));
}

export function createPlaywrightActionSettler(context: PlaywrightActionSettlerContext) {
  const installScript = buildPostLoadTrackerInstallScript();
  const beginExpression = buildPostLoadTrackerBeginExpression();
  const freezeExpression = buildPostLoadTrackerFreezeExpression();
  const readExpression = buildPostLoadTrackerReadExpression();

  async function installTracker(controller: PageController): Promise<void> {
    if (!controller.settleTrackerRegistered) {
      await controller.page.addInitScript(installScript);
      controller.settleTrackerRegistered = true;
    }

    try {
      await controller.cdp.send("Runtime.evaluate", {
        expression: installScript,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (error) {
      if (controller.lifecycleState === "closed" || isContextClosedError(error)) {
        return;
      }
      throw normalizePlaywrightError(error, controller.pageRef);
    }
  }

  async function readTrackerState(controller: PageController) {
    try {
      const evaluated = (await controller.cdp.send("Runtime.evaluate", {
        expression: readExpression,
        returnByValue: true,
        awaitPromise: true,
      })) as RuntimeEvaluateValueResponse;

      return normalizePostLoadTrackerState(evaluated.result?.value);
    } catch (error) {
      if (isIgnorableTrackerReadError(error)) {
        return undefined;
      }
      throw normalizePlaywrightError(error, controller.pageRef);
    }
  }

  async function beginTrackerObservation(controller: PageController): Promise<void> {
    await installTracker(controller);
    try {
      await controller.cdp.send("Runtime.evaluate", {
        expression: beginExpression,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (error) {
      if (isIgnorableTrackerReadError(error)) {
        return;
      }
      throw normalizePlaywrightError(error, controller.pageRef);
    }
  }

  async function freezeTrackerObservation(controller: PageController): Promise<void> {
    try {
      await controller.cdp.send("Runtime.evaluate", {
        expression: freezeExpression,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (error) {
      if (isIgnorableTrackerReadError(error)) {
        return;
      }
      throw normalizePlaywrightError(error, controller.pageRef);
    }
  }

  async function captureSnapshot(controller: PageController): Promise<ActionBoundarySnapshot> {
    const documentRef = context.getMainFrameDocumentRef(controller);
    if (documentRef === undefined) {
      throw new Error(`page ${controller.pageRef} does not expose a main frame`);
    }

    await beginTrackerObservation(controller);
    const tracker = await readTrackerState(controller);
    return {
      pageRef: controller.pageRef,
      documentRef,
      url: controller.page.url(),
      ...(tracker === undefined ? {} : { tracker: capturePostLoadTrackerSnapshot(tracker) }),
    };
  }

  async function waitForPostLoadQuiet(input: {
    readonly controller: PageController;
    readonly timeoutMs: number;
    readonly quietMs?: number;
    readonly captureWindowMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const { controller, timeoutMs, signal } = input;
    if (timeoutMs <= 0) {
      return;
    }

    const quietMs = input.quietMs ?? DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS;
    const captureWindowMs = Math.max(
      0,
      Math.min(input.captureWindowMs ?? DEFAULT_PLAYWRIGHT_POST_LOAD_CAPTURE_WINDOW_MS, timeoutMs),
    );
    const deadline = Date.now() + timeoutMs;

    await installTracker(controller);
    if (captureWindowMs > 0) {
      await delayWithSignal(captureWindowMs, signal, deadline);
    }
    await freezeTrackerObservation(controller);

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ?? abortError();
      }
      context.throwBackgroundError(controller);
      if (controller.lifecycleState === "closed") {
        return;
      }
      if (postLoadTrackerIsSettled(await readTrackerState(controller), quietMs)) {
        return;
      }
      await delayWithSignal(100, signal, deadline);
    }
  }

  async function settle(options: PlaywrightActionSettleOptions): Promise<ActionBoundaryOutcome> {
    const { controller, timeoutMs, signal, snapshot, policySettle } = options;
    if (timeoutMs <= 0) {
      return {
        trigger: "dom-action",
        crossDocument: false,
        bootstrapSettled: false,
        timedOutPhase: "bootstrap",
      };
    }

    await context.flushPendingPageTasks(controller.sessionRef);

    let boundary: ActionBoundaryOutcome;
    if (snapshot === undefined) {
      if (policySettle) {
        if (signal?.aborted) {
          throw signal.reason ?? abortError();
        }
        await policySettle(controller.pageRef, "dom-action");
      }
      boundary = {
        trigger: "dom-action",
        crossDocument: false,
        bootstrapSettled: true,
      };
    } else {
      await installTracker(controller);
      boundary = await waitForActionBoundary({
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
        snapshot,
        getCurrentMainFrameDocumentRef: () => context.getMainFrameDocumentRef(controller),
        getCurrentPageUrl: () => controller.page.url(),
        isCurrentMainFrameBootstrapSettled: () =>
          context.isCurrentMainFrameBootstrapSettled(controller),
        readTrackerState: () => readTrackerState(controller),
        throwBackgroundError: () => context.throwBackgroundError(controller),
        isPageClosed: () => controller.lifecycleState === "closed",
      });

      if (policySettle) {
        await policySettle(controller.pageRef, boundary.trigger);
      }
    }

    await context.flushPendingPageTasks(controller.sessionRef);
    if (controller.lifecycleState !== "closed") {
      await context.flushDomUpdateTask(controller);
    }

    return boundary;
  }

  return {
    captureSnapshot,
    installTracker,
    waitForPostLoadQuiet,
    settle,
  };
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

async function delayWithSignal(
  delayMs: number,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<void> {
  const effectiveDelay = Math.max(0, Math.min(delayMs, Math.max(0, deadline - Date.now())));
  if (effectiveDelay <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw signal.reason ?? abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, effectiveDelay);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isIgnorableTrackerReadError(error: unknown): boolean {
  return (
    isContextClosedError(error) ||
    (error instanceof Error &&
      /Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(
        error.message,
      ))
  );
}
