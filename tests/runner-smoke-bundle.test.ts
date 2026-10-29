import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { bundleRunnerSmokeHarness } from "../scripts/bundle-runner-smoke-harness.mjs";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Runner smoke harness bundle", () => {
  it("provides CommonJS dependencies with require inside the Node ESM bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-smoke-bundle-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "fixture.mjs");

    await bundleRunnerSmokeHarness({
      esbuild: resolve("node_modules/.bin/esbuild"),
      output,
      source: resolve("tests/runner-smoke-yaml-fixture.ts"),
    });

    await expect(execute(process.execPath, [output])).resolves.toMatchObject({
      stderr: "",
      stdout: "42",
    });
  });
});
