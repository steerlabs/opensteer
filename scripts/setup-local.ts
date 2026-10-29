#!/usr/bin/env node
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { assertDevelopmentWorkspaceEnvironment } from "./dev-supervisor.js";
import { validatePortableFsSource } from "./portablefs-local.js";

const requiredPnpmVersion = "10.29.3";
const minimumNodeVersion = [24, 13, 0] as const;
const minimumGoVersion = [1, 25, 0] as const;

type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  options?: { readonly cwd?: string; readonly inherit?: boolean },
) => Promise<string>;

export interface LocalSetupOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodeVersion?: string;
  readonly repositoryRoot?: string;
  readonly runCommand?: CommandRunner;
  readonly validatePortableFs?: (sourceDirectory: string) => Promise<void>;
}

export interface LocalSetupResult {
  readonly environmentCreated: boolean;
  readonly environmentUpdated: boolean;
  readonly portableFsSourceDirectory?: string;
  readonly backing: "local-directory" | "portablefs";
}

export async function initializeLocalDevelopment(
  options: LocalSetupOptions = {},
): Promise<LocalSetupResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dirname, ".."));
  const environment = options.environment ?? process.env;
  const run = options.runCommand ?? runCommand;
  requireVersion(options.nodeVersion ?? process.versions.node, minimumNodeVersion, "Node.js");

  const pnpmVersion = (await run("pnpm", ["--version"])).trim();
  if (pnpmVersion !== requiredPnpmVersion) {
    throw new Error(
      `pnpm ${requiredPnpmVersion} is required, but ${pnpmVersion || "no version"} is active. Run corepack enable from this repository.`,
    );
  }
  const goOutput = (await run("go", ["version"])).trim();
  const goVersion = /\bgo(\d+\.\d+(?:\.\d+)?)\b/u.exec(goOutput)?.[1];
  if (!goVersion) throw new Error(`Could not read the Go version from: ${goOutput}`);
  requireVersion(goVersion, minimumGoVersion, "Go");
  await run("docker", ["--version"]);
  await run("docker", ["compose", "version"]);
  await run("docker", ["info", "--format", "{{.ServerVersion}}"]);

  await run("pnpm", ["exec", "playwright-core", "install", "chromium"], {
    cwd: repositoryRoot,
    inherit: true,
  });

  const environmentResult = await materializeLocalEnvironment(repositoryRoot);
  const parsedEnvironment = parseEnvironmentFile(environmentResult.content);
  const backing = developmentBacking(environment, parsedEnvironment);
  assertDevelopmentWorkspaceEnvironment(backing, { ...parsedEnvironment, ...environment });
  let portableFsSourceDirectory: string | undefined;
  if (backing === "portablefs") {
    const deployment =
      environment.OPENSTEER_DEV_PORTABLEFS ?? parsedEnvironment.OPENSTEER_DEV_PORTABLEFS ?? "local";
    if (deployment !== "local" && deployment !== "external") {
      throw new Error("OPENSTEER_DEV_PORTABLEFS must be local or external");
    }
    if (deployment === "local") {
      await run("openssl", ["version"]);
      portableFsSourceDirectory = resolve(
        environment.OPENSTEER_PORTABLEFS_SOURCE_DIR ??
          parsedEnvironment.OPENSTEER_PORTABLEFS_SOURCE_DIR ??
          join(repositoryRoot, "..", "portablefs"),
      );
      await (options.validatePortableFs ?? validatePortableFsSource)(portableFsSourceDirectory);
    }
  }

  await run(
    "docker",
    [
      "compose",
      "-f",
      join(repositoryRoot, "deploy", "compose", "compose.yaml"),
      "up",
      "-d",
      "--wait",
    ],
    { cwd: repositoryRoot, inherit: true },
  );
  return {
    environmentCreated: environmentResult.created,
    environmentUpdated: environmentResult.updated,
    ...(portableFsSourceDirectory ? { portableFsSourceDirectory } : {}),
    backing,
  };
}

function developmentBacking(
  processEnvironment: NodeJS.ProcessEnv,
  fileEnvironment: Record<string, string>,
): "local-directory" | "portablefs" {
  const value =
    processEnvironment.OPENSTEER_DEFAULT_WORKSPACE_BACKING ??
    fileEnvironment.OPENSTEER_DEFAULT_WORKSPACE_BACKING ??
    "local-directory";
  if (value === "local-directory" || value === "portablefs") return value;
  throw new Error(
    "pnpm setup:local requires OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory or portablefs",
  );
}

