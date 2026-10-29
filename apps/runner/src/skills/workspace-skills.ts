import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseHarnessSkillMetadata, type HarnessSkill } from "@opensteer/harness";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

const maximumSkillBytes = 64 * 1_024;
const maximumSkills = 64;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface DiscoveredWorkspaceSkills {
  /** Identifies every discovered skill's SKILL.md, which an engine reads when it starts. */
  readonly digest: string;
  readonly skills: readonly HarnessSkill[];
  readonly warnings: readonly string[];
}

/**
 * Discovers `<workspace>/skills/<name>/SKILL.md`. Every entry here is
 * agent-writable Workspace content, so one violation skips one skill and is
 * reported rather than failing the Run, and no path may be reached through a
 * symlink.
 */
export async function discoverWorkspaceSkills(
  workspacePath: string,
): Promise<DiscoveredWorkspaceSkills> {
  const root = join(workspacePath, "skills");
  const rootStat = await optionalLstat(root);
  if (!rootStat) return empty();
  if (rootStat.isSymbolicLink()) return warned("The Workspace skills path is a symlink");
  if (!rootStat.isDirectory()) return warned("The Workspace skills path is not a directory");
  const entries = await readdir(root, { withFileTypes: true });
  const skills: HarnessSkill[] = [];
  const digest = createHash("sha256");
  const warnings: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = entry.name;
    if (entry.isSymbolicLink()) {
      warnings.push(`Workspace skill ${name} was skipped: it is a symlink`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const path = join(root, name);
    const skillFile = join(path, "SKILL.md");
    const stat = await optionalLstat(skillFile);
    // A directory without SKILL.md is ordinary Workspace content, not a skill.
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(`Workspace skill ${name} was skipped: SKILL.md is not a regular file`);
      continue;
    }
    if (skills.length >= maximumSkills) {
      warnings.push(
        `Workspace skill ${name} was skipped: a Workspace may load at most ${maximumSkills} skills`,
      );
      continue;
    }
    const read = await readSkill(name, skillFile, stat.size);
    if ("problem" in read) {
      warnings.push(`Workspace skill ${name} was skipped: ${read.problem}`);
      continue;
    }
    digest.update(`${name}\0${read.content}\0`);
    skills.push(Object.freeze({ name, path }));
  }
  return Object.freeze({
    digest: digest.digest("base64url"),
    skills: Object.freeze(skills),
    warnings: Object.freeze(warnings),
  });
}

async function readSkill(
  name: string,
  skillFile: string,
  size: number,
): Promise<{ readonly content: string } | { readonly problem: string }> {
  if (name.startsWith("opensteer-")) {
    return { problem: "the opensteer- prefix is reserved for the skills Opensteer ships" };
  }
  if (!skillNamePattern.test(name))
    return { problem: "the directory name is not a valid skill name" };
  if (size > maximumSkillBytes) {
    return { problem: `SKILL.md is larger than ${maximumSkillBytes} bytes` };
  }
  let content: string;
  try {
    const bytes = await readBoundedRegularFile(skillFile, maximumSkillBytes, {
      changedError: () => new Error("Skill changed during discovery"),
      invalidFileError: () => new Error("Skill is not a regular file"),
      sizeError: () => new Error("Skill exceeds its size limit"),
    });
    if (!bytes) return { problem: "SKILL.md could not be read safely" };
    content = bytes.toString("utf8");
  } catch {
    return { problem: "SKILL.md could not be read safely" };
  }
  try {
    parseHarnessSkillMetadata(content, name);
  } catch {
    return { problem: "the SKILL.md frontmatter is invalid" };
  }
  return { content };
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function empty(): DiscoveredWorkspaceSkills {
  return Object.freeze({
    digest: "none",
    skills: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function warned(warning: string): DiscoveredWorkspaceSkills {
  return Object.freeze({
    digest: "none",
    skills: Object.freeze([]),
    warnings: Object.freeze([warning]),
  });
}
