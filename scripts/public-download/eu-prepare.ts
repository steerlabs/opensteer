import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sha256File } from "@opensteer/shared/fileDigest";
import { prepare } from "../desktop-public-release.js";
import { journeyInput, releaseAsset } from "./evidence.js";
import { runBounded } from "../command-runner.js";
import { journeySigning } from "./signing.js";
import { journeyWorkDirectory } from "./work-directory.js";
import type { draftReceipt } from "./draft.js";

export async function prepareFixtures(
  inputs: string,
  draft: z.infer<typeof draftReceipt>,
  signal: AbortSignal,
) {
  const work = journeyWorkDirectory(),
    root = path.resolve(import.meta.dirname, "../..");
  const git = (args: string[], options: Parameters<typeof execFileSync>[2] = {}) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, ...options })
      .toString()
      .trim();
  assert.equal(git(["status", "--porcelain"]), "", "Tooling checkout must be clean");
  git(["cat-file", "-e", `${draft.sourceSha}^{commit}`]);
  const scratch = mkdtempSync(path.join(work, "builds/next-control-"));
  let revision: string;
  try {
    const pkg = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(git(["show", `${draft.sourceSha}:package.json`])));
    const parts = draft.version.split(".");
    pkg.version = `${parts[0]}.${parts[1]}.${BigInt(parts[2]!) + 1n}`;
    const blob = git(["hash-object", "-w", "--stdin"], {
      input: JSON.stringify(pkg, null, 2) + "\n",
    });
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
    git(["read-tree", draft.sourceSha], { env });
    git(["update-index", "--cacheinfo", `100644,${blob},package.json`], { env });
    const tree = git(["write-tree"], { env });
    revision = git([
      "commit-tree",
      tree,
      "-p",
      draft.sourceSha,
      "-m",
      "test: scratch draft update fixture; never push",
    ]);
    git([
      "update-ref",
      `refs/heads/scratch/draft-update-${path.basename(inputs)}-never-push`,
      revision,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  await runBounded(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/public-download/build-next.ts",
      "--revision",
      revision,
      "--base-sha",
      draft.sourceSha,
      "--base-version",
      draft.version,
      "--channel",
      draft.channel,
    ],
    { cwd: root, signal, timeoutMs: 60 * 60_000 },
  );
  const olderSha = "923a303e24e01c3f22590d743c47f37eb5b130e2";
  const releases = [];
  for (const sha of [revision, olderSha]) {
    const directory = path.join(work, "builds", sha, draft.channel);
    const build = z
      .object({
        revision: z.literal(sha),
        channel: z.literal(draft.channel),
        version: z.string(),
        zip: z.string(),
      })
      .parse(JSON.parse(readFileSync(path.join(directory, "build.json"), "utf8")));
    const run = (exe: string, args: readonly string[], options: Parameters<typeof runBounded>[2]) =>
      runBounded(exe, args, { ...options, signal });
    // The release tool validates signature, identity, staple, public provider and frozen bytes.
    if (sha === revision)
      await prepare(
        {
          channel: draft.channel,
          appZip: build.zip,
          version: build.version,
          sourceSha: sha,
          out: path.join(inputs, releaseAsset(draft.channel, build.version).tag),
        },
        run,
      );
    else {
      const expected = z
        .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
        .parse(JSON.parse(readFileSync(path.join(directory, "archive-check.json"), "utf8")));
      assert.equal(await sha256File(build.zip), expected.sha256, "Older signed fixture changed");
      const asset = releaseAsset(draft.channel, build.version),
        target = path.join(inputs, asset.tag);
      mkdirSync(target);
      copyFileSync(build.zip, path.join(target, asset.zip));
      writeFileSync(path.join(target, "SHA256SUMS"), `${expected.sha256}  ${asset.zip}\n`);
    }
    copyFileSync(path.join(directory, "build.json"), path.join(inputs, `${sha}-build.json`));
    releases.push({ version: build.version, revision: sha });
  }
  const input = journeyInput.parse({
    n: { version: draft.version, revision: draft.sourceSha },
    next: releases[0],
    older: releases[1],
  });
  const metadata = journeySigning().metadata;
  writeFileSync(
    path.join(inputs, "input.json"),
    JSON.stringify({ ...input, draft, metadata }, null, 2),
  );
  return { input, metadata };
}
