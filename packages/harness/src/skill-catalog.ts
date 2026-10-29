import { isAbsolute, join } from "node:path";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { HarnessSkillPlan } from "./types.js";

const maximumSkillBytes = 64 * 1_024;
const maximumDescriptionCharacters = 1_024;
const SkillMetadataSchema = z.looseObject({
  description: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

/** Renders the resolved catalog while leaving skill bodies on disk for lazy reads. */
export async function renderHarnessSkillCatalog(
  plan: HarnessSkillPlan | undefined,
): Promise<string | undefined> {
  if (!plan || plan.skills.length === 0) return undefined;
  assertUniqueNames(plan);
  for (const { name, path } of plan.skills) {
    if (!isAbsolute(path)) throw new Error(`Agent Skill ${name} path must be absolute`);
  }
  const entries = await Promise.all(
    plan.skills.map(async ({ name, path }) => {
      const skillFile = join(path, "SKILL.md");
      try {
        const bytes = await readBoundedRegularFile(skillFile, maximumSkillBytes, {
          changedError: () => new Error("changed"),
          invalidFileError: () => new Error("invalid"),
          sizeError: () => new Error("oversized"),
        });
        const metadata = parseHarnessSkillMetadata(bytes!.toString("utf8"), name);
        return `- ${name}: ${boundedDescription(metadata.description)}\n  SKILL.md: ${skillFile}`;
      } catch {
        // Integration skills are third-party files and can also change between
        // planning and launch. Keep unrelated work usable while telling the
        // model exactly which selected file it can inspect if the skill applies.
        return `- ${name}: Metadata unavailable; inspect SKILL.md directly if this skill may apply.\n  SKILL.md: ${skillFile}`;
      }
    }),
  );
  return [
    "Available Agent Skills",
    "Use a skill when its description matches the task. Read its SKILL.md file before following it; do not read unrelated skill files.",
    ...entries,
  ].join("\n");
}

function boundedDescription(description: string): string {
  const characters = Array.from(description.replace(/\s+/gu, " ").trim());
  if (characters.length <= maximumDescriptionCharacters) return characters.join("");
  return `${characters.slice(0, maximumDescriptionCharacters - 1).join("")}…`;
}

/** Parses the common Agent Skill frontmatter contract and verifies its selected name. */
export function parseHarnessSkillMetadata(
  content: string,
  selectedName: string,
): z.infer<typeof SkillMetadataSchema> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error(`Agent Skill ${selectedName} has invalid metadata`);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch {
    throw new Error(`Agent Skill ${selectedName} has invalid metadata`);
  }
  const result = SkillMetadataSchema.safeParse(parsed);
  if (!result.success || result.data.name !== selectedName) {
    throw new Error(`Agent Skill ${selectedName} has invalid metadata`);
  }
  return result.data;
}

function assertUniqueNames(plan: HarnessSkillPlan): void {
  const names = new Set<string>();
  for (const { name } of plan.skills) {
    if (names.has(name)) throw new Error(`Duplicate selected Agent Skill name ${name}`);
    names.add(name);
  }
}