async function materializeLocalEnvironment(repositoryRoot: string): Promise<{
  readonly content: string;
  readonly created: boolean;
  readonly updated: boolean;
}> {
  const templatePath = join(repositoryRoot, ".env.example");
  const environmentPath = join(repositoryRoot, ".env");
  const existing = await readRegularFileIfPresent(environmentPath);
  const source = existing ?? (await readFile(templatePath, "utf8"));
  const content = replaceLocalPlaceholders(source);
  validateLocalEnvironment(content);

  if (existing === null) {
    try {
      await writeFile(environmentPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      // Concurrent first runs converge on the file that was published first;
      // a discarded candidate secret must never overwrite the winner.
      if (isNodeError(error) && error.code === "EEXIST") {
        return materializeLocalEnvironment(repositoryRoot);
      }
      throw error;
    }
    await setPrivateFileMode(environmentPath);
    return { content, created: true, updated: false };
  }
  if (content === existing) {
    await setPrivateFileMode(environmentPath);
    return { content, created: false, updated: false };
  }
  const temporary = `${environmentPath}.next-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, environmentPath);
    await setPrivateFileMode(environmentPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { content, created: false, updated: true };
}

export function replaceLocalPlaceholders(content: string): string {
  const replacements = new Map([["replace-with-at-least-32-random-characters", randomSecret()]]);
  let result = content;
  for (const [placeholder, value] of replacements) result = result.replaceAll(placeholder, value);
  const parsed = parseEnvironmentFile(result);
  if (!parsed.OPENSTEER_AUTH_SECRET) {
    result = appendEnvironmentSetting(result, "OPENSTEER_AUTH_SECRET", randomSecret());
  }
  if (!parsed.OPENSTEER_CANONICAL_ORIGIN) {
    result = appendEnvironmentSetting(
      result,
      "OPENSTEER_CANONICAL_ORIGIN",
      "http://localhost:43100",
    );
  }
  if (!parsed.OPENSTEER_BIND_ADDRESS) {
    result = appendEnvironmentSetting(result, "OPENSTEER_BIND_ADDRESS", "127.0.0.1");
  }
  if (!parsed.OPENSTEER_DEFAULT_WORKSPACE_BACKING) {
    result = appendEnvironmentSetting(
      result,
      "OPENSTEER_DEFAULT_WORKSPACE_BACKING",
      "local-directory",
    );
  }
  if (!parsed.OPENSTEER_DEPLOYMENT_KIND) {
    result = appendEnvironmentSetting(result, "OPENSTEER_DEPLOYMENT_KIND", "server");
  }
  return result;
}

function appendEnvironmentSetting(content: string, name: string, value: string): string {
  return `${content.endsWith("\n") ? content : `${content}\n`}${name}=${value}\n`;
}

function validateLocalEnvironment(content: string): void {
  const environment = parseEnvironmentFile(content);
  for (const name of ["OPENSTEER_AUTH_SECRET"]) {
    const value = environment[name];
    if (!value || value.length < 32 || /replace-with/u.test(value)) {
      throw new Error(`${name} must contain a generated local secret of at least 32 characters`);
    }
  }
  if (environment.OPENSTEER_CANONICAL_ORIGIN !== "http://localhost:43100") {
    throw new Error("Local setup requires OPENSTEER_CANONICAL_ORIGIN=http://localhost:43100");
  }
  if (environment.OPENSTEER_BIND_ADDRESS !== "127.0.0.1") {
    throw new Error("Local setup requires OPENSTEER_BIND_ADDRESS=127.0.0.1");
  }
  const backing = environment.OPENSTEER_DEFAULT_WORKSPACE_BACKING ?? "local-directory";
  if (backing !== "local-directory" && backing !== "portablefs") {
    throw new Error(
      "pnpm setup:local requires OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory or portablefs",
    );
  }
  assertDevelopmentWorkspaceEnvironment(backing, environment);
}

function parseEnvironmentFile(content: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function readRegularFileIfPresent(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${path} must be a regular file, not a link`);
    }
    const expectedUid = process.getuid?.();
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error(`${path} is not owned by the current user`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function requireVersion(
  actual: string,
  minimum: readonly [number, number, number],
  label: string,
): void {
  const components = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(actual)?.slice(1).map(Number);
  if (!components) throw new Error(`Could not parse ${label} version: ${actual}`);
  const [major = 0, minor = 0, patch = 0] = components;
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;
  const accepted =
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)));
  if (!accepted) {
    throw new Error(`${label} ${minimum.join(".")} or newer is required; found ${actual}`);
  }
}

function randomSecret(): string {
  return randomBytes(48).toString("base64url");
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd?: string; readonly inherit?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      shell: false,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      rejectPromise(new Error(`${command} is required for local development`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code ?? "unknown"}`}): ${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const result = await initializeLocalDevelopment();
  process.stdout.write(
    `Local Opensteer setup is ready (${result.backing}).\n${result.portableFsSourceDirectory ? `PortableFS: ${result.portableFsSourceDirectory}\n` : ""}Next: pnpm dev\n`,
  );
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
