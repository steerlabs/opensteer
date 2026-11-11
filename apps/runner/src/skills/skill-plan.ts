import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessSkill, HarnessSkillPlan } from "@opensteer/harness";
interface SkillPlanLayers {
  readonly bundled: readonly HarnessSkill[];
  readonly integration: readonly HarnessSkill[];
  readonly home: readonly HarnessSkill[];
  readonly folder: readonly HarnessSkill[];
}
/** Folder skills override home names; one canonical source appears only once. */
export async function resolveSkillPlan(
  layers: SkillPlanLayers,
): Promise<HarnessSkillPlan | undefined> {
  const selected = new Map<string, HarnessSkill>();
  const ordered = [...layers.bundled, ...layers.integration, ...layers.home, ...layers.folder];
  for (const skill of ordered) {
    const expected = skill.plugin === null ? skill.localName : `${skill.plugin}:${skill.localName}`;
    if (skill.localName.includes(":") || skill.fullName !== expected)
      throw new Error(`Invalid Agent Skill identity ${skill.fullName}`);
    selected.set(
      skill.fullName,
      Object.freeze({
        ...skill,
        path: await realpath(skill.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return resolve(skill.path);
          throw error;
        }),
      }),
    );
  }
  const sources = new Set<string>();
  const skills = [...selected.values()].filter((skill) => {
    if (sources.has(skill.path)) return false;
    sources.add(skill.path);
    return true;
  });
  return skills.length ? Object.freeze({ skills: Object.freeze(skills) }) : undefined;
}
