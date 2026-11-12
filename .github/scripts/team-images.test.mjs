import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("./team-images.sh", import.meta.url).pathname;
const sha = "a".repeat(40);
const version = "1.2.3";

// A fake registry: a published tag is a file holding the source revision it records.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "team-images-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "published"));
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DIR/calls"
name() { local ref=\${1##*/}; printf '%s' "\${ref%%[:@]*}"; }
case "$1 $2 \${3:-}" in
  "buildx imagetools inspect")
    [[ ! -f "$FAKE_DIR/unreachable" ]] || { echo 'dial tcp: i/o timeout' >&2; exit 1; }
    if [[ "$4" == --raw ]]; then
      file="$FAKE_DIR/published/$(name "$5")"
      [[ -f "$file" ]] || { echo "ERROR: $5: not found" >&2; exit 1; }
      printf '{"annotations":{"org.opencontainers.image.revision":"%s"}}\\n' "$(cat "$file")"
    else
      printf '{"digest":"sha256:%s"}\\n' "$(printf '%064d' 7)"
    fi ;;
  "buildx imagetools create")
    revision=$(printf '%s\\n' "$@" | sed -n 's/^index:org.opencontainers.image.revision=//p')
    printf '%s' "$revision" > "$FAKE_DIR/published/$(name "$5")" ;;
  "buildx create --use") ;;
  "buildx build --file")
    while [[ $# -gt 1 && "$1" != --metadata-file ]]; do shift; done
    printf '{"containerimage.digest":"sha256:%s"}' "$(printf '%064d' 1)" > "$2" ;;
  "login ghcr.io --username") ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (...args) => {
    const output = path.join(root, "github-output");
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DIR: root,
        GITHUB_OUTPUT: output,
        PATH: `${bin}:${process.env.PATH}`,
        SHA: sha,
        VERSION: version,
      },
    });
    const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      status: result.status,
      stderr: result.stderr,
      calls: read(path.join(root, "calls")),
      outputs: read(output),
    };
  };
  const publish = (name, revision = sha) =>
    writeFileSync(path.join(root, "published", name), revision);
  return { root, run, publish, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("builds each platform by digest, then tags one multi-arch index per image", () => {
  const f = fixture();
  try {
    const digests = path.join(f.root, "digests");
    let calls = "";
    for (const platform of ["linux/amd64", "linux/arm64"]) {
      const out = path.join(f.root, platform.replace("/", "-"));
      const built = f.run("build", platform, out);
      assert.equal(built.status, 0, built.stderr);
      calls = built.calls;
      cpSync(out, digests, { recursive: true });
    }
    const builds = calls.split("\n").filter((line) => line.startsWith("buildx build"));
    assert.equal(builds.length, 4);
    for (const target of ["host", "team-gateway"])
      for (const platform of ["linux/amd64", "linux/arm64"])
        assert.ok(
          builds.some(
            (line) =>
              line.includes(`--target ${target} `) &&
              line.includes(`--platform ${platform} `) &&
              line.includes(`OPENSTEER_SOURCE_REVISION=${sha}`) &&
              line.includes("push-by-digest=true"),
          ),
          `${target} ${platform}`,
        );
    const result = f.run("publish", digests);
    assert.equal(result.status, 0, result.stderr);
    const created = result.calls.split("\n").filter((line) => line.includes("imagetools create"));
    assert.equal(created.length, 2);
    for (const line of created) {
      assert.match(
        line,
        new RegExp(`--tag ghcr.io/steerlabs/opensteer-team-(host|gateway):${version} `),
      );
      assert.match(line, new RegExp(`index:org.opencontainers.image.revision=${sha}`));
      assert.equal(line.match(/@sha256:0{63}1/g)?.length, 2);
    }
    const digest = `sha256:${"7".padStart(64, "0")}`;
    assert.equal(
      result.outputs,
      `host_image=ghcr.io/steerlabs/opensteer-team-host@${digest}\n` +
        `gateway_image=ghcr.io/steerlabs/opensteer-team-gateway@${digest}\n`,
    );
  } finally {
    f.close();
  }
});

test("reruns and Stable reuse a version already published from the same source", () => {
  const f = fixture();
  try {
    f.publish("opensteer-team-host");
    f.publish("opensteer-team-gateway");
    assert.equal(f.run("build", "linux/arm64", path.join(f.root, "out")).status, 0);
    const result = f.run("publish", path.join(f.root, "empty"));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /buildx build|imagetools create/);
    assert.match(result.outputs, /^host_image=.*\ngateway_image=.*\n$/);
  } finally {
    f.close();
  }
});

test("never overwrites a version from another source or guesses when the registry fails", () => {
  for (const arrange of [
    (f) => f.publish("opensteer-team-host", "b".repeat(40)),
    (f) => writeFileSync(path.join(f.root, "unreachable"), ""),
  ]) {
    const f = fixture();
    try {
      arrange(f);
      assert.notEqual(f.run("build", "linux/amd64", path.join(f.root, "out")).status, 0);
      assert.notEqual(f.run("publish", path.join(f.root, "out")).status, 0);
      assert.doesNotMatch(
        f.run("publish", path.join(f.root, "out")).calls,
        /buildx build|imagetools create/,
      );
    } finally {
      f.close();
    }
  }
});
