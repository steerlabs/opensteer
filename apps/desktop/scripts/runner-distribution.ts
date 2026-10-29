/**
 * Cut a Runner distribution out of an assembled Personal runtime bundle.
 *
 * A computer somebody lends over a generated connection command has no
 * Opensteer on it. The Personal runtime bundle already contains everything
 * that computer needs — the Runner launcher and its bundled service, the Node
 * interpreter they run on, the native filesystem helper, the Browser Harness, every harness
 * runtime the catalog ships (one executable, or a complete runtime tree) and the agent
 * skills — alongside a Host and a PostgreSQL distribution it does not. This packages exactly the first set as
 * one versioned per-platform archive, so installation can be a real step of
 * the connection instructions instead of an assumed executable.
 */
import { harnessCatalog, shipsHarnessRuntimeBytes } from "@opensteer/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonalRuntimeReleaseManifest } from "../src/releases/personal-runtime-release.js";
import { personalRuntimeLayout } from "./personal-runtime-layout.js";

export interface RunnerDistributionIdentity {
  /** The exact source revision the whole release is cut from. */
  readonly sourceRevision: string;
  readonly version: string;
}

export interface RunnerDistributionArtifact {
  readonly mode: "code" | "data" | "executable";
  readonly path: string;
}

/** `opensteer-runner-linux-amd64.tar.gz`: one archive per platform we build. */
export function runnerDistributionArtifactName(
  operatingSystem: PersonalRuntimeReleaseManifest["operatingSystem"],
  architecture: PersonalRuntimeReleaseManifest["architecture"],
): string {
  return `opensteer-runner-${operatingSystem}-${architecture}.tar.gz`;
}

/**
 * Everything the Runner resolves at startup, and nothing else. The Host, the
 * Web distribution and PostgreSQL stay behind: a lent
 * computer runs agents, and shipping it a Host it can never start would only
 * widen what an attacker finds on that disk.
 */
export function runnerDistributionArtifacts(
  manifest: PersonalRuntimeReleaseManifest,
): readonly RunnerDistributionArtifact[] {
  const required = new Map<string, RunnerDistributionArtifact["mode"]>([
    ["THIRD_PARTY_NOTICES.md", "data"],
    [manifest.entrypoints.runner, "executable"],
    [manifest.entrypoints.node, "executable"],
    [manifest.entrypoints.nativeFsHelper, "executable"],
    [manifest.entrypoints.browserHarness, "executable"],
    [personalRuntimeLayout.browserHarnessScript, "code"],
    ...harnessCatalog
      .filter(shipsHarnessRuntimeBytes)
      .filter((entry) => entry.runtime.shape === "file")
      .map(
        (entry) =>
          [manifest.harnesses[entry.kind], "executable"] satisfies [
            string,
            RunnerDistributionArtifact["mode"],
          ],
      ),
    [personalRuntimeLayout.runnerScript, "code"],
  ]);
  const declared = new Map(manifest.files.map((file) => [file.path, file.mode]));
  for (const [artifactPath, mode] of required) {
    if (declared.get(artifactPath) !== mode) {
      throw new Error(`The Personal runtime bundle does not declare ${artifactPath} as ${mode}.`);
    }
  }
  // The Runner loads the native image decoder staged beside its script to fit
  // every image it hands an engine.
  const modulesPrefix = `${personalRuntimeLayout.serviceModules}/`;
  const modules = manifest.files.filter((file) => file.path.startsWith(modulesPrefix));
  if (!modules.some((file) => file.path === `${modulesPrefix}sharp/package.json`)) {
    throw new Error(`The Personal runtime bundle does not declare ${modulesPrefix}sharp.`);
  }
  const skillsPrefix = `${manifest.assets.agentSkills}/`;
  const skills = manifest.files.filter((file) => file.path.startsWith(skillsPrefix));
  if (skills.length === 0) {
    throw new Error("The Personal runtime bundle declares no agent skills.");
  }
  // A staged tree is a directory, not a file: its program resolves helper
  // programs, modules and resources relative to itself — the Codex tree
  // carries the code-mode host, ripgrep and their resources; the Pi tree is an
  // npm package and the packages its entry script imports — so the whole
  // staged directory travels or none of it works. An engine the person
  // installs stages nothing, so a lent computer finds it the same way the
  // Runner does: where its own installer put it.
  const trees: RunnerDistributionArtifact[] = [];
  for (const entry of harnessCatalog) {
    if (!shipsHarnessRuntimeBytes(entry)) continue;
    const runtime = entry.runtime;
    if (runtime.shape === "file") continue;
    const treePrefix = `${runtime.treeRoot}/`;
    const tree = manifest.files.filter((file) => file.path.startsWith(treePrefix));
    if (tree.length === 0) {
      throw new Error(`The Personal runtime bundle declares no ${entry.label} runtime.`);
    }
    const programMode = runtime.shape === "script" ? "code" : "executable";
    if (tree.find((file) => file.path === manifest.harnesses[entry.kind])?.mode !== programMode) {
      throw new Error(
        `The Personal runtime bundle does not declare ${manifest.harnesses[entry.kind]} as ${programMode}.`,
      );
    }
    trees.push(...tree.map((file) => ({ mode: file.mode, path: file.path })));
  }
  return [
    ...[...required].map(([artifactPath, mode]) => ({ mode, path: artifactPath })),
    ...modules.map((file) => ({ mode: file.mode, path: file.path })),
    ...skills.map((file) => ({ mode: file.mode, path: file.path })),
    ...trees,
  ].sort((left, right) => (left.path < right.path ? -1 : 1));
}

