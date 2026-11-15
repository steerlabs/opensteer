import type { RunToolCapabilities } from "./registry.js";
import { z } from "zod";

export const OpensteerAgentSkillNameSchema = z.enum([
  "opensteer:integrations",
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

export function opensteerAgentSkillsFor(
  options: { readonly personalContext?: boolean; readonly capabilities?: RunToolCapabilities } = {},
): readonly OpensteerAgentSkillName[] {
  return opensteerAgentSkillNames.filter(
    (name) => name !== "opensteer:memory" || options.personalContext !== false,
  );
}
