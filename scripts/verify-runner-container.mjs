#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { bundleRunnerSmokeHarness } from "./bundle-runner-smoke-harness.mjs";

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
// The smoke proves the Runner-owned sandbox with the module that ships, not a
// copy of its arguments: the source is bundled here and mounted into the image.
const harnessSandbox = join(temporaryDirectory, "harness-sandbox.mjs");
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
  await bundleRunnerSmokeHarness({
    esbuild: resolve(repositoryRoot, "node_modules/.bin/esbuild"),
    output: harnessSandbox,
    source: resolve(repositoryRoot, "apps/runner/src/sandbox/harness-sandbox.ts"),
  });
  await execute("docker", ["pull", image], { timeout: 300_000 });
  const result = await execute(
    "docker",
    [
      "run",
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
      `type=bind,source=${harnessSandbox},target=/tmp/harness-sandbox.mjs,readonly`,
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
