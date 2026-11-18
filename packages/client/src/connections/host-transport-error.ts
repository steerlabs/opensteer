import { ClientOperationError, type ClientFailureOptions } from "./operation-error.js";

export type HostTransportErrorCode =
  "response-too-large" | "timed-out" | "deployment-changed" | "cancelled" | "unreachable";

const details = {
  "response-too-large": {
    message:
      "The Host's answer was larger than this app accepts. Ask the deployment administrator to reduce the response size.",
    retryable: false,
  },
  "timed-out": {
    message: "The Host did not finish answering in time. Try again.",
    retryable: true,
  },
  "deployment-changed": {
    message:
      "The selected deployment changed during this request. Try again on the selected deployment.",
    retryable: false,
  },
  cancelled: { message: "The Host request was cancelled.", retryable: false },
  unreachable: {
    message:
      "The Host could not be reached. Check your connection and that the deployment is running, then try again.",
    retryable: true,
  },
} as const;

/** A gateway can answer for an unreachable Host, including Connect's tunnel (530). */
export function isGatewayFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 530;
}

/** The request pool is full and the request was never sent. */
export class HostCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostCapacityError";
  }
}

/** The legacy code remains available when a peer cannot carry the observed failure. */
export class HostTransportError extends ClientOperationError {
  readonly code: HostTransportErrorCode;
  readonly retryable: boolean;

  constructor(code: HostTransportErrorCode, options?: ClientFailureOptions) {
    const detail = details[code];
    super(detail.message, (options?.retryable ?? detail.retryable) ? "transient" : "blocked", {
      code,
      reason: code,
      retryable: detail.retryable,
      provenance: code === "response-too-large" ? "protocol" : "transport",
      kind:
        code === "cancelled" || code === "deployment-changed"
          ? "cancelled"
          : code === "response-too-large"
            ? "protocol"
            : "transport",
      ...options,
    });
    this.name = code === "cancelled" ? "AbortError" : "HostTransportError";
    this.code = code;
    this.retryable = options?.retryable ?? detail.retryable;
  }
}
