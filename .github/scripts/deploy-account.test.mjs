import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("./deploy-account.sh", import.meta.url).pathname;
const image = `registry.example/control-plane@sha256:${"a".repeat(64)}`;

// A real git history and a fake kubectl that records what the deploy did.
function fixture({ rollout = 0 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-account-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Deploy Test");
  git("config", "user.email", "deploy@opensteer.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(root, "deploy/account"), { recursive: true });
  const commit = (message) => {
    writeFileSync(path.join(root, "deploy/account/note"), message);
    git("add", ".");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const older = commit("older");
  const newer = commit("newer");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const kubectl = path.join(bin, "kubectl");
  writeFileSync(
    kubectl,
    `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  *"get deployment account"*) cat "$FAKE_DIR/live" 2>/dev/null || true ;;
  kustomize*) printf 'image: "@ACCOUNT_IMAGE@"\\nrevision: "@SOURCE_REVISION@"\\n' ;;
  "apply -f -") cat > "$FAKE_DIR/applied" ;;
  *"rollout status"*) exit ${rollout} ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (source, { live, ref = image } = {}) => {
    if (live) writeFileSync(path.join(root, "live"), live);
    const result = spawnSync("bash", [script, ref, source], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FAKE_DIR: root, PATH: `${bin}:${process.env.PATH}` },
    });
    const file = (name) =>
      existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
    return {
      status: result.status,
      stdout: result.stdout,
      applied: file("applied"),
      calls: file("calls"),
    };
  };
  return { older, newer, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("rolls a descendant of the live source out with the pinned image and its revision", () => {
  const f = fixture();
  try {
    const result = f.run(f.newer, { live: f.older });
    assert.equal(result.status, 0);
    assert.equal(result.applied, `image: "${image}"\nrevision: "${f.newer}"\n`);
    assert.doesNotMatch(result.calls, /rollout undo/);
  } finally {
    f.cleanup();
  }
});

test("a rerun of an older source leaves the newer live Account alone", () => {
  const f = fixture();
  try {
    const result = f.run(f.older, { live: f.newer });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /leaving it/);
    assert.doesNotMatch(result.calls, /apply|rollout/);
  } finally {
    f.cleanup();
  }
});

test("a failed rollout restores the serving release and fails the job", () => {
  const f = fixture({ rollout: 1 });
  try {
    const result = f.run(f.newer, { live: f.older });
    assert.equal(result.status, 1);
    assert.match(result.calls, /rollout undo deployment\/account/);
  } finally {
    f.cleanup();
  }
});

test("refuses unpinned images and live sources it cannot compare", () => {
  const f = fixture();
  try {
    assert.equal(f.run(f.newer, { ref: "registry.example/control-plane:latest" }).status, 1);
    const unknown = f.run(f.newer, { live: "b".repeat(40) });
    assert.equal(unknown.status, 1);
    assert.doesNotMatch(unknown.calls, /apply/);
  } finally {
    f.cleanup();
  }
});
