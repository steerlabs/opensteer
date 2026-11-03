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
]);
export type OpensteerAgentSkillName = z.infer<typeof OpensteerAgentSkillNameSchema>;

/** The skills bundled with every Runner and offered to every Run. */
export const opensteerAgentSkillNames: readonly OpensteerAgentSkillName[] = Object.freeze([
  ...OpensteerAgentSkillNameSchema.options,
]);
