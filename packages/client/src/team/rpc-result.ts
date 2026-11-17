import { OpensteerError, type OpensteerErrorCode } from "@opensteer/core";

export function teamRpcResult<T>(
  result:
    | { readonly ok: true; readonly data: T }
    | {
        readonly ok: false;
        readonly error: {
          readonly message: string;
          readonly code: OpensteerErrorCode;
          readonly retryable?: boolean | undefined;
          readonly reason?: string | undefined;
        };
      },
): T {
  if (result.ok) return result.data;
  throw new OpensteerError({
    code: result.error.code,
    message: result.error.message,
    ...(result.error.reason === undefined ? {} : { reason: result.error.reason }),
    ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
  });
}
