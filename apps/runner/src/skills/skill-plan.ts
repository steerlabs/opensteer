import type { HarnessSkill, HarnessSkillPlan } from "@opensteer/harness";

interface SkillPlanLayers {
  readonly bundled: readonly HarnessSkill[];
  readonly integration: readonly HarnessSkill[];
  readonly workspace: readonly HarnessSkill[];
}

/** Every selected identity is unique; layers never shadow each other. */
export function resolveSkillPlan(layers: SkillPlanLayers): HarnessSkillPlan | undefined {
  const skills = [...layers.bundled, ...layers.integration, ...layers.workspace];
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const expected = skill.plugin === null ? skill.localName : `${skill.plugin}:${skill.localName}`;
    if (skill.localName.includes(":") || skill.fullName !== expected) {
      throw new Error(`Invalid Agent Skill identity ${skill.fullName}`);
    }
    const previous = seen.get(skill.fullName);
    if (previous !== undefined) {
      throw new Error(
        `Duplicate Agent Skill full name ${skill.fullName}: ${previous} and ${skill.path}`,
      );
    }
    seen.set(skill.fullName, skill.path);
  }
  return skills.length === 0
    ? undefined
    : Object.freeze({ skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))) });
}
