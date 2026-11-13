import { DeviceRefusalContextSchema } from "@opensteer/protocol";
import type { AgentToolAccess, AgentToolFailure } from "@opensteer/agent-tools";
import { OpensteerError } from "@opensteer/core";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { z } from "zod";
import { ComputerMcpSessionError } from "../computer-apps/computer-app-hub.js";
import { ComputerUseError } from "../computer-use/computer-use-service.js";
import { IntegrationAuthorizationRequiredError } from "../integrations/integration-platform-service.js";

export const internalToolFailureCode = "internal";

/**
 * Only text written for the caller reaches it. Anything else could carry a
 * query, a path or a provider's response, so it is logged instead. Whether a
 * retry is safe follows the tool: the Host never repeats an uncertain effect.
 */
export function agentToolFailure(error: unknown, access: AgentToolAccess): AgentToolFailure {
  if (error instanceof z.ZodError) {
    return {
      code: "bad_request",
      message: `invalid_arguments: ${formatIssues(error.issues)}`,
      retryable: false,
    };
  }
  if (error instanceof OpensteerError && error.code !== "internal") {
    const device =
      error.reason === "device-access-off" || error.reason === "device-offline"
        ? DeviceRefusalContextSchema.safeParse(error.details).data
        : undefined;
    return {
      ...device,
      code: error.code,
      message: error.message,
      next: error.next,
      reason: error.reason,
      retryable: error.retryable,
    };
  }
  if (error instanceof ComputerUseError) {
    return { code: "conflict", message: error.message, retryable: error.retryable };
  }
  if (
    error instanceof ComputerMcpSessionError ||
    error instanceof IntegrationAuthorizationRequiredError
  ) {
    return { code: "conflict", message: error.message, retryable: false };
  }
  return {
    code: internalToolFailureCode,
    message: "Opensteer hit an internal error.",
    next:
      access === "read"
        ? "Try once more, and if it fails again, tell the person."
        : "It may have taken effect, so check before retrying.",
    retryable: false,
  };
}
