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
  /** The Device an asleep or stopped refusal is about, when the caller may know it. */
  readonly device?: { readonly id: string; readonly name: string } | undefined;
}

export {
  ToolErrorSchema,
  ToolFailureSchema,
  type ToolError,
  type ToolFailure,
} from "@opensteer/core";
import type { ToolError, ToolFailureReceipt } from "@opensteer/core";
import { agentTools } from "./tools/index.js";
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
const connectionErrorCodes = new Map([
  ["person-declined", "declined_by_person"],
  ["agent-session-stopped", "stopped_by_person"],
  ["authority-changed", "access_changed"],
  ["work-policy", "organization_not_allowed"],
  ["target-unavailable", "not_found"],
]);
const toolNames = new Set<string>(agentTools.map(({ name }) => name));
type ConnectionFailureContext = {
  readonly tools: ReadonlySet<string>;
  readonly notFoundMessage?: string;
};

/** Whether text names a tool of the catalog that this connection is not offered. */
export function namesUnofferedTool(text: string, offered: ReadonlySet<string>): boolean {
  return (
    text
      .match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu)
      ?.some((name) => toolNames.has(name) && !offered.has(name)) ?? false
  );
}

/**
 * The one rule for text a connected agent reads that Opensteer wrote for its own agents: a
 * sentence naming a tool this connection is not offered is left out. Empty when none is left.
 */
export function withoutUnofferedTools(text: string, offered: ReadonlySet<string>): string {
  if (!namesUnofferedTool(text, offered)) return text;
  return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/gu) ?? [])
    .filter((sentence) => !namesUnofferedTool(sentence, offered))
    .join("")
    .trim();
}

const continueWithShared =
  "Continue with what is shared with you, or tell the person what you need.";

/** A refusal object Opensteer wrote: `{ code, message, next }` and nothing else. */
function isRefusal(
  value: unknown,
): value is { code: string; message: string; next: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  const entry = value as Record<string, unknown>;
  return (
    keys === "code,message,next" &&
    typeof entry.code === "string" &&
    typeof entry.message === "string" &&
    (typeof entry.next === "string" || entry.next === null)
  );
}

/**
 * A connected agent's successful result, with the same rule applied to what Opensteer wrote in
 * it: a top-level `next`, and each `blocked` note or refusal-shaped `error` of a listed item or
 * plugin call. Other values, page, app and plugin text among them, are left exactly as they are.
 */
export function withoutUnofferedGuidance<Value>(value: Value, offered: ReadonlySet<string>): Value {
  const refusal = (entry: { code: string; message: string; next: string | null }) => ({
    ...entry,
    message: withoutUnofferedTools(entry.message, offered) || "This is unavailable now.",
    next:
      entry.next === null ? null : withoutUnofferedTools(entry.next, offered) || continueWithShared,
  });
  // Only containers Opensteer itself builds are entered; a plugin call's own `value` never is.
  const containers = new Set(["items", "item", "calls", "results", "result", "execution"]);
  const visit = (entry: unknown, key?: string): unknown => {
    if (Array.isArray(entry)) return entry.map((item) => visit(item, key));
    if (!entry || typeof entry !== "object") return entry;
    if ((key === "blocked" || key === "error") && isRefusal(entry)) return refusal(entry);
    return Object.fromEntries(
      Object.entries(entry).map(([name, item]) => [
        name,
        containers.has(name) ||
        name === "blocked" ||
        name === "error" ||
        (name === "value" && key === "execution")
          ? visit(item, name)
          : item,
      ]),
    );
  };
  const visited = visit(value) as Record<string, unknown>;
  return (
    visited && typeof visited === "object" && typeof visited.next === "string"
      ? { ...visited, next: withoutUnofferedTools(visited.next, offered) || continueWithShared }
      : visited
  ) as Value;
}

export function normalizeToolError(
  failure: AgentToolFailure,
  connection?: ConnectionFailureContext,
): ToolError {
  const code =
    (connection ? connectionErrorCodes.get(failure.reason ?? "") : undefined) ??
    classifiedErrorCodes.get(failure.reason ?? "") ??
    legacyErrorCodes.get(failure.code) ??
    failure.code;
  let next = connection && code === "not_found" ? null : (failure.next ?? null);
  if (
    connection &&
    next
      ?.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu)
      ?.some((name) => toolNames.has(name) && !connection.tools.has(name))
  )
    next = null;
  if (failure.computerId && failure.capability && !next?.includes(failure.computerId)) {
    const target = `computerId=${failure.computerId}, access=${failure.capability}.`;
    next = `${target} ${
      next ??
      (connection
        ? "Check the device's current state or tell the person what is unavailable."
        : failure.reason === "device-stopped"
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
    message:
      connection && code === "not_found"
        ? (connection.notFoundMessage ?? "That item is unavailable.")
        : (connection
            ? withoutUnofferedTools(failure.message, connection.tools)
            : failure.message
          ).slice(0, 2000) || "Tool call failed.",
    next: next?.slice(0, 2000) ?? null,
    ...(failure.device && (code === "computer_asleep" || code === "computer_stopped")
      ? { device: { id: failure.device.id, name: failure.device.name.slice(0, 200) } }
      : {}),
  };
}
/** Both MCP result channels carry exactly the same failure. */
export function agentToolFailureResult(
  failure: AgentToolFailure,
  connection?: ConnectionFailureContext,
  receipt?: ToolFailureReceipt,
) {
  const result = { error: normalizeToolError(failure, connection), ...receipt };
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
