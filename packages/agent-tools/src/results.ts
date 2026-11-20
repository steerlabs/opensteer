/** A refused or failed call, as its caller should read it. */
export interface AgentToolFailure {
  readonly computerId?: string | undefined;
  readonly capability?: "browser" | "apps" | "files" | undefined;
  readonly code: string;
  readonly message: string;
  /** What to do about it, naming the tool and parameter. */
  readonly next?: string | null | undefined;
  readonly reason?: string | undefined;
  readonly retryable?: boolean;
}

export {
  ToolErrorSchema,
  ToolFailureSchema,
  type ToolError,
  type ToolFailure,
} from "@opensteer/core";
import type { ToolError } from "@opensteer/core";
const legacyErrorCodes = new Map<string, string>([
  ["bad_request", "invalid_input"],
  ["validation", "invalid_input"],
  ["forbidden", "access_denied"],
  ["unauthorized", "access_denied"],
  ["internal", "internal_error"],
  ["runner_offline", "computer_offline"],
  ["device-offline", "computer_offline"],
  ["computer-offline", "computer_offline"],
  ["device-asleep", "computer_asleep"],
  ["computer-asleep", "computer_asleep"],
  ["device-stopped", "computer_stopped"],
  ["computer-stopped", "computer_stopped"],
  ["outcome-unknown", "outcome_unknown"],
]);
const classifiedErrorCodes = new Map<string, string>([
  ["device-offline", "computer_offline"],
  ["computer-offline", "computer_offline"],
  ["device-asleep", "computer_asleep"],
  ["computer-asleep", "computer_asleep"],
  ["device-stopped", "computer_stopped"],
  ["computer-stopped", "computer_stopped"],
  ["outcome-unknown", "outcome_unknown"],
  ["outcome_unknown", "outcome_unknown"],
  ["port_in_use", "port_in_use"],
  ["port-in-use", "port_in_use"],
  ["unsupported", "unsupported"],
]);
export function normalizeToolError(failure: AgentToolFailure): ToolError {
  const code =
    classifiedErrorCodes.get(failure.reason ?? "") ??
    legacyErrorCodes.get(failure.code) ??
    failure.code;
  let next = failure.next ?? null;
  if (failure.computerId && failure.capability && !next?.includes(failure.computerId)) {
    const target = `computerId=${failure.computerId}, access=${failure.capability}.`;
    next = `${target} ${
      next ??
      (failure.reason === "device-stopped"
        ? "Check computer_list; wait until the person resumes agents there and do not request access."
        : failure.reason === "device-asleep"
          ? "Check computer_list; wait until it wakes and do not request access."
          : failure.reason === "device-offline"
            ? "Check computer_list; do not request access while it is offline."
            : "Use computer_access_request if needed.")
    }`;
  }
  return {
    code: code.slice(0, 100) || "internal_error",
    message: failure.message.slice(0, 2000) || "Tool call failed.",
    next: next?.slice(0, 2000) ?? null,
  };
}
/** Both MCP result channels carry exactly the same failure. */
export function agentToolFailureResult(failure: AgentToolFailure) {
  const result = { error: normalizeToolError(failure) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

export function agentToolRecordResult(result: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.isError === true ? { isError: true } : {}),
  };
}
