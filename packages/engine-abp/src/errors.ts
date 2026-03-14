import {
  createBrowserCoreError,
  isBrowserCoreError,
  staleNodeRefError,
  type NodeLocator,
  type PageRef,
} from "@opensteer/browser-core";

import type { DocumentState } from "./types.js";

export class AbpApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "AbpApiError";
    this.status = status;
    this.body = body;
  }
}

export function normalizeAbpError(error: unknown, pageRef?: PageRef): Error {
  if (isBrowserCoreError(error)) {
    return error;
  }

  if (error instanceof AbpApiError) {
    if (error.status === 408 || error.status === 504) {
      return createBrowserCoreError("timeout", error.message, {
        cause: error,
        ...(pageRef === undefined ? {} : { details: { pageRef } }),
      });
    }

    if (error.status === 404 && pageRef !== undefined) {
      return createBrowserCoreError("page-closed", `page ${pageRef} is closed`, {
        cause: error,
        details: { pageRef },
      });
    }

    return createBrowserCoreError("operation-failed", error.message, {
      cause: error,
      ...(pageRef === undefined ? {} : { details: { pageRef } }),
    });
  }

  if (error instanceof Error) {
    if (/timed out/i.test(error.message)) {
      return createBrowserCoreError("timeout", error.message, {
        cause: error,
        ...(pageRef === undefined ? {} : { details: { pageRef } }),
      });
    }

    return createBrowserCoreError("operation-failed", error.message, {
      cause: error,
      ...(pageRef === undefined ? {} : { details: { pageRef } }),
    });
  }

  return createBrowserCoreError("operation-failed", "ABP operation failed", {
    cause: error,
    ...(pageRef === undefined ? {} : { details: { pageRef } }),
  });
}

export function isActionTimeoutError(error: unknown): boolean {
  return error instanceof AbpApiError && error.status === 504;
}

export function isPageClosedApiError(error: unknown): boolean {
  return error instanceof AbpApiError && error.status === 404;
}

export function rethrowNodeLookupError(
  error: unknown,
  document: DocumentState,
  input: NodeLocator,
): never {
  if (error instanceof AbpApiError && error.status === 404) {
    throw staleNodeRefError({
      documentRef: document.documentRef,
      documentEpoch: input.documentEpoch,
      nodeRef: input.nodeRef,
    });
  }

  if (
    error instanceof Error &&
    /No node with given id found|Could not find node with given id|Cannot find context/i.test(
      error.message,
    )
  ) {
    throw staleNodeRefError({
      documentRef: document.documentRef,
      documentEpoch: input.documentEpoch,
      nodeRef: input.nodeRef,
    });
  }

  throw error;
}
