import { maximumSkillBytes } from "@opensteer/shared/agentSkills";
import { isAbsolute, join, resolve } from "node:path";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { HarnessSkill, HarnessSkillPlan } from "./types.js";

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
  for (const { fullName: name, path } of plan.skills) {
    if (!isAbsolute(path)) throw new Error(`Agent Skill ${name} path must be absolute`);
  }
  const entries = await Promise.all(
    plan.skills.map(async ({ fullName: name, localName, path, plugin }) => {
      const skillFile = join(path, "SKILL.md");
      try {
        const bytes = await readBoundedRegularFile(skillFile, maximumSkillBytes, {
          changedError: () => new Error("changed"),
          invalidFileError: () => new Error("invalid"),
          sizeError: () => new Error("oversized"),
        });
        const metadata = parseHarnessSkillMetadata(bytes!.toString("utf8"), localName);
        return `- ${name}: ${boundedDescription(metadata.description)}\n  SKILL.md: ${skillFile}${plugin ? `\n  PLUGIN_ROOT: ${resolve(path, "../..")}` : ""}`;
      } catch {
        // Plugin skills are third-party files and can also change between
        // planning and launch. Keep unrelated work usable while telling the
        // model exactly which selected file it can inspect if the skill applies.
        return `- ${name}: Metadata unavailable; inspect SKILL.md directly if this skill may apply.\n  SKILL.md: ${skillFile}${plugin ? `\n  PLUGIN_ROOT: ${resolve(path, "../..")}` : ""}`;
      }
    }),
  );
  return [
    "Available Agent Skills",
    "Use a skill when its description matches the task. Read its SKILL.md file before following it; do not read unrelated skill files. Resolve a Markdown link from the file that contains it, and other relative paths from the SKILL.md directory.",
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
  localName: string,
): z.infer<typeof SkillMetadataSchema> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error(`Agent Skill ${localName} has invalid metadata`);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch {
    throw new Error(`Agent Skill ${localName} has invalid metadata`);
  }
  const result = SkillMetadataSchema.safeParse(parsed);
  if (!result.success || result.data.name !== localName) {
    throw new Error(`Agent Skill ${localName} has invalid metadata`);
  }
  return result.data;
}

function assertUniqueNames(plan: HarnessSkillPlan): void {
  const names = new Set<string>();
  for (const { fullName: name } of plan.skills) {
    if (names.has(name)) throw new Error(`Duplicate selected Agent Skill name ${name}`);
    names.add(name);
  }
}

export { maximumSkillBytes } from "@opensteer/shared/agentSkills";

/** Native engines that key on frontmatter names need a private delivery copy. */
export async function renderNativeHarnessSkill(skill: HarnessSkill): Promise<string> {
  const bytes = await readBoundedRegularFile(join(skill.path, "SKILL.md"), maximumSkillBytes, {
    changedError: () => new Error(`Agent Skill ${skill.fullName} changed`),
    invalidFileError: () => new Error(`Agent Skill ${skill.fullName} is invalid`),
    sizeError: () => new Error(`Agent Skill ${skill.fullName} is oversized`),
  });
  if (!bytes) throw new Error(`Agent Skill ${skill.fullName} is missing`);
  const content = bytes.toString("utf8");
  const metadata = parseHarnessSkillMetadata(content, skill.localName);
  const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content)!;
  return `---\n${JSON.stringify({ ...metadata, name: skill.fullName })}\n---\n${skill.plugin ? `PLUGIN_ROOT: ${resolve(skill.path, "../..")}\n\n${content.slice(header[0].length).replaceAll("${PLUGIN_ROOT}", resolve(skill.path, "../.."))}` : content.slice(header[0].length)}`;
}
