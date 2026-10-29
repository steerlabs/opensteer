import { builtinModules } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const providedByElectron = new Set(["electron"]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const importPattern = /\b(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/gu;
const unresolved = new Map();

for (const filePath of await outputFiles(path.join(desktopDirectory, "dist"))) {
  const source = await readFile(filePath, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    // Bundled data can contain `from "…"` text (tldts's suffix table has keys
    // like "from"); only a string shaped like a module specifier is an import.
    if (!specifier || !/^(?:[./@a-z0-9]|node:)[^\s,]*$/u.test(specifier)) continue;
    if (path.basename(filePath) === "preload.cjs" && specifier && specifier !== "electron") {
      const files = unresolved.get(`sandboxed preload import ${specifier}`) ?? [];
      files.push(path.relative(desktopDirectory, filePath));
      unresolved.set(`sandboxed preload import ${specifier}`, files);
      continue;
    }
    if (
      !specifier ||
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      builtins.has(specifier)
    ) {
      continue;
    }
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/", 1)[0];
    if (
      !packageName ||
      providedByElectron.has(packageName) ||
      runtimeDependencies.has(packageName)
    ) {
      continue;
    }
    const files = unresolved.get(packageName) ?? [];
    files.push(path.relative(desktopDirectory, filePath));
    unresolved.set(packageName, files);
  }
}

if (unresolved.size > 0) {
  const details = [...unresolved.entries()]
    .map(([packageName, files]) => `${packageName} (${[...new Set(files)].join(", ")})`)
    .join(", ");
  throw new Error(
    `Desktop build emitted undeclared runtime dependencies: ${details}. Bundle them or declare them in dependencies.`,
  );
}

async function outputFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:c?js|mjs)$/u.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}