export interface PackedRunnerDistribution {
  readonly archivePath: string;
  readonly artifactName: string;
  readonly sha256: string;
}

/**
 * Writes one gzipped tar of the selected subset plus a `runner-release.json`
 * that names the exact release it was cut from. The archive digest is the
 * publication digest, returned for the release publisher to verify.
 */
export async function packRunnerDistribution(input: {
  readonly identity: RunnerDistributionIdentity;
  readonly manifest: PersonalRuntimeReleaseManifest;
  readonly outputDirectory: string;
  readonly source: string;
}): Promise<PackedRunnerDistribution> {
  const artifacts = runnerDistributionArtifacts(input.manifest);
  const artifactName = runnerDistributionArtifactName(
    input.manifest.operatingSystem,
    input.manifest.architecture,
  );
  const staging = path.join(input.outputDirectory, `.${artifactName}.tmp-${process.pid}`);
  await rm(staging, { force: true, recursive: true });
  try {
    for (const artifact of artifacts) {
      const destination = path.join(staging, ...artifact.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(input.source, ...artifact.path.split("/")), destination);
    }
    await writeFile(
      path.join(staging, "runner-release.json"),
      `${JSON.stringify({
        architecture: input.manifest.architecture,
        assets: { agentSkills: input.manifest.assets.agentSkills },
        entrypoints: {
          browserHarness: input.manifest.entrypoints.browserHarness,
          nativeFsHelper: input.manifest.entrypoints.nativeFsHelper,
          node: input.manifest.entrypoints.node,
          runner: input.manifest.entrypoints.runner,
        },
        files: artifacts,
        harnesses: input.manifest.harnesses,
        operatingSystem: input.manifest.operatingSystem,
        release: input.identity,
        runnerVersion: input.manifest.runnerVersion,
        schemaVersion: 2,
      })}\n`,
      { encoding: "utf8", mode: 0o444 },
    );
    const archivePath = path.join(input.outputDirectory, artifactName);
    await mkdir(input.outputDirectory, { recursive: true });
    await rm(archivePath, { force: true });
    await run("tar", ["-czf", archivePath, "-C", staging, "."]);
    return {
      archivePath,
      artifactName,
      sha256: createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex"),
    };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function run(executable: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], { shell: false, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}
