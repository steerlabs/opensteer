import {
  createBrowserCoreError,
  isBrowserCoreError,
  staleNodeRefError,
  type NodeLocator,
  type PageRef,
} from "@opensteer/browser-core";
import { errors as playwrightErrors } from "playwright";
import type { DocumentState, PageController } from "./types.js";

export function unsupportedCursorCapture(): never {
  throw createBrowserCoreError(
    "unsupported-capability",
    "capturing the cursor in screenshots is not supported by this backend",
  );
}

export function normalizePlaywrightError(error: unknown, pageRef: PageRef): Error {
  if (isBrowserCoreError(error)) {
    return error;
  }
  if (error instanceof playwrightErrors.TimeoutError) {
    return createBrowserCoreError("timeout", error.message, { cause: error });
  }
  if (error instanceof Error && /Navigation failed/i.test(error.message)) {
    return createBrowserCoreError("navigation-failed", error.message, {
      cause: error,
      details: { pageRef },
    });
  }
  if (error instanceof Error) {
    return createBrowserCoreError("operation-failed", error.message, {
      cause: error,
      details: { pageRef },
    });
  }
  return createBrowserCoreError("operation-failed", "Playwright operation failed", {
    cause: error,
    details: { pageRef },
  });
}

export function isContextClosedError(error: unknown): boolean {
  return (
    error instanceof Error && /Target page, context or browser has been closed/i.test(error.message)
  );
}

export function shouldIgnoreBackgroundTaskError(
  controller: PageController,
  error: unknown,
): boolean {
  return controller.lifecycleState === "closed" || isContextClosedError(error);
}

export function isNodeLookupFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /No node with given id found|Could not find node with given id|Cannot find context/i.test(
    error.message,
  );
}

export function rethrowNodeLookupError(
  error: unknown,
  document: DocumentState,
  input: NodeLocator,
): never {
  if (isNodeLookupFailure(error)) {
    throw staleNodeRefError({
      documentRef: document.documentRef,
      documentEpoch: input.documentEpoch,
      nodeRef: input.nodeRef,
    });
  }
  throw error;
}
