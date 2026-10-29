import type { ProtocolError } from "@opensteer/protocol";

export type BrowserRuntimeErrorCode = ProtocolError["code"];

export class BrowserRuntimeError extends Error {
  readonly code: BrowserRuntimeErrorCode;
  readonly retryable: boolean;
  readonly reason: string | undefined;

  constructor(
    code: BrowserRuntimeErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; reason?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.reason = options.reason;
  }

  toProtocolError(): ProtocolError {
    return {
      code: this.code,
      message: this.message.slice(0, 2_000),
      retryable: this.retryable,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}

export function toBrowserRuntimeError(error: unknown): BrowserRuntimeError {
  if (error instanceof BrowserRuntimeError) return error;
  return new BrowserRuntimeError(
    "internal",
    "The browser runtime could not complete the command.",
    {
      cause: error,
    },
  );
}
