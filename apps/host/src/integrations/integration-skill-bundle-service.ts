import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { IntegrationSkillBundleSchema, type IntegrationSkillBundle } from "@opensteer/protocol";
import type { IntegrationPlatformStore } from "@opensteer/database";
import type { RunCapabilityTokenService } from "../agents/run-capability.js";

const maximumBundleBytes = 24 * 1_024 * 1_024;
const maximumFiles = 10_000;

export type IntegrationSkillsTokenService =
  RunCapabilityTokenService<"opensteer-integration-skills">;

export class IntegrationSkillBundleService {
  readonly #snapshotDirectory: string;
  readonly #store: IntegrationPlatformStore;
  readonly #tokens: IntegrationSkillsTokenService;

  constructor(options: {
    readonly snapshotDirectory: string;
    readonly store: IntegrationPlatformStore;
    readonly tokens: IntegrationSkillsTokenService;
  }) {
    if (!isAbsolute(options.snapshotDirectory)) {
      throw new Error("Agent Plugin snapshot directory must be absolute");
    }
    this.#snapshotDirectory = options.snapshotDirectory;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  async bundle(token: string): Promise<IntegrationSkillBundle> {
    const scope = await this.#tokens.authenticate(token);
    const granted = await this.#store.listGrantedSkills({
      ownerUserId: scope.requestedBy,
      threadId: scope.threadId,
      workspaceId: scope.workspaceId,
    });
    const installations = new Map<
      string,
      { installation: (typeof granted)[number]["installation"]; skillNames: Set<string> }
    >();
    for (const item of granted) {
      if (item.installation.sourceKind !== "agent-plugin") continue;
      const current = installations.get(item.installation.id) ?? {
        installation: item.installation,
        skillNames: new Set<string>(),
      };
      current.skillNames.add(item.skill.name);
      installations.set(item.installation.id, current);
    }
    let totalBytes = 0;
    let totalFiles = 0;
    const plugins: Array<IntegrationSkillBundle["plugins"][number]> = [];
    if (installations.size === 0) {
      return IntegrationSkillBundleSchema.parse({ plugins });
    }
    const snapshotDirectory = await realpath(this.#snapshotDirectory);
    for (const { installation, skillNames } of installations.values()) {
      const snapshotDigest = installation.provenance.snapshotDigest;
      if (typeof snapshotDigest !== "string" || !/^[a-f0-9]{64}$/u.test(snapshotDigest)) {
        throw new Error(`Agent Plugin ${installation.name} has no immutable package snapshot`);
      }
      const snapshotPath = join(snapshotDirectory, snapshotDigest);
      const snapshotStat = await lstat(snapshotPath);
      if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) {
        throw new Error(`Agent Plugin ${installation.name} has an invalid package snapshot`);
      }
      const resolvedRoot = await realpath(snapshotPath);
      assertWithin(snapshotDirectory, resolvedRoot);
      if (resolvedRoot === snapshotDirectory) {
        throw new Error(`Agent Plugin ${installation.name} has an invalid package snapshot`);
      }
      const skillsRoot = join(resolvedRoot, "skills");
      const rootStat = await optionalLstat(skillsRoot);
      if (!rootStat) continue;
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Agent Plugin ${installation.name} has an invalid skills directory`);
      }
      const skills = [];
      for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !skillNames.has(entry.name)) continue;
        const skillRoot = await realpath(join(skillsRoot, entry.name));
        assertWithin(resolvedRoot, skillRoot);
        const files = await collectFiles(skillRoot, (bytes) => {
          totalBytes += bytes;
          totalFiles += 1;
          if (totalBytes > maximumBundleBytes || totalFiles > maximumFiles) {
            throw new Error("Granted Agent Plugin skills exceed the Run bundle limit");
          }
        });
        if (files.some(({ path }) => path === "SKILL.md")) {
          skills.push({ files, name: entry.name });
        }
      }
      if (skills.length > 0) plugins.push({ name: installation.name, skills });
    }
    return IntegrationSkillBundleSchema.parse({ plugins });
  }
}

async function collectFiles(
  root: string,
  onFile: (bytes: number) => void,
): Promise<Array<{ content: string; executable: boolean; path: string }>> {
  const files: { content: string; executable: boolean; path: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Agent Plugin snapshot contains a symlink");
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error("Agent Plugin snapshot contains an unsupported entry");
      const bytes = await readFile(path);
      onFile(bytes.byteLength);
      files.push({
        content: bytes.toString("base64"),
        executable: (stat.mode & 0o111) !== 0,
        path: portableRelative(root, path),
      });
    }
  };
  await visit(root);
  return files;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error("Agent Plugin skill file escaped its package");
  }
  return value.split(sep).join("/");
}

function assertWithin(root: string, path: string): void {
  const value = relative(root, path);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))) {
    return;
  }
  throw new Error("Agent Plugin skill escaped its package");
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
