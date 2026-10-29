import type {
  ControlPlaneErrorCode,
  ControlPlaneErrorReason,
} from "@opensteer/control-plane-protocol";

const statusByCode: Readonly<Record<ControlPlaneErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  recent_sign_in_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_projection: 409,
  owned_deployments_exist: 409,
  unavailable: 503,
  internal: 500,
};

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly reason: ControlPlaneErrorReason | undefined;
  readonly status: number;

  constructor(
    code: ControlPlaneErrorCode,
    message: string,
    options?: ErrorOptions & { readonly reason?: ControlPlaneErrorReason },
  ) {
    super(message, options);
    this.name = "ControlPlaneError";
    this.code = code;
    this.reason = options?.reason;
    this.status = statusByCode[code];
  }
}
