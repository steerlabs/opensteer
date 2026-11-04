import { OpensteerError, threadAccessModeAtMost, type Thread } from "@opensteer/core";
import type { AgentToolAccess } from "@opensteer/agent-tools";
import type { AgentCaller } from "./agent-caller.js";

export function assertCallerReach(
  caller: AgentCaller,
  target: Pick<Thread, "workspaceId" | "lineageRootThreadId">,
): void {
  const reach = caller.reach;
  if (
    reach.kind === "user" ||
    (reach.kind === "workspace"
      ? reach.workspaceId === target.workspaceId
      : reach.lineageRootThreadId === target.lineageRootThreadId)
  )
    return;
  throw forbidden("Target Thread is outside the caller's reach");
}
export function read(caller: AgentCaller, targets: readonly Thread[]): void {
  for (const target of targets) assertCallerReach(caller, target);
}
export function write(caller: AgentCaller, targets: readonly Thread[]): void {
  read(caller, targets);
  for (const target of targets) {
    if (!threadAccessModeAtMost(target.accessMode, caller.accessMode))
      throw forbidden("Target Thread has a stronger access mode than this caller");
  }
}
export function settings(caller: AgentCaller, targets: readonly Thread[]): void {
  if (caller.accessMode !== "full-access")
    throw forbidden("Changing settings requires full-access");
  write(caller, targets);
}
export const toolAccess: Record<
  AgentToolAccess,
  (caller: AgentCaller, targets: readonly Thread[]) => void
> = { read, write, settings };
function forbidden(message: string) {
  return new OpensteerError({ code: "forbidden", message });
}
