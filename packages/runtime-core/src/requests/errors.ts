import { OpensteerProtocolError } from "@opensteer/protocol";

import type { RequestPlanRecord } from "../registry.js";

function requestPlanDetails(
  plan: Pick<RequestPlanRecord, "key" | "version">,
  details: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    key: plan.key,
    version: plan.version,
    kind: "request-plan",
    ...details,
  };
}

export function invalidRequestPlanError(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): OpensteerProtocolError {
  return new OpensteerProtocolError("invalid-request", message, {
    details,
  });
}

export function requestPlanNotFoundError(
  key: string,
  version: string | undefined,
): OpensteerProtocolError {
  return new OpensteerProtocolError(
    "not-found",
    version === undefined
      ? `request plan ${key} was not found`
      : `request plan ${key}@${version} was not found`,
    {
      details: {
        key,
        ...(version === undefined ? {} : { version }),
        kind: "request-plan",
      },
    },
  );
}

export function unsupportedRequestPlanTransportError(
  plan: RequestPlanRecord,
): OpensteerProtocolError {
  return new OpensteerProtocolError(
    "unsupported-operation",
    `request plan ${plan.key}@${plan.version} uses unsupported transport ${plan.payload.transport.kind}`,
    {
      details: requestPlanDetails(plan, {
        transport: plan.payload.transport.kind,
        operation: "request.execute",
      }),
    },
  );
}

export function invalidRequestExecutionError(
  plan: RequestPlanRecord,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): OpensteerProtocolError {
  return new OpensteerProtocolError("invalid-request", message, {
    details: requestPlanDetails(plan, details),
  });
}

export function requestPlanExpectationConflictError(
  plan: RequestPlanRecord,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): OpensteerProtocolError {
  return new OpensteerProtocolError("conflict", message, {
    details: requestPlanDetails(plan, details),
  });
}
