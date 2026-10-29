import { ClientOperationError } from "./operation-error.js";

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

/** The observing boundary classifies a failure; IPC carries only its code. */
export class HostTransportError extends ClientOperationError {
  readonly code: HostTransportErrorCode;
  readonly retryable: boolean;

  constructor(code: HostTransportErrorCode, options?: ErrorOptions) {
    const detail = details[code];
    super(detail.message, detail.retryable ? "transient" : "blocked", options);
    this.name = code === "cancelled" ? "AbortError" : "HostTransportError";
    this.code = code;
    this.retryable = detail.retryable;
  }
}
