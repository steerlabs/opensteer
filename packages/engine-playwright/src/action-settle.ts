import {
  CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS,
  buildPostLoadTrackerInstallScript,
  buildPostLoadTrackerReadExpression,
  normalizePostLoadTrackerState,
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

interface PlaywrightActionSettlerContext {
  flushPendingPageTasks(sessionRef: PageController["sessionRef"]): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  getMainFrameDocumentRef(controller: PageController): DocumentRef | undefined;
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

    await installTracker(controller);
    await context.flushPendingPageTasks(controller.sessionRef);

    if (policySettle && snapshot === undefined) {
      if (signal?.aborted) {
        throw signal.reason ?? abortError();
      }
      await policySettle(controller.pageRef, "dom-action");
    }

    const boundary = await waitForActionBoundary({
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(snapshot === undefined ? {} : { snapshot }),
      getCurrentMainFrameDocumentRef: () => context.getMainFrameDocumentRef(controller),
      waitForNavigationContentLoaded: async (remainingMs) => {
        try {
          await controller.page.waitForLoadState("domcontentloaded", {
            timeout: remainingMs,
          });
        } catch (error) {
          if (controller.lifecycleState === "closed" || isContextClosedError(error)) {
            return;
          }
          throw normalizePlaywrightError(error, controller.pageRef);
        }
      },
      readTrackerState: () => readTrackerState(controller),
      throwBackgroundError: () => context.throwBackgroundError(controller),
      isPageClosed: () => controller.lifecycleState === "closed",
    });

    if (policySettle && snapshot !== undefined) {
      await policySettle(controller.pageRef, boundary.trigger);
    }

    await context.flushPendingPageTasks(controller.sessionRef);
    if (controller.lifecycleState !== "closed") {
      await context.flushDomUpdateTask(controller);
    }

    return boundary;
  }

  return {
    installTracker,
    settle,
  };
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
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
