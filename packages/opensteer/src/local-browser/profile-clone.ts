import { copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { expandHome } from "./chrome-discovery.js";
import {
  CHROME_SINGLETON_ARTIFACTS,
  clearChromeSingletonEntries,
  sanitizeChromeProfile,
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

const SESSION_ROOT_FILES = new Set(["Local State"]);

const SESSION_SKIPPED_PROFILE_DIRECTORIES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "Service Worker",
  "File System",
  "blob_storage",
  "Network",
]);

export async function createBrowserProfileSnapshot(input: {
  readonly sourceUserDataDir: string;
  readonly targetUserDataDir: string;
  readonly profileDirectory?: string;
  readonly copyMode?: "full" | "session";
}): Promise<void> {
  const sourceUserDataDir = resolve(expandHome(input.sourceUserDataDir));
  const targetUserDataDir = resolve(expandHome(input.targetUserDataDir));
  const profileDirectory = input.profileDirectory?.trim();
  const copyMode = input.copyMode ?? "full";

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
      filter: (candidate) =>
        shouldCopyEntry({
          candidatePath: candidate,
          copyMode,
          rootPath: sourceProfileDir,
        }),
    });
  }

  await copyRootLevelEntries({
    copyMode,
    sourceUserDataDir,
    targetUserDataDir,
    ...(profileDirectory === undefined ? {} : { selectedProfileDirectory: profileDirectory }),
  });
  await clearChromeSingletonEntries(targetUserDataDir);
  await sanitizeChromeProfile(targetUserDataDir);
}

async function copyRootLevelEntries(input: {
  readonly copyMode: "full" | "session";
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
      if (input.copyMode === "session" && !SESSION_ROOT_FILES.has(entry)) {
        continue;
      }
      await copyFile(sourcePath, targetPath).catch(() => undefined);
      continue;
    }

    if (!entryStat.isDirectory()) {
      continue;
    }

    if (SKIPPED_ROOT_DIRECTORIES.has(entry) || isProfileDirectory(input.sourceUserDataDir, entry)) {
      continue;
    }

    if (input.copyMode === "session") {
      continue;
    }

    await cp(sourcePath, targetPath, {
      recursive: true,
      filter: (candidate) =>
        shouldCopyEntry({
          candidatePath: candidate,
          copyMode: input.copyMode,
          rootPath: sourcePath,
        }),
    }).catch(() => undefined);
  }
}

function isProfileDirectory(userDataDir: string, entry: string): boolean {
  return existsSync(join(userDataDir, entry, "Preferences"));
}

function shouldCopyEntry(input: {
  readonly candidatePath: string;
  readonly copyMode: "full" | "session";
  readonly rootPath: string;
}): boolean {
  const entryName =
    input.candidatePath.split("/").at(-1)?.split("\\").at(-1) ?? input.candidatePath;
  if (CHROME_SINGLETON_ENTRIES.has(entryName)) {
    return false;
  }

  if (input.copyMode !== "session") {
    return true;
  }

  const relativePath = relative(input.rootPath, input.candidatePath);
  if (relativePath.length === 0) {
    return true;
  }

  const firstSegment = relativePath.split("/").at(0)?.split("\\").at(0) ?? relativePath;
  return !SESSION_SKIPPED_PROFILE_DIRECTORIES.has(firstSegment);
}
