import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export async function readWorkspacePackageVersions(repoRoot) {
  const packagesDir = path.join(repoRoot, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const versions = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(packagesDir, entry.name, "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
      versions.set(packageJson.name, packageJson.version);
    }
  }

  return versions;
}

export function rewriteWorkspaceProtocolSpecifiers(manifest, workspacePackageVersions) {
  const output = {
    ...manifest,
  };

  for (const section of dependencySections) {
    const sourceDependencies = manifest[section];
    if (!isDependencyMap(sourceDependencies)) {
      continue;
    }

    let updatedDependencies;
    for (const [packageName, specifier] of Object.entries(sourceDependencies)) {
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) {
        continue;
      }

      const packageVersion =
        workspacePackageVersions instanceof Map
          ? workspacePackageVersions.get(packageName)
          : workspacePackageVersions?.[packageName];
      if (typeof packageVersion !== "string" || packageVersion.length === 0) {
        throw new Error(`Missing workspace version for ${packageName}.`);
      }

      if (!updatedDependencies) {
        updatedDependencies = { ...sourceDependencies };
      }
      updatedDependencies[packageName] = resolveWorkspaceProtocolSpecifier(
        specifier,
        packageVersion,
      );
    }

    if (updatedDependencies) {
      output[section] = updatedDependencies;
    }
  }

  return output;
}

export function collectWorkspaceProtocolSpecifiers(manifest) {
  const matches = [];

  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (!isDependencyMap(dependencies)) {
      continue;
    }

    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        matches.push({
          section,
          packageName,
          specifier,
        });
      }
    }
  }

  return matches;
}

function isDependencyMap(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveWorkspaceProtocolSpecifier(specifier, packageVersion) {
  const workspaceRange = specifier.slice("workspace:".length).trim();
  if (workspaceRange === "" || workspaceRange === "*") {
    return packageVersion;
  }
  if (workspaceRange === "^" || workspaceRange === "~") {
    return `${workspaceRange}${packageVersion}`;
  }
  if (workspaceRange === packageVersion) {
    return packageVersion;
  }
  if (workspaceRange === `^${packageVersion}` || workspaceRange === `~${packageVersion}`) {
    return workspaceRange;
  }

  throw new Error(`Unsupported workspace protocol specifier "${specifier}".`);
}
