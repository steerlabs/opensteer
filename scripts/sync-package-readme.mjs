import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(repoRoot, "README.md");
const targetPath = path.join(repoRoot, "packages", "opensteer", "README.md");
const repoBlobBaseUrl = "https://github.com/steerlabs/opensteer/blob/main";
const generatedBanner =
  "<!-- This file is generated from the repository README. Run `node scripts/sync-package-readme.mjs`. -->";

const sourceReadme = await readFile(sourcePath, "utf8");
const syncedReadme = `${generatedBanner}\n\n${rewriteRelativeLinks(sourceReadme)}`;

if (process.argv.includes("--check")) {
  const currentReadme = await readFile(targetPath, "utf8");
  if (currentReadme !== syncedReadme) {
    console.error("packages/opensteer/README.md is out of sync with README.md");
    process.exitCode = 1;
  } else {
    console.log("packages/opensteer/README.md is in sync with README.md");
  }
} else {
  await writeFile(targetPath, syncedReadme, "utf8");
}

function rewriteRelativeLinks(markdown) {
  return markdown.replaceAll(/\]\((\.\/[^)]+)\)/g, (match, relativePath) => {
    const normalizedPath = relativePath.slice(2);
    return `](${repoBlobBaseUrl}/${normalizedPath})`;
  });
}
