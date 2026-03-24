import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const publishOrder = ["packages/engine-playwright", "packages/engine-abp", "packages/opensteer"];

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const results = [];

for (const relativePackageDir of publishOrder) {
  const packageDir = path.join(repoRoot, relativePackageDir);
  const manifest = await readPackageManifest(packageDir);
  const published = await isPublished(manifest.name, manifest.version);

  if (published) {
    console.log(`skip ${manifest.name}@${manifest.version} (already published)`);
    results.push({
      name: manifest.name,
      version: manifest.version,
      status: "skipped",
    });
    continue;
  }

  const publishArgs = ["publish", "--provenance"];
  if (manifest.publishConfig?.access === "public") {
    publishArgs.push("--access", "public");
  }

  console.log(`publish ${manifest.name}@${manifest.version}`);
  await runCommand("npm", publishArgs, packageDir);
  results.push({
    name: manifest.name,
    version: manifest.version,
    status: "published",
  });
}

await writeSummary(results);

async function readPackageManifest(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return {
    name: packageJson.name,
    version: packageJson.version,
    publishConfig:
      packageJson.publishConfig &&
      typeof packageJson.publishConfig === "object" &&
      !Array.isArray(packageJson.publishConfig)
        ? packageJson.publishConfig
        : undefined,
  };
}

async function isPublished(packageName, version) {
  try {
    await execFileAsync("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
      cwd: repoRoot,
      env: process.env,
    });
    return true;
  } catch (error) {
    const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (combined.includes("E404") || combined.includes("Not Found")) {
      return false;
    }
    throw error;
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "null"}`));
    });
  });
}

async function writeSummary(entries) {
  if (!summaryPath) {
    return;
  }

  const lines = [
    "## npm publish",
    "",
    "| Package | Version | Status |",
    "| --- | --- | --- |",
    ...entries.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.status} |`),
    "",
  ];

  await writeFile(summaryPath, `${lines.join("\n")}`, "utf8");
}
