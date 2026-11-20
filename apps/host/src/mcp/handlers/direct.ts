import { OpensteerError } from "@opensteer/core";
import {
  OperationOutcomeUnknown,
  type AgentSessionService,
  type DirectOperationResult,
} from "../../agent-sessions/agent-session-service.js";

/**
 * What a connected agent's direct tool returns: the tool's own result beside the task the work
 * belongs to, the operation's receipt and, when the person has to decide first, what to do next.
 */
export function directResult<Result extends object>(outcome: DirectOperationResult<Result>) {
  const { status, taskId, operationId } = outcome;
  return {
    ...(outcome.status === "completed" && outcome.result ? outcome.result : {}),
    status,
    taskId,
    operationId,
    ...(outcome.status === "pending" ? { requestId: outcome.requestId } : {}),
    ...(outcome.status === "completed" ? {} : { next: outcome.next }),
  };
}

export async function browserEffect<Result>(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof OpensteerError &&
      (error.reason === "outcome-unknown" || error.reason === "browser-tab-open-outcome-unknown")
    )
      throw new OperationOutcomeUnknown(error.message);
    throw error;
  }
}

/** The session pipeline, or a refusal on a Home that was started without it. */
export function requireDirectWork(sessions: AgentSessionService | undefined): AgentSessionService {
  if (!sessions)
    throw new OpensteerError({
      code: "conflict",
      message: "This Home does not run direct work for connected agents.",
    });
  return sessions;
}
