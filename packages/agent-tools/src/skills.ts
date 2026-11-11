import { z } from "zod";

export const OpensteerAgentSkillNameSchema = z.enum([
  "opensteer:integrations",
  "opensteer:computer-use",
  "opensteer:threads",
  "opensteer:triggers",
  "opensteer:browser",
  "opensteer:computers",
  "opensteer:devices",
  "opensteer:skills",
  "opensteer:memory",
  "opensteer:knowledge",
]);
export type OpensteerAgentSkillName = z.infer<typeof OpensteerAgentSkillNameSchema>;

/** The skills bundled with every Runner. */
export const opensteerAgentSkillNames: readonly OpensteerAgentSkillName[] = Object.freeze([
  ...OpensteerAgentSkillNameSchema.options,
]);

/** Personal memory follows the agent into every task folder. */
export function opensteerAgentSkillsFor(
  options: {
    readonly teamBound?: boolean;
  } = {},
): readonly OpensteerAgentSkillName[] {
  return opensteerAgentSkillNames.filter(
    (name) => name !== "opensteer:knowledge" || options.teamBound === true,
  );
}
