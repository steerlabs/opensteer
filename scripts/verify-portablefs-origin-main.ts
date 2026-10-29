#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PortableFsMountCheckResultSchema,
  PortableFsVersionResultSchema,
} from "../packages/workspace-portablefs/src/schemas.js";
import { verifyPortableFsManagerIntegration } from "./verify-portablefs-manager-integration.js";

const portableFsRef = "origin/main";
const requiredMountHelp = [
  "--addr",
  "--mount-token",
  "--data-plane-transport",
  "--data-plane-server-name",
  "--client-cert",
  "--client-key",
  "--coherence",
  "--strategy",
  "--no-local-dirs",
  "--manager-url",
  "--manager-server-name",
  "--manager-ca",
  "--mount-enrollment-id",
  "--mount-enrollment-cert",
  "--authority-generation",
  "--auth-expires-at-ms",
  "--json",
] as const;
const forbiddenMountHelp = ["--mount-enrollment-expires-at-ms"] as const;
const requiredReauthorizationHelp = [
  "--client-cert",
  "--auth-expires-at-ms",
  "--auth-sequence",
  "--json",
] as const;
const requiredPortableFsFeature = "hosted-automatic-mount-reauthorization-v2";

export async function verifyPortableFsOriginMain(
  sourceDirectory = process.env.OPENSTEER_PORTABLEFS_SOURCE_DIR ??
    resolve(import.meta.dirname, "..", "..", "portablefs"),
): Promise<{
  readonly commit: string;
  readonly managerIntegration: Awaited<ReturnType<typeof verifyPortableFsManagerIntegration>>;
  readonly mountCheckState: string;
  readonly ref: typeof portableFsRef;
  readonly version: string;
}> {
  const source = await realpath(sourceDirectory).catch((error: unknown) => {
    throw new Error(`PortableFS source directory is unavailable: ${sourceDirectory}`, {
      cause: error,
    });
  });
  const commit = (
    await run("git", ["-C", source, "rev-parse", "--verify", `${portableFsRef}^{commit}`])
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`PortableFS ${portableFsRef} did not resolve to a commit`);
  }
  const sourceHead = (await run("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  if (sourceHead !== commit) {
    throw new Error(
      `PortableFS source HEAD ${sourceHead} does not match ${portableFsRef} ${commit}`,
    );
  }
  const sourceStatus = (await run("git", ["-C", source, "status", "--porcelain=v1"])).stdout;
  if (sourceStatus.trim()) throw new Error("PortableFS source working tree is not clean");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opensteer-portablefs-origin-main-"));
  try {
    await archiveGitRef(source, portableFsRef, temporaryDirectory);
    const verified = await verifyPortableFsSourceTree({
      label: portableFsRef,
      sourceDirectory: temporaryDirectory,
      temporaryDirectory,
    });
    return {
      commit,
      ...verified,
      ref: portableFsRef,
    };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

/** Builds and verifies one exact source tree without asserting how it was obtained. */
export async function verifyPortableFsSourceTree(options: {
  readonly label: string;
  readonly sourceDirectory: string;
  readonly temporaryDirectory: string;
}): Promise<{
  readonly managerIntegration: Awaited<ReturnType<typeof verifyPortableFsManagerIntegration>>;
  readonly mountCheckState: string;
  readonly version: string;
}> {
  const vcsDirectory = join(options.sourceDirectory, "vcs");
  const binary = join(options.temporaryDirectory, "portablefs");
  const managerBinary = join(options.temporaryDirectory, "portablefs-manager");
  await run("go", ["build", "-trimpath", "-o", binary, "./cmd/portablefs"], {
    cwd: vcsDirectory,
    maxOutputBytes: 16 * 1_024 * 1_024,
  });
  await run("go", ["build", "-trimpath", "-o", managerBinary, "./cmd/portablefs-manager"], {
    cwd: vcsDirectory,
    maxOutputBytes: 16 * 1_024 * 1_024,
  });

  const versionResult = await run(binary, ["version", "--json"]);
  const version = PortableFsVersionResultSchema.parse(JSON.parse(versionResult.stdout));
  if (!version.features?.includes(requiredPortableFsFeature)) {
    throw new Error(`PortableFS ${options.label} does not advertise ${requiredPortableFsFeature}`);
  }
  const help = await run(binary, ["help", "mount"]);
  for (const flag of requiredMountHelp) {
    if (!help.stdout.includes(flag)) {
      throw new Error(`PortableFS ${options.label} mount help is missing ${flag}`);
    }
  }
  for (const flag of forbiddenMountHelp) {
    if (help.stdout.includes(flag)) {
      throw new Error(`PortableFS ${options.label} mount help still advertises ${flag}`);
    }
  }
  const reauthorizationHelp = await run(binary, ["help", "reauthorize"]);
  for (const flag of requiredReauthorizationHelp) {
    if (!reauthorizationHelp.stdout.includes(flag)) {
      throw new Error(`PortableFS ${options.label} reauthorize help is missing ${flag}`);
    }
  }
  const managerHelp = await run(managerBinary, ["-h"]);
  if (!managerHelp.stderr.includes("-mount-enrollment-lease")) {
    throw new Error(`PortableFS ${options.label} Manager help is missing -mount-enrollment-lease`);
  }
  if (managerHelp.stderr.includes("-mount-enrollment-lifetime")) {
    throw new Error(
      `PortableFS ${options.label} Manager help still advertises -mount-enrollment-lifetime`,
    );
  }

  const mountCheckResult = await run(binary, ["mount-check", "--strategy", "auto", "--json"], {
    acceptedExitCodes: [0, 1],
  });
  const mountCheck = PortableFsMountCheckResultSchema.parse(JSON.parse(mountCheckResult.stdout));
  const managerIntegration = await verifyPortableFsManagerIntegration({
    managerBinary,
    sourceDirectory: options.sourceDirectory,
    temporaryDirectory: options.temporaryDirectory,
  });
  return {
    managerIntegration,
    mountCheckState:
      mountCheck.facts !== undefined ? mountCheck.facts.state : mountCheck.error.kind,
    version: version.version,
  };
}

async function archiveGitRef(source: string, ref: string, destination: string): Promise<void> {
  const git = spawn("git", ["-C", source, "archive", "--format=tar", ref], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tar = spawn("tar", ["-xf", "-", "-C", destination], {
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (!git.stdout || !tar.stdin) throw new Error("Could not create the PortableFS archive pipe");
  git.stdout.pipe(tar.stdin);
  const [gitResult, tarResult] = await Promise.all([
    collect(git, 4 * 1_024 * 1_024, false),
    collect(tar, 4 * 1_024 * 1_024),
  ]);
  if (gitResult.exitCode !== 0) {
    throw new Error(`git archive failed: ${gitResult.stderr.trim() || "unknown error"}`);
  }
  if (tarResult.exitCode !== 0) {
    throw new Error(`tar extraction failed: ${tarResult.stderr.trim() || "unknown error"}`);
  }
}

async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly acceptedExitCodes?: readonly number[];
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const child = spawn(command, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await collect(child, options.maxOutputBytes ?? 2 * 1_024 * 1_024);
  if (!(options.acceptedExitCodes ?? [0]).includes(result.exitCode)) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim() || "no diagnostic"}`,
    );
  }
  return { stderr: result.stderr, stdout: result.stdout };
}

async function collect(
  child: ReturnType<typeof spawn>,
  maxOutputBytes: number,
  captureStdout = true,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const append = (destination: Buffer[], chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxOutputBytes) {
      child.kill("SIGKILL");
      return;
    }
    destination.push(buffer);
  };
  if (captureStdout) {
    child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
  }
  child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, chunk));
  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  if (bytes > maxOutputBytes) throw new Error("Compatibility command exceeded its output limit");
  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function main(): Promise<void> {
  const result = await verifyPortableFsOriginMain();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
