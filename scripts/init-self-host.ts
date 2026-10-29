#!/usr/bin/env node
import { setPrivateHandleMode } from "@opensteer/shared/privateFiles";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { requireCanonicalReleaseIdentity } = require("./release-identity.cjs") as {
  readonly requireCanonicalReleaseIdentity: (
    repositoryRoot: string,
    environment: NodeJS.ProcessEnv,
    options?: { readonly verifyRepository?: boolean },
  ) => { readonly sourceRevision: string; readonly version: string };
};
const execFileAsync = promisify(execFile);

const secretDirectoryMode = 0o700;
const secretFileMode = 0o644;
const maxSecretBytes = 16 * 1_024;
const publicationSettleAttempts = 40;
const publicationSettleDelayMilliseconds = 5;
// Node’s file opens already set close-on-exec through libuv.
const safeReadFlags = fsConstants.O_RDONLY | noFollowFlag() | fsConstants.O_NONBLOCK;
const safeCreateFlags =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag();

export interface InitializedSelfHostSecrets {
  readonly created: readonly string[];
  readonly directory: string;
}

export interface InitializedSelfHost extends InitializedSelfHostSecrets {
  readonly configPath: string;
  readonly sourceRevision: string;
  readonly version: string;
}

export type SelfHostWorkspaceBacking = "local-directory" | "portablefs";

export function selfHostWorkspaceBacking(environment: NodeJS.ProcessEnv): SelfHostWorkspaceBacking {
  const value = environment.OPENSTEER_DEFAULT_WORKSPACE_BACKING?.trim() || "local-directory";
  if (value !== "local-directory" && value !== "portablefs") {
    throw new Error(
      "init:self-host requires OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory or portablefs",
    );
  }
  if ((environment.OPENSTEER_DEPLOYMENT_KIND?.trim() || "server") !== "server") {
    throw new Error("init:self-host requires OPENSTEER_DEPLOYMENT_KIND=server");
  }
  return value;
}

export function selfHostInitializationSummary(
  result: InitializedSelfHostSecrets,
  backing: SelfHostWorkspaceBacking,
): Record<string, unknown> {
  return {
    created: result.created,
    directory: result.directory,
    backing,
    note:
      backing === "local-directory"
        ? "Configure model credentials on the Runner."
        : "Supply the PortableFS product identity files and configure model credentials on each Runner.",
  };
}

export async function initializeSelfHostSecrets(
  directory = resolve(import.meta.dirname, "..", "deploy", "self-host", "secrets"),
): Promise<InitializedSelfHostSecrets> {
  const target = resolve(directory);
  await mkdir(target, { mode: secretDirectoryMode, recursive: true });
  await validateSecretDirectory(target);

  const created: string[] = [];
  const postgresPassword = await createOrReadSecret(target, "postgres_password", 32, created);
  await Promise.all([
    createSecret(target, "browser_bridge_token", randomSecret(48), created),
    createSecret(target, "browser_runner_enrollment_token", randomSecret(48), created),
    createSecret(target, "opensteer_auth_secret", randomSecret(48), created),
    createSecret(target, "initial_owner_enrollment_token", randomSecret(48), created),
    createSecret(target, "browser_profile_key", randomBytes(32).toString("base64url"), created),
    createSecret(target, "credential_key", randomBytes(32).toString("base64url"), created),
    createSecret(target, "messaging_runner_enrollment_token", randomSecret(48), created),
    createSecret(
      target,
      "database_url",
      `postgres://opensteer:${encodeURIComponent(postgresPassword)}@postgres:5432/opensteer`,
      created,
      true,
    ),
  ]);

  return { created: created.toSorted(), directory: target };
}

export async function initializeSelfHost(options: {
  readonly configPath: string;
  readonly configTemplatePath: string;
  readonly repositoryRoot: string;
  readonly secretsDirectory: string;
}): Promise<InitializedSelfHost> {
  const secrets = await initializeSelfHostSecrets(options.secretsDirectory);
  const repositoryRoot = resolve(options.repositoryRoot);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8" },
  );
  const sourceRevision = stdout.trim();
  const identity = requireCanonicalReleaseIdentity(repositoryRoot, {
    OPENSTEER_SOURCE_REVISION: sourceRevision,
  });
  const configPath = resolve(options.configPath);
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    configSource = await readFile(resolve(options.configTemplatePath), "utf8");
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, selfHostConfigWithBuildIdentity(configSource, identity), {
    mode: 0o600,
  });
  return { ...secrets, configPath, ...identity };
}

export function selfHostConfigWithBuildIdentity(
  source: string,
  identity: { readonly sourceRevision: string; readonly version: string },
): string {
  const values = new Map([
    ["OPENSTEER_RELEASE_VERSION", identity.version],
    ["OPENSTEER_SOURCE_REVISION", identity.sourceRevision],
  ]);
  const seen = new Set<string>();
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const updated = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match || !values.has(match[1]!)) return line;
    const name = match[1]!;
    if (seen.has(name)) throw new Error(`Self-host config declares ${name} more than once`);
    seen.add(name);
    return `${name}=${values.get(name)}`;
  });
  for (const [name, value] of values) {
    if (!seen.has(name)) updated.push(`${name}=${value}`);
  }
  return `${updated.filter((line, index) => line || index < updated.length - 1).join("\n")}\n`;
}

