import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkStableApi } from "./ci-stable-api.mjs";

void test("each minimum admits the latest published Stable, selected numerically, with no insider fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stable-api-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  const authority = path.join(root, "packages/deployment-authority/src/authority.ts");
  const write = (team, teamMinimum = team, personal) =>
    writeFileSync(
      authority,
      `export const teamApiVersion = ${team};\nexport const minimumTeamApiVersion = ${teamMinimum};\n` +
        (personal
          ? `export const hostApiVersion = ${personal[0]};\nexport const minimumHostApiVersion = ${personal[1]};\n`
          : "export const hostApiVersion = 57;\n"),
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
    write(6, 4, [60, 58]);
    git("commit", "-am", "new insider");
    git("tag", "--no-sign", "v0.1.999-insider");
    git("tag", "--no-sign", "desktop-v0.1.999-insider");
    // Stable predates the personal window: only the team floor applies.
    assert.deepEqual(checkStableApi(root), {
      tag: "desktop-v0.1.10",
      team: { published: 4, minimum: 4 },
      personal: null,
    });
    write(6, 5, [60, 58]);
    assert.throws(
      () => checkStableApi(root),
      /minimumTeamApiVersion 5.*desktop-v0.1.10.*teamApiVersion 4/s,
    );
    write(4, 4, [59, 58]);
    git("commit", "-am", "Stable with the personal window");
    git("tag", "--no-sign", "desktop-v0.1.11");
    write(4, 4, [61, 59]);
    assert.deepEqual(checkStableApi(root).personal, { published: 59, minimum: 59 });
    write(4, 4, [61, 60]);
    assert.throws(
      () => checkStableApi(root),
      /minimumHostApiVersion 60.*desktop-v0.1.11.*hostApiVersion 59/s,
    );
    write(4, 4, [62, 62]);
    assert.deepEqual(checkStableApi(root).personal, { published: 59, minimum: 62 });
    write(4, 4, [63, 63]);
    assert.throws(
      () => checkStableApi(root),
      /minimumHostApiVersion 63.*desktop-v0.1.11.*hostApiVersion 59/s,
    );
    write(5, 5, [62, 62]);
    assert.throws(
      () => checkStableApi(root),
      /minimumTeamApiVersion 5.*desktop-v0.1.11.*teamApiVersion 4/s,
    );
    writeFileSync(authority, "export const minimumTeamApiVersion = unknown;\n");
    assert.throws(() => checkStableApi(root), /Cannot read minimumTeamApiVersion/);
    git("tag", "-d", "desktop-v0.1.9", "desktop-v0.1.10", "desktop-v0.1.11");
    assert.throws(() => checkStableApi(root), /No published Stable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
