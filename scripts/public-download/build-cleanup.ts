import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

export async function pruneCompletedBuild(directory: string) {
  assert(
    path.isAbsolute(directory) && realpathSync(directory) === directory,
    "Build directory must be physical and absolute",
  );
  const build = z
    .object({
      revision: z.string().regex(/^[a-f0-9]{40}$/u),
      channel: z.enum(["stable", "beta"]),
      zip: z.string(),
    })
    .parse(JSON.parse(readFileSync(path.join(directory, "build.json"), "utf8")));
  assert.equal(path.basename(directory), build.channel);
  assert.equal(path.basename(path.dirname(directory)), build.revision);
  const asset =
    build.channel === "stable" ? "Opensteer-mac-arm64.zip" : "Opensteer-Beta-mac-arm64.zip";
  assert.equal(build.zip, path.join(directory, asset));
  assert(lstatSync(build.zip).isFile() && realpathSync(build.zip) === build.zip);
  if (existsSync(path.join(directory, "notary.json"))) {
    z.object({ status: z.literal("Accepted") }).parse(
      JSON.parse(readFileSync(path.join(directory, "notary.json"), "utf8")),
    );
  } else {
    z.object({
      evidence: z.object({
        stapler: z.string().regex(/The validate action worked!/u),
        spctl: z.string().regex(/accepted[\s\S]*source=Notarized Developer ID/u),
      }),
    }).parse(JSON.parse(readFileSync(path.join(directory, "build.json"), "utf8")));
  }
  const expected = z
    .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
    .parse(JSON.parse(readFileSync(path.join(directory, "archive-check.json"), "utf8")));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(build.zip)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  assert.equal(sha256, expected.sha256, "Archive checksum changed; build cleanup refused");
  const source = path.join(directory, "source");
  const trees = readdirSync(directory).filter(
    (name) =>
      name === "personal-runtime" ||
      name === "ci-build" ||
      name.startsWith("archive-verification-") ||
      name === "Opensteer.app" ||
      name === "Opensteer Beta.app",
  );
  for (const name of ["source", "agent-phone", ...trees]) {
    const entry = path.join(directory, name);
    if (existsSync(entry))
      assert(
        lstatSync(entry).isDirectory() && !lstatSync(entry).isSymbolicLink(),
        `Refusing non-directory cleanup target: ${name}`,
      );
  }
  let common: string | undefined;
  if (existsSync(source)) {
    assert(lstatSync(path.join(source, ".git")).isFile(), "Expected a detached build worktree");
    const git = (args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    assert.equal(git(["rev-parse", "HEAD"]), build.revision);
    common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  }
  const removed: string[] = [];
  if (common) {
    // Remove exactly this registered snapshot; never prune other worktree records.
    execFileSync("git", ["--git-dir", common, "worktree", "remove", "--force", source], {
      stdio: "pipe",
    });
    removed.push("source");
  }
  for (const name of trees) {
    rmSync(path.join(directory, name), { recursive: true });
    removed.push(name);
  }
  const apk = path.join(directory, "agent-phone/opensteer-agent-phone.apk");
  if (existsSync(apk)) {
    assert(lstatSync(apk).isFile() && !lstatSync(apk).isSymbolicLink());
    rmSync(apk);
    removed.push("agent-phone/opensteer-agent-phone.apk");
  }
  const evidence = {
    revision: build.revision,
    channel: build.channel,
    zip: build.zip,
    sha256,
    removed,
    completedAt: new Date().toISOString(),
  };
  if (removed.length || !existsSync(path.join(directory, "cleanup.json")))
    writeFileSync(path.join(directory, "cleanup.json"), JSON.stringify(evidence, null, 2));
  return evidence;
}
