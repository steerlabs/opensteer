import { teamAgentHandle } from "@opensteer/core";
import type { TeamMember } from "@opensteer/protocol";
import type { TeamStatusStepSchema } from "@opensteer/core";
import type { z } from "zod";
export function teamAgentIdentity(member: TeamMember, viewerUserId: string) {
  return {
    label: member.userId === viewerUserId ? "Your agent" : `${member.displayName}'s agent`,
    mentionLabel: member.userId === viewerUserId ? "My agent" : `${member.displayName}'s agent`,
    handle: teamAgentHandle(member.handle),
    ownerUserId: member.userId,
    image: member.image,
  };
}
const stepWords = {
  browsed: "Browsed",
  read_files: "Read files",
  edited_files: "Edited files",
  ran_commands: "Ran commands",
  used_integration: "Used an integration",
  searched_team: "Searched the team",
  asked_you: "Asked you",
} as const;
export function teamStatusStepText(step: z.infer<typeof TeamStatusStepSchema>): string {
  return `${stepWords[step.kind]}${step.count > 1 ? ` · ${step.count}` : ""}`;
}
