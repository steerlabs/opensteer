import { OpensteerError, type OpensteerErrorCode } from "@opensteer/core";

export function teamRpcResult<T>(
  result:
    | { readonly ok: true; readonly data: T }
    | {
        readonly ok: false;
        readonly error: {
          readonly message: string;
          readonly code: OpensteerErrorCode;
          readonly retryable?: boolean;
        };
      },
): T {
  if (result.ok) return result.data;
  throw new OpensteerError(result.error);
}