async function createOrReadSecret(
  directory: string,
  name: string,
  bytes: number,
  created: string[],
): Promise<string> {
  const result = await materializeSecret(directory, name, randomSecret(bytes));
  if (result.created) created.push(name);
  return result.value;
}

async function createSecret(
  directory: string,
  name: string,
  value: string,
  created: string[],
  requireExactExistingValue = false,
): Promise<void> {
  const result = await materializeSecret(directory, name, value);
  if (result.created) created.push(name);
  if (requireExactExistingValue && result.value !== value) {
    throw new Error(`${name} does not match the persisted PostgreSQL password`);
  }
}

async function materializeSecret(
  directory: string,
  name: string,
  candidate: string,
): Promise<{ readonly created: boolean; readonly value: string }> {
  if (!candidate || Buffer.byteLength(candidate, "utf8") > maxSecretBytes) {
    throw new Error(`${name} candidate is outside the secret byte limit`);
  }
  const path = resolve(directory, name);
  const temporary = resolve(directory, `.${name}.tmp-${randomUUID()}`);
  let created = false;
  let temporaryExists = false;
  try {
    const temporaryHandle = await open(temporary, safeCreateFlags, 0o600);
    temporaryExists = true;
    try {
      await assertSafeSecretFile(temporaryHandle, temporary);
      await temporaryHandle.writeFile(`${candidate}\n`, "utf8");
      await temporaryHandle.sync();
      await setPrivateHandleMode(temporaryHandle, secretFileMode);
    } finally {
      await temporaryHandle.close();
    }

    try {
      await link(temporary, path);
      created = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
      await syncSecretDirectory(directory);
    }
  }

  // Always reopen the published path. In a concurrent first run, the process
  // that loses the atomic link race must use the winner's persisted password
  // before deriving database_url; returning its discarded candidate would
  // permanently split the two secrets.
  const value = await readValidatedSecret(path);
  return { created, value };
}

async function validateSecretDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag());
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("Self-host secret path is not a directory");
    assertExpectedOwner(metadata.uid, path);
    await setPrivateHandleMode(handle, secretDirectoryMode);
  } finally {
    await handle.close();
  }
}

async function syncSecretDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag());
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("Self-host secret path is not a directory");
    assertExpectedOwner(metadata.uid, path);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readValidatedSecret(path: string): Promise<string> {
  for (let attempt = 0; attempt < publicationSettleAttempts; attempt += 1) {
    const handle = await open(path, safeReadFlags);
    try {
      const metadata = await handle.stat();
      assertSafeSecretFileMetadata(metadata, path);
      if (metadata.nlink !== 1) {
        if (attempt === publicationSettleAttempts - 1) {
          throw new Error(`${path} must have exactly one filesystem link`);
        }
      } else {
        await setPrivateHandleMode(handle, secretFileMode);
        if (metadata.size > maxSecretBytes)
          throw new Error(`${path} exceeds the secret byte limit`);
        return decodePersistedSecret(await handle.readFile(), path);
      }
    } finally {
      await handle.close();
    }
    await delay(publicationSettleDelayMilliseconds);
  }
  throw new Error(`${path} did not settle to one filesystem link`);
}

async function assertSafeSecretFile(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  const metadata = await handle.stat();
  assertSafeSecretFileMetadata(metadata, path);
  if (metadata.nlink !== 1) throw new Error(`${path} must have exactly one filesystem link`);
}

function assertSafeSecretFileMetadata(metadata: Stats, path: string): void {
  if (!metadata.isFile()) throw new Error(`${path} is not a regular secret file`);
  assertExpectedOwner(metadata.uid, path);
}

function decodePersistedSecret(content: Buffer, path: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value) throw new Error(`${path} exists but is empty`);
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    throw new Error(`${path} must contain exactly one text secret`);
  }
  if (value !== value.trim()) {
    throw new Error(`${path} must not contain surrounding whitespace`);
  }
  return value;
}

function assertExpectedOwner(actualUid: number, path: string): void {
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined && actualUid !== expectedUid) {
    throw new Error(`${path} is not owned by the current operator`);
  }
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function parseDirectory(arguments_: readonly string[]): string | undefined {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length === 2 && arguments_[0] === "--secrets-dir" && arguments_[1]) {
    return resolve(arguments_[1]);
  }
  throw new Error("Usage: pnpm init:self-host [--secrets-dir /absolute/path]");
}

async function main(): Promise<void> {
  const backing = selfHostWorkspaceBacking(process.env);
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const secretsDirectory =
    parseDirectory(process.argv.slice(2)) ??
    resolve(repositoryRoot, "deploy", "self-host", "secrets");
  const configDirectory = dirname(secretsDirectory);
  const result = await initializeSelfHost({
    configPath: resolve(configDirectory, "config.env"),
    configTemplatePath: resolve(repositoryRoot, "deploy", "self-host", "config.env.example"),
    repositoryRoot,
    secretsDirectory,
  });
  process.stdout.write(`${JSON.stringify(selfHostInitializationSummary(result, backing))}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
