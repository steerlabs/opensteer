import type { RunToolCapabilities } from "./registry.js";
import { z } from "zod";

export const OpensteerAgentSkillNameSchema = z.enum([
  "opensteer:integrations",
  "opensteer:plugins",
  "opensteer:computer-use",
  "opensteer:tasks",
  "opensteer:automations",
  "opensteer:browser",
  "opensteer:computers",
  "opensteer:devices",
  "opensteer:skills",
  "opensteer:memory",
]);
export type OpensteerAgentSkillName = z.infer<typeof OpensteerAgentSkillNameSchema>;

/** The skills bundled with every Runner. */
export const opensteerAgentSkillNames: readonly OpensteerAgentSkillName[] = Object.freeze([
  ...OpensteerAgentSkillNameSchema.options,
]);

/** A driver's skill is offered only with the capability it explains. */
export function opensteerAgentSkillsFor(options: {
  readonly personalContext?: boolean;
  readonly capabilities: RunToolCapabilities;
}): readonly OpensteerAgentSkillName[] {
  return opensteerAgentSkillNames.filter((name) => {
    if (name === "opensteer:memory") return options.personalContext !== false;
    if (name === "opensteer:browser") return options.capabilities.pages;
    if (name === "opensteer:computer-use") return options.capabilities.computerUse;
    return true;
  });
}
