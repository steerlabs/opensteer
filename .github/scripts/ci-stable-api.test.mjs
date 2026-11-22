import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkStableApi } from "./ci-stable-api.mjs";

void test("the personal minimum admits the latest published Stable, selected numerically, with no insider fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stable-api-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  const authority = path.join(root, "packages/deployment-authority/src/authority.ts");
  const write = (personal) =>
    writeFileSync(
      authority,
      personal
        ? `export const hostApiVersion = ${personal[0]};\nexport const minimumHostApiVersion = ${personal[1]};\n`
        : "export const hostApiVersion = 57;\n",
    );
  try {
    git("init", "-b", "main");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci@opensteer.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(path.dirname(authority), { recursive: true });
    write();
    git("add", ".");
    git("commit", "-m", "Stable 3");
    git("tag", "--no-sign", "desktop-v0.1.9");
    write();
    git("commit", "--allow-empty", "-am", "Stable 4");
    git("tag", "--no-sign", "desktop-v0.1.10");
    write([60, 58]);
    git("commit", "-am", "new insider");
    git("tag", "--no-sign", "v0.1.999-insider");
    git("tag", "--no-sign", "desktop-v0.1.999-insider");
    // Stable predates the personal window: no floor applies.
    assert.deepEqual(checkStableApi(root), { tag: "desktop-v0.1.10", personal: null });
    write([59, 58]);
    git("commit", "-am", "Stable with the personal window");
    git("tag", "--no-sign", "desktop-v0.1.11");
    write([61, 59]);
    assert.deepEqual(checkStableApi(root).personal, { published: 59, minimum: 59 });
    write([61, 60]);
    assert.throws(
      () => checkStableApi(root),
      /minimumHostApiVersion 60.*desktop-v0.1.11.*hostApiVersion 59/s,
    );
    write([63, 63]);
    assert.throws(
      () => checkStableApi(root),
      /minimumHostApiVersion 63.*desktop-v0.1.11.*hostApiVersion 59/s,
    );
    write([65, 65]);
    assert.deepEqual(checkStableApi(root).personal, { published: 59, minimum: 65 });
    // Removing the team server is the second decided cutover.
    write([66, 66]);
    assert.deepEqual(checkStableApi(root).personal, { published: 59, minimum: 66 });
    write([67, 67]);
    assert.throws(
      () => checkStableApi(root),
      /minimumHostApiVersion 67.*desktop-v0.1.11.*hostApiVersion 59/s,
    );
    writeFileSync(authority, "export const minimumHostApiVersion = unknown;\n");
    assert.throws(() => checkStableApi(root), /Cannot read/);
    git("tag", "-d", "desktop-v0.1.9", "desktop-v0.1.10", "desktop-v0.1.11");
    assert.throws(() => checkStableApi(root), /No published Stable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
