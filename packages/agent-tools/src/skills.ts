import { AgentCapabilityProfileIdSchema, type AgentCapabilityProfileId } from "./catalog.js";
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

export interface OpensteerAgentSkillDefinition {
  readonly name: OpensteerAgentSkillName;
  readonly profiles: readonly AgentCapabilityProfileId[];
}

export const opensteerAgentSkills: readonly OpensteerAgentSkillDefinition[] = Object.freeze([
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:skills"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:integrations"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:computer-use"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:browser"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:computers"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:projects"),
    profiles: Object.freeze([AgentCapabilityProfileIdSchema.parse("main")]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:threads"),
    profiles: Object.freeze([
      AgentCapabilityProfileIdSchema.parse("main"),
      AgentCapabilityProfileIdSchema.parse("workspace"),
      AgentCapabilityProfileIdSchema.parse("delegated"),
      AgentCapabilityProfileIdSchema.parse("specialist"),
    ]),
  }),
  Object.freeze({
    name: OpensteerAgentSkillNameSchema.parse("opensteer:triggers"),
    profiles: Object.freeze([...AgentCapabilityProfileIdSchema.options]),
  }),
]);

export function skillsForCapabilityProfile(
  profileId: AgentCapabilityProfileId,
): readonly OpensteerAgentSkillDefinition[] {
  const parsed = AgentCapabilityProfileIdSchema.parse(profileId);
  return opensteerAgentSkills.filter(({ profiles }) => profiles.includes(parsed));
}
