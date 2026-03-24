import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(repoRoot, "skills");
const targetDir = path.join(repoRoot, "packages", "opensteer", "skills");

await stat(path.join(sourceDir, "opensteer", "SKILL.md"));
await rm(targetDir, { force: true, recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
