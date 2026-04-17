import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packagesDir = path.join(repoRoot, "packages");
const rootPackagePath = path.join(repoRoot, "package.json");

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const bannedPackagePattern = /(^|\/)ts-node(?:$|\/|-)/;
const bannedScriptPattern = /\bts-node(?:\b|\/|-)/;
const disallowedRootScriptPattern = /(^|\s)node\s+--import(?:=|\s+)tsx(?:[/\s]|$)/;

async function collectPackageJsonPaths() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packagePaths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(packagesDir, entry.name, "package.json");
    try {
      await access(filePath);
      packagePaths.push(filePath);
    } catch {}
  }
  return [rootPackagePath, ...packagePaths];
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}

const failures = [];
for (const packagePath of await collectPackageJsonPaths()) {
  const pkg = await readJson(packagePath);

  for (const field of dependencyFields) {
    const deps = pkg[field] ?? {};
    for (const name of Object.keys(deps)) {
      if (!bannedPackagePattern.test(name)) continue;
      failures.push(
        `${relative(packagePath)}: ${field} contains banned tooling dependency "${name}".`,
      );
    }
  }

  const scripts = pkg.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (bannedScriptPattern.test(command)) {
      failures.push(`${relative(packagePath)}: script "${name}" references banned ts-node usage.`);
    }
    if (packagePath === rootPackagePath && disallowedRootScriptPattern.test(command)) {
      failures.push(
        `${relative(packagePath)}: root script "${name}" should use "tsx" directly instead of "node --import tsx".`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Root tooling policy check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Root tooling policy check passed.");
