/**
 * Package the Runner distribution a generated bare-host connection command
 * installs. Release CI assembles the Personal runtime bundle first; this cuts
 * the Runner subset out of that already-verified tree, so the two can never
 * disagree about what a Runner is made of.
 */
import { requiredEnvironmentValue } from "@opensteer/shared/envParsing";
import path from "node:path";
import { readPersonalRuntimeRelease } from "../src/releases/personal-runtime-release.js";
import { packRunnerDistribution } from "./runner-distribution.js";

async function main(): Promise<void> {
  const source = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PERSONAL_RUNTIME_SOURCE",
      "OPENSTEER_PERSONAL_RUNTIME_SOURCE is required to package a Runner distribution.",
    ),
  );
  const outputDirectory = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_RUNNER_DISTRIBUTION_OUTPUT",
      "OPENSTEER_RUNNER_DISTRIBUTION_OUTPUT is required to package a Runner distribution.",
    ),
  );
  const version = requiredEnvironmentValue(
    process.env,
    "OPENSTEER_RELEASE_VERSION",
    "OPENSTEER_RELEASE_VERSION is required to package a Runner distribution.",
  );
  const sourceRevision = requiredEnvironmentValue(
    process.env,
    "OPENSTEER_SOURCE_REVISION",
    "OPENSTEER_SOURCE_REVISION is required to package a Runner distribution.",
  );
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error("A Runner distribution requires one canonical source revision.");
  }
  // The same verifier the packaged Desktop runs: a bundle that would not start
  // must not become the thing lent computers install.
  const release = await readPersonalRuntimeRelease(source);
  const packed = await packRunnerDistribution({
    identity: { sourceRevision, version },
    manifest: release.manifest,
    outputDirectory,
    source,
  });
  process.stdout.write(`${packed.archivePath} ${packed.sha256}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
