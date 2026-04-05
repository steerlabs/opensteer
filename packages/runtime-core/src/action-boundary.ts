import type {
  ActionBoundaryOutcome,
  ActionBoundarySnapshot,
  ActionBoundaryTimedOutPhase,
  BrowserCoreEngine,
  PageRef,
} from "@opensteer/browser-core";
import { isOpensteerProtocolError } from "@opensteer/protocol";

export interface ActionBoundaryDiagnostics {
  readonly trigger: ActionBoundaryOutcome["trigger"];
  readonly crossDocument: boolean;
  readonly bootstrapSettled: boolean;
  readonly visualSettled: boolean;
  readonly timedOutPhase?: ActionBoundaryTimedOutPhase | "visual";
}

const actionBoundaryDiagnosticsBySignal = new WeakMap<AbortSignal, ActionBoundaryDiagnostics>();

export async function captureActionBoundarySnapshot(
  engine: BrowserCoreEngine,
  pageRef: PageRef,
): Promise<ActionBoundarySnapshot> {
  const frames = await engine.listFrames({ pageRef });
  const mainFrame = frames.find((frame) => frame.isMainFrame);
  if (!mainFrame) {
    throw new Error(`page ${pageRef} does not expose a main frame`);
  }

  return {
    pageRef,
    documentRef: mainFrame.documentRef,
    url: mainFrame.url,
  };
}

export function createActionBoundaryDiagnostics(input: {
  readonly boundary: ActionBoundaryOutcome;
  readonly visualSettled: boolean;
}): ActionBoundaryDiagnostics {
  return {
    trigger: input.boundary.trigger,
    crossDocument: input.boundary.crossDocument,
    bootstrapSettled: input.boundary.bootstrapSettled,
    visualSettled: input.visualSettled,
    ...(input.boundary.timedOutPhase !== undefined
      ? { timedOutPhase: input.boundary.timedOutPhase }
      : !input.visualSettled
        ? { timedOutPhase: "visual" as const }
        : {}),
  };
}

export function recordActionBoundaryDiagnostics(
  signal: AbortSignal,
  diagnostics: ActionBoundaryDiagnostics,
): void {
  actionBoundaryDiagnosticsBySignal.set(signal, diagnostics);
}

export function takeActionBoundaryDiagnostics(
  signal: AbortSignal,
): ActionBoundaryDiagnostics | undefined {
  const diagnostics = actionBoundaryDiagnosticsBySignal.get(signal);
  actionBoundaryDiagnosticsBySignal.delete(signal);
  return diagnostics;
}

export function isSoftSettleTimeoutError(error: unknown, signal?: AbortSignal): boolean {
  if (isTimeoutError(error)) {
    return true;
  }

  return (
    signal?.aborted === true &&
    isTimeoutError(signal.reason) &&
    (error === signal.reason || isAbortError(error))
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return isOpensteerProtocolError(error) && error.code === "timeout";
}
