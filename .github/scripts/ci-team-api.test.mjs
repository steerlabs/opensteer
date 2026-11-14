import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkStableTeamApi } from "./ci-team-api.mjs";

void test("the minimum admits the latest published Stable, selected numerically, with no insider fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "team-api-stable-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  const authority = path.join(root, "packages/deployment-authority/src/authority.ts");
  const write = (version, minimum = version) =>
    writeFileSync(
      authority,
      `export const teamApiVersion = ${version};\nexport const minimumTeamApiVersion = ${minimum};\n`,
    );
  try {
    git("init", "-b", "main");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci@opensteer.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(path.dirname(authority), { recursive: true });
    write(3);
    git("add", ".");
    git("commit", "-m", "Stable 3");
    git("tag", "--no-sign", "desktop-v0.1.9");
    write(4);
    git("commit", "-am", "Stable 4");
    git("tag", "--no-sign", "desktop-v0.1.10");
    write(6, 4);
    git("commit", "-am", "new insider");
    git("tag", "--no-sign", "v0.1.999-insider");
    git("tag", "--no-sign", "desktop-v0.1.999-insider");
    assert.equal(checkStableTeamApi(root).tag, "desktop-v0.1.10");
    write(6, 5);
    assert.throws(
      () => checkStableTeamApi(root),
      /minimumTeamApiVersion 5.*desktop-v0.1.10.*teamApiVersion 4/s,
    );
    write(6, 3);
    assert.doesNotThrow(() => checkStableTeamApi(root));
    writeFileSync(authority, "export const minimumTeamApiVersion = unknown;\n");
    assert.throws(() => checkStableTeamApi(root), /Cannot read minimumTeamApiVersion/);
    git("tag", "-d", "desktop-v0.1.9", "desktop-v0.1.10");
    assert.throws(() => checkStableTeamApi(root), /No published Stable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
