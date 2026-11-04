import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { deriveReleaseVersion: deriveVersion, stampReleaseVersion } =
  require("../scripts/release-version.cjs") as typeof import("../scripts/release-version.cjs");
const { requireCanonicalReleaseIdentity } = require("../scripts/release-identity.cjs") as {
  requireCanonicalReleaseIdentity(
    root: string,
    environment: NodeJS.ProcessEnv,
  ): { version: string; sourceRevision: string };
};
const deriveReleaseVersion = (repositoryRoot: string, revision: string) =>
  deriveVersion({ repositoryRoot, revision });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function versionGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function history() {
  const root = await mkdtemp(path.join(tmpdir(), "release-version-"));
  roots.push(root);
  versionGit(root, "init", "-b", "main");
  versionGit(root, "config", "user.name", "Release Test");
  versionGit(root, "config", "user.email", "release-test@opensteer.invalid");
  versionGit(root, "config", "commit.gpgsign", "false");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.2.3" }, null, 2) + "\n",
  );
  await addCommit(root, "base");
  return root;
}
async function addCommit(root: string, text: string) {
  await writeFile(path.join(root, "change.txt"), text);
  versionGit(root, "add", ".");
  versionGit(root, "commit", "-m", text);
  return versionGit(root, "rev-parse", "HEAD");
}
async function changeVersion(root: string, version: string) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version }, null, 2) + "\n",
  );
}
it("counts first-parent commits, ignoring manifest edits that preserve the version", async () => {
  const root = await history();
  const base = versionGit(root, "rev-parse", "HEAD");
  expect(deriveReleaseVersion(root, base)).toBe("1.2.3");
  const first = await addCommit(root, "first");
  expect(deriveReleaseVersion(root, first)).toBe("1.2.4");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "renamed", version: "1.2.3" }, null, 2) + "\n",
  );
  const second = await addCommit(root, "manifest without version change");
  expect(deriveReleaseVersion(root, second)).toBe("1.2.5");
  expect(deriveReleaseVersion(root, first)).toBe("1.2.4");
});
it("resets the counter when the version value advances beyond the previous derived release", async () => {
  const root = await history();
  await addCommit(root, "first");
  await changeVersion(root, "1.3.0");
  const reset = await addCommit(root, "new base");
  expect(deriveReleaseVersion(root, reset)).toBe("1.3.0");
  expect(deriveReleaseVersion(root, await addCommit(root, "after reset"))).toBe("1.3.1");
});
it.each(["1.2.2", "1.2.4", "1.2.5-beta.1", "01.2.8", "1.2.9007199254740992"])(
  "refuses a decreasing, nonnumeric or unsafe base %s",
  async (version) => {
    const root = await history();
    await addCommit(root, "first");
    await changeVersion(root, version);
    const sha = await addCommit(root, "bad base");
    expect(() => deriveReleaseVersion(root, sha)).toThrow();
  },
);
it("accepts exactly the derived root version stamp through canonical release identity", async () => {
  const root = await history();
  const sha = await addCommit(root, "first");
  expect(stampReleaseVersion(root, sha, "1.2.4")).toBe("1.2.4");
  expect(
    requireCanonicalReleaseIdentity(root, {
      OPENSTEER_SOURCE_REVISION: sha,
      OPENSTEER_RELEASE_VERSION: "1.2.4",
    }),
  ).toEqual({ version: "1.2.4", sourceRevision: sha });
  expect(versionGit(root, "status", "--porcelain")).toBe("M package.json");
  expect(stampReleaseVersion(root, sha, "1.2.4")).toBe("1.2.4");
  expect(() => stampReleaseVersion(root, sha, "1.2.9")).toThrow("differs from derived");
});
it.each(["other field", "other file", "wrong version"])(
  "refuses a stamped checkout with %s",
  async (mutation) => {
    const root = await history();
    const sha = await addCommit(root, "first");
    stampReleaseVersion(root, sha);
    if (mutation === "other file") await writeFile(path.join(root, "change.txt"), "dirty");
    else {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      if (mutation === "other field") manifest.name = "changed";
      else manifest.version = "1.2.9";
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    expect(() => requireCanonicalReleaseIdentity(root, { OPENSTEER_SOURCE_REVISION: sha })).toThrow(
      /clean source checkout/,
    );
  },
);
it("refuses nonlinear history for derivation and the dirty-workspace exception", async () => {
  const root = await history();
  versionGit(root, "checkout", "-b", "side");
  await writeFile(path.join(root, "side.txt"), "side");
  versionGit(root, "add", ".");
  versionGit(root, "commit", "-m", "side");
  versionGit(root, "checkout", "main");
  await addCommit(root, "main");
  versionGit(root, "merge", "--no-ff", "side", "-m", "merge");
  const sha = versionGit(root, "rev-parse", "HEAD");
  expect(() => deriveReleaseVersion(root, sha)).toThrow("linear");
  await changeVersion(root, "1.2.5");
  expect(() => requireCanonicalReleaseIdentity(root, { OPENSTEER_SOURCE_REVISION: sha })).toThrow(
    "linear",
  );
});

it("the CommonJS CLI emits exactly one version line and fails closed for unknown or short revisions", async () => {
  const root = await history();
  const sha = await addCommit(root, "first");
  const cli = path.resolve("scripts/release-version.cjs");
  const result = spawnSync(process.execPath, [cli, sha], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("1.2.4\n");
  expect(result.stderr).toBe("");
  for (const revision of [sha.slice(0, 8), "f".repeat(40)]) {
    const failure = spawnSync(process.execPath, [cli, revision], { cwd: root, encoding: "utf8" });
    expect(failure.status).not.toBe(0);
    expect(failure.stdout).toBe("");
    expect(failure.stderr.length).toBeGreaterThan(0);
  }
});

it("refuses unreadable manifests and shallow histories", async () => {
  const root = await history();
  const sha = await addCommit(root, "first");
  const shallow = await mkdtemp(path.join(tmpdir(), "release-version-shallow-"));
  roots.push(shallow);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, shallow]);
  expect(() => deriveReleaseVersion(shallow, sha)).toThrow("shallow");
  await rm(path.join(root, "package.json"));
  versionGit(root, "add", ".");
  versionGit(root, "commit", "-m", "missing manifest");
  expect(() => deriveReleaseVersion(root, versionGit(root, "rev-parse", "HEAD"))).toThrow();
});
