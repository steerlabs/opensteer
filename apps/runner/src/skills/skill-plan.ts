import type { HarnessSkill, HarnessSkillPlan } from "@opensteer/harness";

const reservedPrefix = "opensteer-";

interface SkillPlanLayers {
  /** Agent Skills shipped with the Runner and selected by capability profile. */
  readonly bundled: readonly HarnessSkill[];
  /** Agent Skills materialized from the Host's signed integration grants. */
  readonly integration: readonly HarnessSkill[];
  /** Agent Skills discovered in the Run's Workspace. */
  readonly workspace: readonly HarnessSkill[];
}

/**
 * Resolves the three skill layers into one flat plan. A higher layer shadows a
 * lower one by name (workspace > integration > bundled); a conflict inside one
 * layer is a defect in the layer's producer and fails the Run.
 */
export function resolveSkillPlan(layers: SkillPlanLayers): HarnessSkillPlan | undefined {
  assertUnique(layers.bundled, "Opensteer bundled");
  assertUnique(layers.integration, "integration");
  for (const { name } of layers.integration) {
    if (name.startsWith(reservedPrefix)) {
      throw new Error(
        `Integration Agent Skill ${name} uses the ${reservedPrefix} prefix reserved for Opensteer`,
      );
    }
  }
  const shadowed = new Set<string>([
    ...layers.workspace.map(({ name }) => name),
    ...layers.integration.map(({ name }) => name),
  ]);
  const skills = [
    ...layers.bundled.filter(({ name }) => !shadowed.has(name)),
    ...layers.integration.filter(
      ({ name }) => !layers.workspace.some((skill) => skill.name === name),
    ),
    ...layers.workspace,
  ].map(({ name, path }) => Object.freeze({ name, path }));
  return skills.length === 0 ? undefined : Object.freeze({ skills: Object.freeze(skills) });
}

function assertUnique(skills: readonly HarnessSkill[], label: string): void {
  const seen = new Set<string>();
  for (const { name } of skills) {
    if (seen.has(name)) throw new Error(`Duplicate ${label} Agent Skill name ${name}`);
    seen.add(name);
  }
}
