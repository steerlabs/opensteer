// An image's code tree must not depend on who runs it (P0): on a pooled Cloud Computer the Host ran
// as 10002, and 23 directories its build staged at 0700 for 10001 stopped it at start. Each Home
// image's build runs deploy/container/assert-readable-tree.sh over its code tree.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const guard = join(root, "deploy/container/assert-readable-tree.sh");
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "code-tree-"));
});
afterEach(() => {
  spawnSync("chmod", ["-R", "u+rwX", work]);
  rmSync(work, { recursive: true, force: true });
});

const check = (...args: string[]) => spawnSync("sh", [guard, ...args], { encoding: "utf8" });

it("fails the build on a code tree only one uid can read, naming each path", () => {
  const app = join(work, "app");
  mkdirSync(join(app, "dist/node_modules/sharp/lib"), { recursive: true });
  writeFileSync(join(app, "dist/node_modules/sharp/package.json"), "{}");
  for (const directory of ["dist", "dist/node_modules", "dist/node_modules/sharp/lib"])
    chmodSync(join(app, directory), 0o755);
  chmodSync(join(app, "dist/node_modules/sharp/package.json"), 0o644);
  expect(check(app).status).toBe(0);
  // As the desktop staging makes them: a directory only its owner may enter.
  chmodSync(join(app, "dist/node_modules/sharp"), 0o700);
  const refused = check(app);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(join(app, "dist/node_modules/sharp"));
  chmodSync(join(app, "dist/node_modules/sharp"), 0o755);
  // A file only its owner may read.
  chmodSync(join(app, "dist/node_modules/sharp/package.json"), 0o600);
  expect(check(app).stderr).toContain("sharp/package.json");
});

it("with --root-owned, also refuses a tree the running user could change", () => {
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "main.js"), "");
  chmodSync(app, 0o755);
  chmodSync(join(app, "main.js"), 0o666);
  const refused = check("--root-owned", app);
  expect(refused.status).toBe(1);
  // Writable by others, and (here, not run as root) not root's.
  expect(refused.stderr).toContain(join(app, "main.js"));
});

/** The Containerfile's stage named `name`, up to the next FROM. */
function stage(name: string): string {
  const text = readFileSync(join(root, "deploy/container/Containerfile"), "utf8");
  const start = text.search(new RegExp(`^FROM [^\\n]+ AS ${name}$`, "mu"));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + 1).search(/^FROM /mu);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

it("runs the guard in every Home image after its copies, before its release record and its user", () => {
  for (const name of [
    "host",
    "runner",
    "browser-egress",
    "channel-runtime",
    "browser-runtime",
    "home-gateway",
  ]) {
    const text = stage(name);
    const lines = text.split("\n");
    const guarded = lines.findIndex((line) => line.includes("sh /tmp/assert-readable-tree.sh"));
    const record = lines.findLastIndex((line) => line.includes("/release/release.json "));
    const lastCopy = lines.findLastIndex(
      (line, index) => line.startsWith("COPY ") && index !== record,
    );
    const lastUser = lines.findLastIndex((line) => line.startsWith("USER "));
    expect(guarded, name).toBeGreaterThan(lastCopy);
    // The guard only reads: the release record stays each image's last layer.
    expect(record, name).toBeGreaterThan(guarded);
    expect(`${lines[guarded - 1]}${lines[guarded]}`, name).not.toContain("chmod");
    expect(lastUser, name).toBeGreaterThan(guarded);
    expect(lines[lastUser], name).not.toBe("USER root");
  }
  // The Host's code is root's: the user it runs as may not change it.
  const host = stage("host");
  expect(host).toContain(
    "sh /tmp/assert-readable-tree.sh --root-owned /app /usr/local/share/opensteer",
  );
  expect(stage("host-build")).toContain("chmod -R a+rX,go-w /output/host");
  expect(stage("web-build")).toContain("chmod -R a+rX,go-w /source/apps/web/dist");
  expect(host).not.toMatch(/^COPY [^\n]*--chown=10001/mu);
});
