import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { collectWorkspaceProtocolSpecifiers } from "./package-manifest-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishPackageDirs = [
  "packages/browser-core",
  "packages/protocol",
  "packages/runtime-core",
  "packages/engine-playwright",
  "packages/engine-abp",
  "packages/opensteer",
];

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opensteer-pack-check-"));

try {
  for (const relativePackageDir of publishPackageDirs) {
    const packageDir = path.join(repoRoot, relativePackageDir);
    const tarballPath = await packPackage(packageDir, tempRoot);
    await assertTarballHasNoWorkspaceSpecifiers(relativePackageDir, tarballPath);
  }

  const runtimeOutDir = path.join(tempRoot, "runtime-artifact");
  const runtimeTarballPath = await buildRuntimeArtifact(runtimeOutDir);
  await assertTarballHasNoWorkspaceSpecifiers("runtime-artifact", runtimeTarballPath);

  console.log("packed manifests verified");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function packPackage(packageDir, outDir) {
  const { stdout } = await runCommand("pnpm", ["pack", "--pack-destination", outDir], {
    cwd: packageDir,
  });
  const tarballName = findLastTarballLine(stdout);
  if (!tarballName) {
    throw new Error(`Failed to determine tarball filename for ${packageDir}.`);
  }
  return path.isAbsolute(tarballName) ? tarballName : path.join(outDir, tarballName);
}

async function buildRuntimeArtifact(outDir) {
  const { stdout } = await runCommand("node", ["scripts/build-runtime-artifact.mjs", "--out", outDir], {
    cwd: repoRoot,
  });
  const tarballPath = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (!tarballPath) {
    throw new Error("Failed to determine runtime artifact tarball path.");
  }
  return tarballPath;
}

async function assertTarballHasNoWorkspaceSpecifiers(label, tarballPath) {
  const manifest = await readTarballManifest(tarballPath);
  const workspaceSpecifiers = collectWorkspaceProtocolSpecifiers(manifest);
  if (workspaceSpecifiers.length === 0) {
    return;
  }

  const formattedSpecifiers = workspaceSpecifiers
    .map(({ section, packageName, specifier }) => `${section}.${packageName}=${specifier}`)
    .join(", ");
  throw new Error(`${label} tarball still contains workspace protocol specifiers: ${formattedSpecifiers}`);
}

async function readTarballManifest(tarballPath) {
  const { stdout } = await runCommand("tar", ["-xOf", tarballPath, "package/package.json"], {
    cwd: repoRoot,
  });
  return JSON.parse(stdout);
}

function findLastTarballLine(stdout) {
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${String(code)}.${stderr ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}
