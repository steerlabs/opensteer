import type { BrowserCapabilityPath } from "./capabilities.js";
import type { DocumentEpoch, DocumentRef, NodeRef, PageRef, SessionRef } from "./identity.js";

export type BrowserCoreErrorCode =
  | "invalid-argument"
  | "invalid-ref"
  | "not-found"
  | "unsupported-capability"
  | "stale-node-ref"
  | "session-closed"
  | "page-closed"
  | "frame-detached"
  | "timeout"
  | "navigation-failed"
  | "operation-failed";

export interface BrowserCoreErrorOptions {
  readonly cause?: unknown;
  readonly retriable?: boolean;
  readonly capability?: BrowserCapabilityPath;
  readonly details?: Record<string, unknown>;
}

export class BrowserCoreError extends Error {
  readonly code: BrowserCoreErrorCode;
  readonly retriable: boolean;
  readonly capability: BrowserCapabilityPath | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: BrowserCoreErrorCode, message: string, options: BrowserCoreErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "BrowserCoreError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.capability = options.capability;
    this.details = options.details;
  }
}

export function isBrowserCoreError(value: unknown): value is BrowserCoreError {
  return value instanceof BrowserCoreError;
}

export function createBrowserCoreError(
  code: BrowserCoreErrorCode,
  message: string,
  options: BrowserCoreErrorOptions = {},
): BrowserCoreError {
  return new BrowserCoreError(code, message, options);
}

export function unsupportedCapabilityError(capability: BrowserCapabilityPath): BrowserCoreError {
  return new BrowserCoreError(
    "unsupported-capability",
    `capability ${capability} is not supported by this backend`,
    {
      capability,
      details: { capability },
    },
  );
}

export function staleNodeRefError(input: {
  readonly nodeRef: NodeRef;
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
}): BrowserCoreError {
  return new BrowserCoreError(
    "stale-node-ref",
    `node ${input.nodeRef} is stale for ${input.documentRef} at epoch ${input.documentEpoch}`,
    {
      details: {
        nodeRef: input.nodeRef,
        documentRef: input.documentRef,
        documentEpoch: input.documentEpoch,
      },
    },
  );
}

export function closedSessionError(sessionRef: SessionRef): BrowserCoreError {
  return new BrowserCoreError("session-closed", `session ${sessionRef} is closed`, {
    details: { sessionRef },
  });
}

export function closedPageError(pageRef: PageRef): BrowserCoreError {
  return new BrowserCoreError("page-closed", `page ${pageRef} is closed`, {
    details: { pageRef },
  });
}
