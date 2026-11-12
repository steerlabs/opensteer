import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("./deploy-team-provisioner.sh", import.meta.url).pathname;
const pinned = (name, digit) => `ghcr.io/steerlabs/${name}@sha256:${digit.repeat(64)}`;
const images = [
  pinned("opensteer-team-provisioner", "a"),
  pinned("opensteer-team-host", "b"),
  pinned("opensteer-team-gateway", "c"),
];

// A real git history and a fake kubectl that records what the deploy did.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-team-provisioner-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Deploy Test");
  git("config", "user.email", "deploy@opensteer.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = (message) => {
    writeFileSync(path.join(root, "note"), message);
    git("add", ".");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const older = commit("older");
  const newer = commit("newer");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "kubectl"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  *"get deployment team-provisioner"*) cat "$FAKE_DIR/live" 2>/dev/null || true ;;
  kustomize*) printf '"@PROVISIONER_IMAGE@" "@TEAM_HOST_IMAGE@" "@TEAM_GATEWAY_IMAGE@" "@SOURCE_REVISION@"\\n' ;;
  "apply -f -") cat > "$FAKE_DIR/applied" ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (source, { live, refs = images } = {}) => {
    if (live) writeFileSync(path.join(root, "live"), live);
    const result = spawnSync("bash", [script, ...refs, source], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FAKE_DIR: root, PATH: `${bin}:${process.env.PATH}` },
    });
    const file = (name) =>
      existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
    return { status: result.status, applied: file("applied"), calls: file("calls") };
  };
  return { older, newer, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("deploys the provisioner with the release's pinned team images", () => {
  const f = fixture();
  try {
    const result = f.run(f.newer, { live: f.older });
    assert.equal(result.status, 0);
    assert.equal(result.applied, `${images.map((image) => `"${image}"`).join(" ")} "${f.newer}"\n`);
  } finally {
    f.cleanup();
  }
});

test("refuses an unpinned team image and never rolls teams back to an older source", () => {
  const f = fixture();
  try {
    const unpinned = [images[0], "ghcr.io/steerlabs/opensteer-team-host:stable", images[2]];
    assert.equal(f.run(f.newer, { refs: unpinned }).status, 1);
    const older = f.run(f.older, { live: f.newer });
    assert.equal(older.status, 0);
    assert.doesNotMatch(older.calls, /apply|rollout/);
  } finally {
    f.cleanup();
  }
});
