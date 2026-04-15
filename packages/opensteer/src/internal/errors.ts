import { isBrowserCoreError } from "@opensteer/browser-core";
import {
  createOpensteerError,
  isOpensteerProtocolError,
  toOpensteerError,
  type OpensteerError,
} from "@opensteer/protocol";
import { OpensteerAttachAmbiguousError } from "../local-browser/cdp-discovery.js";

export function normalizeThrownOpensteerError(
  error: unknown,
  fallbackMessage: string,
): OpensteerError {
  if (isOpensteerProtocolError(error)) {
    return toOpensteerError(error);
  }

  if (isBrowserCoreError(error)) {
    return createOpensteerError(error.code, error.message, {
      retriable: error.retriable,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }

  if (error instanceof OpensteerAttachAmbiguousError) {
    return createOpensteerError("conflict", error.message, {
      details: {
        candidates: error.candidates,
        code: error.code,
        name: error.name,
      },
    });
  }

  if (
    error instanceof Error &&
    "opensteerError" in error &&
    typeof (error as { opensteerError: unknown }).opensteerError === "object" &&
    (error as { opensteerError: unknown }).opensteerError !== null
  ) {
    const oe = (error as { opensteerError: OpensteerError }).opensteerError;
    return createOpensteerError(oe.code, oe.message, {
      retriable: oe.retriable,
      ...(oe.capability === undefined ? {} : { capability: oe.capability }),
      ...(oe.details === undefined ? {} : { details: oe.details }),
    });
  }

  if (error instanceof Error) {
    return createOpensteerError("operation-failed", error.message, {
      details: {
        name: error.name,
      },
    });
  }

  return createOpensteerError("internal", fallbackMessage, {
    details: {
      value: error,
    },
  });
}
