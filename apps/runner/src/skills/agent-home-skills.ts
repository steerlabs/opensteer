import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  maximumSkillBytes,
  parseHarnessSkillMetadata,
  type HarnessSkill,
} from "@opensteer/harness";
import type { RunnerSkillMetadataReport } from "@opensteer/protocol";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

type CompleteInventory = Extract<RunnerSkillMetadataReport["result"], { status: "complete" }>;
const maximumSkills = 64;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface AgentHomeSkills {
  /** Identifies every discovered skill's SKILL.md, which an engine reads when it starts. */
  readonly digest: string;
  readonly metadata: Readonly<CompleteInventory["skills"]>;
  readonly warningCodes: Readonly<CompleteInventory["warnings"]>;
  readonly skills: readonly HarnessSkill[];
  readonly warnings: readonly string[];
}

/**
 * Discovers `<Agent home>/skills/<name>/SKILL.md`. Every entry here is
 * agent-writable, so one violation skips one skill and is reported rather
 * than failing the Run, and no path may be reached through a symlink.
 */
export async function discoverAgentHomeSkills(
  agentHomePath: string,
  signal?: AbortSignal,
): Promise<AgentHomeSkills> {
  signal?.throwIfAborted();
  const root = join(agentHomePath, "skills");
  const rootStat = await optionalLstat(root);
  signal?.throwIfAborted();
  if (!rootStat) return empty();
  if (rootStat.isSymbolicLink()) return warned("The Agent home skills path is a symlink");
  if (!rootStat.isDirectory()) return warned("The Agent home skills path is not a directory");
  const entries = await readdir(root, { withFileTypes: true });
  signal?.throwIfAborted();
  const skills: HarnessSkill[] = [];
  const metadata: CompleteInventory["skills"] = [];
  const warningCodes = new Set<CompleteInventory["warnings"][number]>();
  const digest = createHash("sha256");
  const warnings: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted();
    const name = entry.name;
    if (entry.isSymbolicLink()) {
      warningCodes.add("symlink");
      warnings.push(`Agent home skill ${name} was skipped: it is a symlink`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const path = join(root, name);
    const skillFile = join(path, "SKILL.md");
    const stat = await optionalLstat(skillFile);
    signal?.throwIfAborted();
    // A directory without SKILL.md is ordinary Agent home content, not a skill.
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warningCodes.add(stat.isSymbolicLink() ? "symlink" : "invalid-metadata");
      warnings.push(`Agent home skill ${name} was skipped: SKILL.md is not a regular file`);
      continue;
    }
    if (skills.length >= maximumSkills) {
      warningCodes.add("limit-exceeded");
      warnings.push(
        `Agent home skill ${name} was skipped: Agent home may load at most ${maximumSkills} skills`,
      );
      continue;
    }
    const read = await readSkill(name, skillFile, stat.size);
    signal?.throwIfAborted();
    if ("problem" in read) {
      warningCodes.add("invalid-metadata");
      warnings.push(`Agent home skill ${name} was skipped: ${read.problem}`);
      continue;
    }
    metadata.push({
      fullName: name,
      description: read.description.slice(0, 320),
      digest: createHash("sha256").update(read.content).digest("hex"),
    });
    digest.update(`${name}\0${read.content}\0`);
    skills.push(Object.freeze({ plugin: null, localName: name, fullName: name, path }));
  }
  return Object.freeze({
    digest: digest.digest("base64url"),
    metadata: Object.freeze(metadata),
    warningCodes: Object.freeze([...warningCodes]),
    skills: Object.freeze(skills),
    warnings: Object.freeze(warnings),
  });
}

async function readSkill(
  name: string,
  skillFile: string,
  size: number,
): Promise<
  { readonly content: string; readonly description: string } | { readonly problem: string }
> {
  if (name.length > 120 || !skillNamePattern.test(name))
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
    const metadata = parseHarnessSkillMetadata(content, name);
    return { content, description: metadata.description };
  } catch {
    return { problem: "the SKILL.md frontmatter is invalid" };
  }
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function empty(): AgentHomeSkills {
  return Object.freeze({
    digest: "none",
    metadata: Object.freeze([]),
    warningCodes: Object.freeze([]),
    skills: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function warned(warning: string): AgentHomeSkills {
  const code: CompleteInventory["warnings"][number] = warning.includes("symlink")
    ? "symlink"
    : "invalid-metadata";
  return Object.freeze({
    digest: "none",
    metadata: Object.freeze([]),
    skills: Object.freeze([]),
    warnings: Object.freeze([warning]),
    warningCodes: Object.freeze([code]),
  });
}
