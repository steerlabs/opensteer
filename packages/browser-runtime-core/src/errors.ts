import type { ProtocolError } from "@opensteer/protocol";

export type BrowserRuntimeErrorCode = ProtocolError["code"];

export class BrowserRuntimeError extends Error {
  readonly code: BrowserRuntimeErrorCode;
  readonly retryable: boolean;
  readonly reason: string | undefined;
  /** A7: refused before the command reached the page: nothing happened. */
  readonly unsent: boolean;

  constructor(
    code: BrowserRuntimeErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; reason?: string; unsent?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.reason = options.reason;
    this.unsent = options.unsent === true;
  }

  toProtocolError(): ProtocolError {
    return {
      code: this.code,
      message: this.message.slice(0, 2_000),
      retryable: this.retryable,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.unsent ? { unsent: true as const } : {}),
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
