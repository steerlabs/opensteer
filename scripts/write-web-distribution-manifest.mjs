import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function writeWebDistributionManifest({ buildId, directory, hostVersion }) {
  const resolvedDirectory = path.resolve(directory);
  const files = [];
  for (const relativePath of await distributionFiles(resolvedDirectory)) {
    if (relativePath === "opensteer-web.json") continue;
    const bytes = await readFile(path.join(resolvedDirectory, ...relativePath.split("/")));
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Web distribution does not contain index.html");
  }
  const embedsBuildIdentity = await Promise.all(
    files
      .filter((file) => file.path.endsWith(".js"))
      .map(async (file) =>
        (await readFile(path.join(resolvedDirectory, ...file.path.split("/")))).includes(
          Buffer.from(buildId),
        ),
      ),
  );
  if (!embedsBuildIdentity.some(Boolean)) {
    throw new Error("Web distribution does not embed its expected build identity");
  }
  await writeFile(
    path.join(resolvedDirectory, "opensteer-web.json"),
    `${JSON.stringify({ buildId, files, hostVersion, schemaVersion: 1 })}\n`,
    { mode: 0o444 },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, hostVersion] = process.argv.slice(2);
  if (!directory || !hostVersion) {
    throw new Error("Usage: write-web-distribution-manifest.mjs <directory> <host-version>");
  }
  const { personalWebBuildId } = await import("../packages/protocol/src/common.ts");
  await writeWebDistributionManifest({ buildId: personalWebBuildId, directory, hostVersion });
}

async function distributionFiles(root, relativeDirectory = "") {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await distributionFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Web distribution contains a non-file entry: ${relativePath}`);
    }
  }
  return files.sort();
}
