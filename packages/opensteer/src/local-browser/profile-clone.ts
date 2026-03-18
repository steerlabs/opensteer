import { copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { expandHome } from "./chrome-discovery.js";
import {
  CHROME_SINGLETON_ARTIFACTS,
  clearChromeSingletonEntries,
} from "./chrome-singletons.js";

const CHROME_SINGLETON_ENTRIES = new Set<string>(CHROME_SINGLETON_ARTIFACTS);

const SKIPPED_ROOT_DIRECTORIES = new Set([
  "Crash Reports",
  "Crashpad",
  "BrowserMetrics",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
  "component_crx_cache",
  "Crowd Deny",
  "hyphen-data",
  "OnDeviceHeadSuggestModel",
  "OptimizationGuidePredictionModels",
  "Segmentation Platform",
  "SmartCardDeviceNames",
  "WidevineCdm",
  "pnacl",
]);

export async function createBrowserProfileSnapshot(input: {
  readonly sourceUserDataDir: string;
  readonly targetUserDataDir: string;
  readonly profileDirectory?: string;
}): Promise<void> {
  const sourceUserDataDir = resolve(expandHome(input.sourceUserDataDir));
  const targetUserDataDir = resolve(expandHome(input.targetUserDataDir));
  const profileDirectory = input.profileDirectory?.trim();

  await mkdir(targetUserDataDir, { recursive: true });
  await clearChromeSingletonEntries(targetUserDataDir);

  if (profileDirectory) {
    const sourceProfileDir = join(sourceUserDataDir, profileDirectory);
    if (!existsSync(sourceProfileDir)) {
      throw new Error(
        `Chrome profile "${profileDirectory}" was not found in "${sourceUserDataDir}".`,
      );
    }

    await cp(sourceProfileDir, join(targetUserDataDir, profileDirectory), {
      recursive: true,
      filter: (candidate) => shouldCopyEntry(candidate),
    });
  }

  await copyRootLevelEntries({
    sourceUserDataDir,
    targetUserDataDir,
    ...(profileDirectory === undefined ? {} : { selectedProfileDirectory: profileDirectory }),
  });
  await clearChromeSingletonEntries(targetUserDataDir);
}

async function copyRootLevelEntries(input: {
  readonly sourceUserDataDir: string;
  readonly targetUserDataDir: string;
  readonly selectedProfileDirectory?: string;
}): Promise<void> {
  const entries = await readdir(input.sourceUserDataDir).catch(() => []);

  for (const entry of entries) {
    if (CHROME_SINGLETON_ENTRIES.has(entry) || entry === input.selectedProfileDirectory) {
      continue;
    }

    const sourcePath = join(input.sourceUserDataDir, entry);
    const targetPath = join(input.targetUserDataDir, entry);

    const entryStat = await stat(sourcePath).catch(() => null);
    if (!entryStat) {
      continue;
    }

    if (entryStat.isFile()) {
      await copyFile(sourcePath, targetPath).catch(() => undefined);
      continue;
    }

    if (!entryStat.isDirectory()) {
      continue;
    }

    if (SKIPPED_ROOT_DIRECTORIES.has(entry) || isProfileDirectory(input.sourceUserDataDir, entry)) {
      continue;
    }

    await cp(sourcePath, targetPath, {
      recursive: true,
      filter: (candidate) => shouldCopyEntry(candidate),
    }).catch(() => undefined);
  }
}

function isProfileDirectory(userDataDir: string, entry: string): boolean {
  return existsSync(join(userDataDir, entry, "Preferences"));
}

function shouldCopyEntry(candidatePath: string): boolean {
  const entryName = candidatePath.split("/").at(-1)?.split("\\").at(-1) ?? candidatePath;
  return !CHROME_SINGLETON_ENTRIES.has(entryName);
}
