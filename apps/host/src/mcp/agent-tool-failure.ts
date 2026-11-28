import { DeviceRefusalContextSchema } from "@opensteer/protocol";
import type { AgentToolAccess, AgentToolFailure } from "@opensteer/agent-tools";
import { ToolBlockedError, OpensteerError } from "@opensteer/core";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { z } from "zod";
import { OperationOutcomeUnknown } from "../agent-sessions/agent-session-service.js";
import { BrowserCdpConnectionEnded } from "../browser/browser-service.js";
import { ComputerMcpSessionError } from "../computer-apps/computer-app-hub.js";
import { ComputerUseError } from "../computer-use/computer-use-service.js";
import { IntegrationAuthorizationRequiredError } from "../devices/integration-authorization-required.js";
import { PluginServiceError } from "../plugins/plugin-service.js";

export const internalToolFailureCode = "internal";
const hiddenTargetRefusals = new Set([
  "Task is unavailable",
  "Parent task is unavailable",
  "Item is unavailable in this task",
  "Item is unavailable in this subagent",
  "Plugin tool is unavailable to this caller.",
  "This tab is unavailable to this connected agent.",
  "This resource is not shared with this connected agent.",
  "That browser profile is not shared with this connected agent.",
  "A connected agent works only in a browser profile shared with it, never in a Guest tab.",
]);

/**
 * Only text written for the caller reaches it. Anything else could carry a
 * query, a path or a provider's response, so it is logged instead. Whether a
 * retry is safe follows the tool: the Host never repeats an uncertain effect.
 */
export function agentToolFailure(
  error: unknown,
  access: AgentToolAccess,
  /** Which Devices this caller may learn of; a caller nobody vouched for learns none. */
  mayKnowDevice?: (deviceId: string) => boolean,
  /**
   * The caller acts under a connection's grant: the connection itself, or a Run in its lineage.
   * Every such caller is refused alike, here and nowhere else (rule 5, AD11).
   */
  connection = false,
): AgentToolFailure {
  if (error instanceof OperationOutcomeUnknown)
    return {
      code: "outcome_unknown",
      message: error.message,
      next: "Observe before repeating an effectful call.",
      retryable: false,
    };
  if (error instanceof ToolBlockedError) return error.blocked;
  if (error instanceof PluginServiceError)
    return {
      code:
        error.code === "forbidden"
          ? connection
            ? "not_found"
            : "access_denied"
          : error.code === "interrupted"
            ? "outcome_unknown"
            : "plugin_unavailable",
      message:
        error.code === "forbidden"
          ? "Plugin operation is unavailable to this caller."
          : error.code === "interrupted"
            ? error.tag === "engine-killed"
              ? "The plugin engine was killed before it replied."
              : "Plugin engine stopped; the program was interrupted."
            : ["invalid", "consent-changed", "unavailable"].includes(error.code)
              ? error.message
              : "Plugin operation could not complete.",
      next:
        error.code === "forbidden"
          ? "Continue with the access currently available; the person controls plugin access."
          : "Earlier calls may have taken effect. Check current state with a safe read before starting new work; never repeat a write or program blindly.",
      retryable: false,
    };
  if (error instanceof Error && error.name === "AbortError")
    return {
      code: "outcome_unknown",
      message: "The tool call was cancelled; its outcome is unknown.",
      next: "Observe before repeating an effectful call.",
    };
  if (error instanceof z.ZodError) {
    return {
      code: "bad_request",
      message: `invalid_arguments: ${formatIssues(error.issues)}`,
      retryable: false,
    };
  }
  // Outside the grant reads exactly like something that does not exist, for every caller under a
  // connection's grant: the same code, the same words, no reason and no advice (AD11).
  if (
    connection &&
    error instanceof OpensteerError &&
    (error.code === "forbidden" || error.code === "not_found") &&
    hiddenTargetRefusals.has(error.message)
  )
    return { code: "not_found", message: error.message, retryable: false };
  if (error instanceof OpensteerError && error.code !== "internal") {
    const device =
      error.reason === "device-access-off" ||
      error.reason === "device-offline" ||
      error.reason === "device-asleep" ||
      error.reason === "device-stopped"
        ? DeviceRefusalContextSchema.safeParse(error.details).data
        : undefined;
    const visible = device && (mayKnowDevice?.(device.machineId) ?? true);
    const named =
      device?.machineName &&
      (error.reason === "device-asleep" || error.reason === "device-stopped") &&
      mayKnowDevice?.(device.machineId)
        ? { device: { id: device.machineId, name: device.machineName } }
        : {};
    return {
      ...(visible ? { computerId: device.machineId, capability: device.capability } : {}),
      ...named,
      code: error.code,
      message: error.message,
      next: error.next,
      reason:
        connection && error.code === "forbidden" && hiddenTargetRefusals.has(error.message)
          ? "target-unavailable"
          : error.reason,
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
  if (error instanceof BrowserCdpConnectionEnded) {
    if (
      error.message === "The browser task ended." ||
      error.message === "This task's browser access has ended."
    ) {
      return {
        code: "forbidden",
        message: "Run tool authority has ended",
        retryable: false,
      };
    }
    if (error.message === "This device's browser access was turned off.") {
      return { code: "forbidden", message: error.message, retryable: false };
    }
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
