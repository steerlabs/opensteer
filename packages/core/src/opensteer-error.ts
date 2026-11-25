import type { OpensteerErrorCode } from "./errors.js";

/** Text and a recovery written for the reader, as `throw refused(...)`. */
export function refused(code: OpensteerErrorCode, message: string, next?: string): OpensteerError {
  return new OpensteerError({ code, message, ...(next === undefined ? {} : { next }) });
}

export class OpensteerError extends Error {
  readonly code: OpensteerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * Stable machine-readable discriminator within one `code`. Clients branch on
   * it instead of matching prose, so a wording change is never a behaviour
   * change. It is optional: only errors a client must tell apart carry one.
   */
  readonly reason: string | undefined;
  /**
   * What an agent should do next, naming its tool and parameter. Agents read
   * it after `message`. People read only `message`, so a refusal they can also
   * meet keeps tool names here.
   */
  readonly next: string | undefined;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: OpensteerErrorCode;
    readonly message: string;
    readonly next?: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "OpensteerError";
    this.code = options.code;
    this.reason = options.reason;
    this.next = options.next;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
