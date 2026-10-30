import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneCompletedBuild } from "../scripts/public-download/build-cleanup.js";

test("completed build pruning removes its registered source and extractions while preserving verified archives and receipts", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "opensteer-build-prune-")));
  const repository = path.join(root, "repository");
  mkdirSync(repository);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(["init", "--quiet"]);
    writeFileSync(path.join(repository, "tracked"), "fixture");
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const revision = git(["rev-parse", "HEAD"]),
      directory = path.join(root, "builds", revision, "stable");
    mkdirSync(directory, { recursive: true });
    const source = path.join(directory, "source");
    git(["worktree", "add", "--detach", source, revision]);
    const zip = path.join(directory, "Opensteer-mac-arm64.zip");
    writeFileSync(zip, "verified archive");
    const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
    writeFileSync(
      path.join(directory, "build.json"),
      JSON.stringify({ revision, channel: "stable", zip }),
    );
    writeFileSync(path.join(directory, "notary.json"), JSON.stringify({ status: "Accepted" }));
    writeFileSync(path.join(directory, "archive-check.json"), JSON.stringify({ sha256 }));
    for (const name of ["personal-runtime", "archive-verification-fixture", "agent-phone"])
      mkdirSync(path.join(directory, name));
    const receipt = path.join(directory, "agent-phone/agent-phone-release.json");
    writeFileSync(receipt, "receipt");
    writeFileSync(path.join(directory, "agent-phone/opensteer-agent-phone.apk"), "redundant apk");
    writeFileSync(zip, "tampered archive");
    await expect(pruneCompletedBuild(directory)).rejects.toThrow(/checksum/iu);
    expect(existsSync(source)).toBe(true);
    writeFileSync(zip, "verified archive");
    await pruneCompletedBuild(directory);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(path.join(directory, "personal-runtime"))).toBe(false);
    expect(existsSync(path.join(directory, "archive-verification-fixture"))).toBe(false);
    expect(existsSync(path.join(directory, "agent-phone/opensteer-agent-phone.apk"))).toBe(false);
    expect(readFileSync(receipt, "utf8")).toBe("receipt");
    expect(readFileSync(zip, "utf8")).toBe("verified archive");
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(source);
    await pruneCompletedBuild(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
