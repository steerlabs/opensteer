import {
  lineageCompatibleForReuse,
  threadAccessModeAtMost,
  threadInReach,
  type Thread,
} from "@opensteer/core";

export type AuthorityThread = Pick<
  Thread,
  "accessMode" | "inheritsMain" | "specialistId" | "lineageRootThreadId" | "workspaceId"
>;

export type TriggerAccess = "none" | "see" | "control" | "define";

export function triggerAccess(actor: AuthorityThread, anchor: AuthorityThread): TriggerAccess {
  if (!threadInReach(actor, anchor) || !lineageCompatibleForReuse(actor, anchor)) return "none";
  if (actor.accessMode === "full-access") return "define";
  return threadAccessModeAtMost(anchor.accessMode, actor.accessMode) ? "control" : "see";
}
