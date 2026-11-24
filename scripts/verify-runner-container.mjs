#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2];
const appArmorProfile = process.env.OPENSTEER_RUNNER_SMOKE_APPARMOR_PROFILE ?? "unconfined";
if (!image || process.argv.length !== 3) {
  throw new Error("usage: verify-runner-container.mjs <image-reference>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-smoke-"));
const profile = join(temporaryDirectory, "runner.json");
const smoke = resolve(repositoryRoot, "deploy/container/runner-runtime-smoke.mjs");
// The smoke proves Stop with the Runner's own containment module, bundled here.
const containment = join(temporaryDirectory, "execution-containment.mjs");
const container = `opensteer-runner-smoke-${randomUUID()}`;

try {
  await execute(
    process.execPath,
    [
      resolve(repositoryRoot, "deploy/container/compile-seccomp-profile.mjs"),
      resolve(repositoryRoot, "deploy/container/chromium-seccomp.json"),
      profile,
      "amd64",
      "CAP_DAC_READ_SEARCH",
      "CAP_SYS_ADMIN",
    ],
    { timeout: 10_000 },
  );
  await execute(
    resolve(repositoryRoot, "node_modules/.bin/esbuild"),
    [
      resolve(repositoryRoot, "apps/runner/src/runtime/execution-containment.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      // `yaml` is CommonJS inside: its guarded requires need a module-local one.
      '--banner:js=import { createRequire as __opensteerCreateRequire } from "node:module"; const require = __opensteerCreateRequire(import.meta.url);',
      `--outfile=${containment}`,
    ],
    { timeout: 60_000 },
  );
  await execute("docker", ["pull", image], { timeout: 300_000 });
  const result = await execute(
    "docker",
    [
      "run",
      // The Runner image starts under tini, which reaps what a stopped Run leaves.
      "--init",
      "--name",
      container,
      "--platform",
      "linux/amd64",
      "--user",
      "10001:10001",
      "--read-only",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "DAC_READ_SEARCH",
      "--security-opt",
      `apparmor=${appArmorProfile}`,
      "--security-opt",
      `seccomp=${profile}`,
      "--tmpfs",
      "/workspace:uid=10001,gid=10001,mode=0700",
      "--tmpfs",
      "/tmp:uid=10001,gid=10001,mode=1777",
      "--mount",
      `type=bind,source=${smoke},target=/tmp/runner-runtime-smoke.mjs,readonly`,
      "--mount",
      `type=bind,source=${containment},target=/tmp/execution-containment.mjs,readonly`,
      "--entrypoint",
      "node",
      image,
      "/tmp/runner-runtime-smoke.mjs",
    ],
    { timeout: 60_000 },
  );
  process.stdout.write(result.stdout);
} finally {
  await execute("docker", ["rm", "--force", container], { timeout: 10_000 }).catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}
