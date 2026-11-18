import { failureProvenance, type ClientFailureProvenance } from "../connections/operation-error.js";
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
          readonly provenance?: ClientFailureProvenance | undefined;
        };
      },
): T {
  if (result.ok) return result.data;
  throw new TeamRpcError({
    code: result.error.code,
    message: result.error.message,
    ...(result.error.provenance ? { provenance: result.error.provenance } : {}),
    ...(result.error.reason === undefined ? {} : { reason: result.error.reason }),
    ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
  });
}

class TeamRpcError extends OpensteerError {
  readonly provenance: ClientFailureProvenance;
  constructor(
    options: ConstructorParameters<typeof OpensteerError>[0] & {
      readonly provenance?: ClientFailureProvenance;
    },
  ) {
    super(options);
    this.provenance = options.provenance ?? failureProvenance(options.reason ?? "", null, true);
  }
}
