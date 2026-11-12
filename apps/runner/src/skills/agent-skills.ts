import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  opensteerAgentSkillNames,
  OpensteerAgentSkillNameSchema,
  type OpensteerAgentSkillName,
} from "@opensteer/agent-tools";
import {
  maximumSkillBytes,
  parseHarnessSkillMetadata,
  type HarnessSkill,
} from "@opensteer/harness";
import { z } from "zod";

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
    opensteerAgentSkillNames.map((name) => loadSkill(rootPath, name)),
  );
  return Object.freeze({
    paths: Object.freeze(Object.fromEntries(entries)) as AgentSkillBundle["paths"],
    rootPath,
  });
}

async function loadSkill(
  rootPath: string,
  name: OpensteerAgentSkillName,
): Promise<readonly [OpensteerAgentSkillName, string]> {
  const skillDirectory = join(rootPath, "skills", name.split(":")[1]!);
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
    parseHarnessSkillMetadata(content, name.split(":")[1]!);
  } catch {
    throw new Error(`Agent Skill ${name} has invalid metadata`);
  }
  return [name, resolvedSkill] as const;
}

export function planAgentSkills(
  bundle: AgentSkillBundle,
  names: readonly string[],
): readonly HarnessSkill[] {
  return Object.freeze(
    names.map((value) => {
      const name = OpensteerAgentSkillNameSchema.parse(value);
      const path = bundle.paths[name];
      if (!path) throw new Error(`Agent Skill ${name} is not available on this Runner`);
      return Object.freeze({
        plugin: "opensteer",
        localName: name.split(":")[1]!,
        fullName: name,
        path,
      });
    }),
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
