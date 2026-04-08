import {
  CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS,
  capturePostLoadTrackerSnapshot,
  buildPostLoadTrackerBeginExpression,
  buildPostLoadTrackerFreezeExpression,
  buildPostLoadTrackerInstallScript,
  buildPostLoadTrackerReadExpression,
  DEFAULT_POST_LOAD_TRACKER_QUIET_WINDOW_MS,
  normalizePostLoadTrackerState,
  postLoadTrackerIsSettled,
  waitForActionBoundary,
  type ActionBoundaryOutcome,
  type ActionBoundarySettleTrigger,
  type ActionBoundarySnapshot,
  type DocumentRef,
  type PageRef,
} from "@opensteer/browser-core";

import type { PageController } from "./types.js";

export const DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS = CROSS_DOCUMENT_INTERACTION_TIMEOUT_MS;
export const DEFAULT_ABP_POST_LOAD_CAPTURE_WINDOW_MS = 1_000;

interface AbpActionSettlerContext {
  syncExecutionPaused(controller: PageController): Promise<boolean>;
  setExecutionPaused(controller: PageController, paused: boolean): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  getMainFrameDocumentRef(controller: PageController): DocumentRef | undefined;
  isCurrentMainFrameBootstrapSettled(controller: PageController): boolean;
  throwBackgroundError(controller: PageController): void;
  isPageClosedError(error: unknown): boolean;
}

export interface AbpActionSettleOptions {
  readonly controller: PageController;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly snapshot?: ActionBoundarySnapshot;
  readonly policySettle?: (pageRef: PageRef, trigger: ActionBoundarySettleTrigger) => Promise<void>;
}

export type AbpActionBoundaryOptions = Omit<AbpActionSettleOptions, "controller">;

export function clampAbpActionSettleTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS;
  }
  return Math.max(0, Math.min(DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS, timeoutMs));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function createAbpActionSettler(context: AbpActionSettlerContext) {
  const installScript = buildPostLoadTrackerInstallScript();
  const beginExpression = buildPostLoadTrackerBeginExpression();
  const freezeExpression = buildPostLoadTrackerFreezeExpression();
  const readExpression = buildPostLoadTrackerReadExpression();

  async function installTracker(controller: PageController): Promise<void> {
    if (!controller.settleTrackerRegistered) {
      await controller.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: installScript,
      });
      controller.settleTrackerRegistered = true;
    }

    await controller.cdp.send<{
      readonly result?: {
        readonly value?: unknown;
      };
    }>("Runtime.evaluate", {
      expression: installScript,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async function readTrackerState(controller: PageController) {
    try {
      const evaluated = await controller.cdp.send<{
        readonly result?: {
          readonly value?: unknown;
        };
      }>("Runtime.evaluate", {
        expression: readExpression,
        returnByValue: true,
        awaitPromise: true,
      });

      return normalizePostLoadTrackerState(evaluated.result?.value);
    } catch (error) {
      if (context.isPageClosedError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async function beginTrackerObservation(controller: PageController): Promise<void> {
    await installTracker(controller);
    await controller.cdp.send("Runtime.evaluate", {
      expression: beginExpression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async function freezeTrackerObservation(controller: PageController): Promise<void> {
    await controller.cdp.send("Runtime.evaluate", {
      expression: freezeExpression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async function captureSnapshot(controller: PageController): Promise<ActionBoundarySnapshot> {
    const documentRef = context.getMainFrameDocumentRef(controller);
    if (documentRef === undefined) {
      throw new Error(`page ${controller.pageRef} does not expose a main frame`);
    }
    await beginTrackerObservation(controller);
    const tracker = await readTrackerState(controller);
    const mainFrameUrl =
      controller.mainFrameRef === undefined
        ? undefined
        : controller.framesByCdpId.get(controller.mainFrameRef)?.currentDocument.url;
    return {
      pageRef: controller.pageRef,
      documentRef,
      ...(mainFrameUrl === undefined ? {} : { url: mainFrameUrl }),
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
      Math.min(input.captureWindowMs ?? DEFAULT_ABP_POST_LOAD_CAPTURE_WINDOW_MS, timeoutMs),
    );
    const deadline = Date.now() + timeoutMs;
    await installTracker(controller);
    if (captureWindowMs > 0) {
      await delayWithSignal(captureWindowMs, signal, deadline);
    }
    await freezeTrackerObservation(controller);

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw abortError(signal);
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

  async function settle(options: AbpActionSettleOptions): Promise<ActionBoundaryOutcome> {
    const { controller, timeoutMs, signal, snapshot, policySettle } = options;
    if (timeoutMs <= 0) {
      return {
        trigger: "dom-action",
        crossDocument: false,
        bootstrapSettled: false,
        timedOutPhase: "bootstrap",
      };
    }

    const wasPaused = await context.syncExecutionPaused(controller);
    let boundary: ActionBoundaryOutcome = {
      trigger: "dom-action",
      crossDocument: false,
      bootstrapSettled: false,
      timedOutPhase: "bootstrap",
    };
    if (wasPaused) {
      await context.setExecutionPaused(controller, false);
    }

    try {
      if (snapshot === undefined) {
        if (policySettle) {
          if (signal?.aborted) {
            throw abortError(signal);
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
          getCurrentPageUrl: () =>
            controller.mainFrameRef === undefined
              ? undefined
              : controller.framesByCdpId.get(controller.mainFrameRef)?.currentDocument.url,
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
    } finally {
      if (wasPaused && controller.lifecycleState !== "closed") {
        try {
          await context.setExecutionPaused(controller, true);
        } catch (error) {
          if (!context.isPageClosedError(error)) {
            throw error;
          }
        }
      }

      if (controller.lifecycleState !== "closed") {
        try {
          await context.flushDomUpdateTask(controller);
        } catch (error) {
          if (!context.isPageClosedError(error)) {
            throw error;
          }
        }
      }
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
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, effectiveDelay);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
