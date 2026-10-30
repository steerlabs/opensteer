/** Local commit objects only. No checkout, remotes, pushes or version environment override. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
const base = z
  .string()
  .regex(/^[a-f0-9]{40}$/u)
  .parse(process.argv[2]);
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u)
  .parse(process.argv[3]);
const [major, minor, patch] = version.split(".").map(Number);
if (minor! > 999 || patch! > 998 || major! > 2146)
  throw new Error(
    "Version pair must fit Agent Phone versionCode (minor <= 999, patch <= 998, major <= 2146)",
  );
const versions = [version, `${major}.${minor}.${patch! + 1}`];
const temp = mkdtempSync(path.join(tmpdir(), "opensteer-version-pair-"));
const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, "index") };
const git = (args: string[], input?: string) =>
  execFileSync("git", args, { encoding: "utf8", env, input }).trim();
const branch = `scratch/public-download-${Date.now()}-never-push`;
try {
  const commits = [];
  let parent = base;
  for (const v of versions) {
    git(["read-tree", base]);
    const manifest = JSON.parse(git(["show", `${base}:package.json`]));
    manifest.version = v;
    const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(manifest, null, 2) + "\n");
    git(["update-index", "--cacheinfo", `100644,${blob},package.json`]);
    const tree = git(["write-tree"]);
    const commit =
      tree === git(["rev-parse", `${parent}^{tree}`])
        ? parent
        : git(
            ["commit-tree", tree, "-p", parent],
            `Private public-download test ${v}; never push or merge\n`,
          );
    commits.push({ version: v, revision: commit });
    parent = commit;
  }
  git(["update-ref", `refs/heads/${branch}`, parent]);
  console.log(JSON.stringify({ branch, n: commits[0], next: commits[1] }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
