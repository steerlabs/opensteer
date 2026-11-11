import { threadAccessModeAtMost, type Thread } from "@opensteer/core";
export type AuthorityThread = Pick<Thread, "accessMode">;
export type TriggerAccess = "none" | "see" | "control" | "define";
export function triggerAccess(actor: AuthorityThread, anchor: AuthorityThread): TriggerAccess {
  if (actor.accessMode === "full-access") return "define";
  return threadAccessModeAtMost(anchor.accessMode, actor.accessMode) ? "control" : "see";
}
