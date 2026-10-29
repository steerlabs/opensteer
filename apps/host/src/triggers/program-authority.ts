import {
  capabilityProfileAllowsTool,
  AgentToolIdSchema,
  type AgentToolId,
} from "@opensteer/agent-tools";
import {
  OpensteerError,
  threadInReach,
  type AgentCapabilityProfileId,
  type Thread,
  type WorkspaceId,
} from "@opensteer/core";
import type { AgentControlRequest } from "@opensteer/protocol";

export type ProgramKind = "trigger" | "watch";

export function programAllowsTool(
  kind: ProgramKind,
  anchorProfileId: AgentCapabilityProfileId,
  toolId: AgentToolId,
): boolean {
  const allowedByProgram =
    kind === "watch"
      ? toolId === "thread.message" || toolId === "thread.delegate" || toolId === "environment.list"
      : capabilityProfileAllowsTool("trigger", toolId);
  return allowedByProgram && capabilityProfileAllowsTool(anchorProfileId, toolId);
}

export function assertProgramToolAllowed(
  kind: ProgramKind,
  anchor: Thread,
  request: AgentControlRequest,
): void {
  const tool = AgentToolIdSchema.safeParse(
    request.type === "trigger.control"
      ? request.tool
      : request.type === "workspace.inspect"
        ? "workspace.list"
        : request.type,
  );
  if (!tool.success || !programAllowsTool(kind, anchor.capabilityProfileId, tool.data)) {
    throw forbidden(
      `${kind === "watch" ? "Watch" : "Trigger"} program anchored at capability profile ${anchor.capabilityProfileId} does not allow ${tool.success ? tool.data : request.type}`,
    );
  }
}

export function assertProgramThreadScope(anchor: Thread, target: Thread): void {
  if (threadInReach(anchor, target)) return;
  throw forbidden(
    anchor.capabilityProfileId === "workspace"
      ? "This capability profile can access Threads only in its Workspace"
      : "A delegated Thread can read only Threads in its delegation lineage",
  );
}

export function assertProgramMessageScope(
  anchor: Thread,
  target: Thread,
  request: Extract<AgentControlRequest, { type: "thread.message" }>,
): void {
  if (request.threadId === "home" && request.delivery === "report") return;
  assertProgramThreadScope(anchor, target);
}

export function assertProgramDelegationScope(
  anchor: Thread,
  workspaceId: WorkspaceId,
  existingThread: Thread | null,
): void {
  if (existingThread) assertProgramThreadScope(anchor, existingThread);
  if (anchor.capabilityProfileId !== "main" && workspaceId !== anchor.workspaceId) {
    throw forbidden("This capability profile can delegate only inside its Workspace");
  }
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
