import { OpensteerError, threadAccessModeAtMost, type Thread } from "@opensteer/core";
import type { AgentToolAccess } from "@opensteer/agent-tools";
import type { AgentCaller } from "./agent-caller.js";

/** Targets have already been resolved through getThreadForOwner at admission. */
export function read(_caller: AgentCaller, _targets: readonly Thread[]): void {}
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
