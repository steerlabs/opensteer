import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function registryCacheScope(root = process.cwd()) {
  const hash = createHash("sha256");
  for (const file of [
    "deploy/container/Containerfile",
    "deploy/container/docker-bake.hcl",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ])
    hash.update(await readFile(resolve(root, file)));
  return "linux-amd64-" + hash.digest("hex").slice(0, 24);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(await registryCacheScope());
