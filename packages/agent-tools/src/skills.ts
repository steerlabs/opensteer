import type { ThreadReachScope } from "@opensteer/core";
import { z } from "zod";

export const OpensteerAgentSkillNameSchema = z.enum([
  "opensteer:integrations",
  "opensteer:computer-use",
  "opensteer:projects",
  "opensteer:threads",
  "opensteer:triggers",
  "opensteer:browser",
  "opensteer:computers",
  "opensteer:skills",
  "opensteer:memory",
]);
export type OpensteerAgentSkillName = z.infer<typeof OpensteerAgentSkillNameSchema>;

/** The skills bundled with every Runner. */
export const opensteerAgentSkillNames: readonly OpensteerAgentSkillName[] = Object.freeze([
  ...OpensteerAgentSkillNameSchema.options,
]);

const withoutMemory = Object.freeze(
  opensteerAgentSkillNames.filter((name) => name !== "opensteer:memory"),
);

/** Personal memory lives in Main; Project and specialist Runs never receive it. */
export function opensteerAgentSkillsFor(
  reach: ThreadReachScope["kind"],
): readonly OpensteerAgentSkillName[] {
  return reach === "user" ? opensteerAgentSkillNames : withoutMemory;
}
