import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  opensteerAgentSkills,
  skillsForCapabilityProfile,
  type OpensteerAgentSkillName,
} from "@opensteer/agent-tools";
import type { AgentCapabilityProfileId } from "@opensteer/core";
import { parseHarnessSkillMetadata, type HarnessSkill } from "@opensteer/harness";
import { z } from "zod";

const maximumSkillBytes = 64 * 1_024;
// The Agent Plugins 1.0 manifest shape, narrowed to the one bundle Opensteer
// ships. Declared locally so the Runner does not carry the full plugin loader.
const PluginManifestSchema = z.object({
  $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
  name: z.literal("opensteer"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
});

export interface AgentSkillBundle {
  readonly rootPath: string;
  readonly paths: Readonly<Record<OpensteerAgentSkillName, string>>;
}

export async function loadAgentSkillBundle(directory: string): Promise<AgentSkillBundle> {
  if (!isAbsolute(directory)) throw new Error("Agent Skills directory must be absolute");
  const requestedRoot = resolve(directory);
  await requireDirectory(requestedRoot, "Agent Skills directory");
  const rootPath = await realpath(requestedRoot);
  const manifestPath = join(rootPath, "plugin.json");
  await requireRegularFile(manifestPath, "Agent Skills manifest");
  PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));

  const entries = await Promise.all(
    opensteerAgentSkills.map(async ({ name }) => {
      const skillDirectory = join(rootPath, "skills", name);
      await requireDirectory(skillDirectory, `Agent Skill ${name}`);
      const resolvedSkill = await realpath(skillDirectory);
      assertWithin(rootPath, resolvedSkill);
      const skillFile = join(resolvedSkill, "SKILL.md");
      const stat = await requireRegularFile(skillFile, `Agent Skill ${name}`);
      await requireRegularFile(
        join(resolvedSkill, "agents", "openai.yaml"),
        `Agent Skill ${name} OpenAI metadata`,
      );
      if (stat.size > maximumSkillBytes) throw new Error(`Agent Skill ${name} is too large`);
      const content = await readFile(skillFile, "utf8");
      try {
        parseHarnessSkillMetadata(content, name);
      } catch {
        throw new Error(`Agent Skill ${name} has invalid metadata`);
      }
      return [name, resolvedSkill] as const;
    }),
  );
  return Object.freeze({
    paths: Object.freeze(Object.fromEntries(entries)) as Readonly<
      Record<OpensteerAgentSkillName, string>
    >,
    rootPath,
  });
}

export function planAgentSkills(
  bundle: AgentSkillBundle,
  profileId: AgentCapabilityProfileId,
): readonly HarnessSkill[] {
  return Object.freeze(
    skillsForCapabilityProfile(profileId).map(({ name }) =>
      Object.freeze({ name, path: bundle.paths[name] }),
    ),
  );
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function requireRegularFile(path: string, label: string): Promise<Stats> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return stat;
}

function assertWithin(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("Agent Skill escapes its trusted bundle");
}
