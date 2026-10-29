#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const immutableReleaseRecordPath = "/usr/local/share/opensteer/release.json";
export const immutablePackageManifestPath = "/app/package.json";
export const portableFsArtifactEnvironmentVariables = [
  "OPENSTEER_PORTABLEFS_MOUNT_BINARY",
  "OPENSTEER_PORTABLEFS_MOUNT_SHA256",
];

export async function main() {
  const environment = { ...process.env };

  rejectRuntimeInjectionEnvironment(environment);
  await verifyReleaseIdentity(environment);
  await expandSecretFiles(environment);
  await configureBrowserRuntime(environment);
  await prepareRunnerWorkspaceRoot(environment);
  await verifyPortableFsArtifact(environment);

  const [command, ...arguments_] = process.argv.slice(2);
  if (!command) fail("Opensteer container entrypoint requires a command.");
  await runChild(command, arguments_, environment);
}

export function rejectRuntimeInjectionEnvironment(target) {
  for (const name of ["LD_AUDIT", "LD_PRELOAD", "NODE_OPTIONS", "NODE_PATH"]) {
    if (target[name] !== undefined) {
      fail(`${name} cannot alter the immutable Opensteer runtime.`);
    }
  }
}

export async function verifyReleaseIdentity(
  target,
  readReleaseRecord = readRegularText,
  readPackageManifest = readRegularText,
) {
  if (
    target.OPENSTEER_RELEASE_RECORD !== undefined &&
    target.OPENSTEER_RELEASE_RECORD !== immutableReleaseRecordPath
  ) {
    fail(
      `OPENSTEER_RELEASE_RECORD cannot redirect the immutable image release record at ${immutableReleaseRecordPath}.`,
    );
  }
  let record;
  try {
    record = JSON.parse(await readReleaseRecord(immutableReleaseRecordPath));
  } catch (error) {
    fail(`Could not read the Opensteer release record: ${safeMessage(error)}`);
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["schemaVersion", "sourceRevision", "version"]) ||
    record.schemaVersion !== 1 ||
    (record.version?.length ?? Number.POSITIVE_INFINITY) > 79 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(record.version ?? "") ||
    record.version === "0.0.0" ||
    !/^[0-9a-f]{40}$/u.test(record.sourceRevision ?? "") ||
    record.sourceRevision === "0".repeat(40)
  ) {
    fail("The Opensteer release record is invalid.");
  }
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readPackageManifest(immutablePackageManifestPath));
  } catch (error) {
    fail(`Could not read the fixed Opensteer package stamp: ${safeMessage(error)}`);
  }
  if (
    !packageManifest ||
    typeof packageManifest !== "object" ||
    Array.isArray(packageManifest) ||
    packageManifest.version !== record.version ||
    !packageManifest.opensteerBuild ||
    typeof packageManifest.opensteerBuild !== "object" ||
    Array.isArray(packageManifest.opensteerBuild) ||
    JSON.stringify(Object.keys(packageManifest.opensteerBuild).sort()) !==
      JSON.stringify(["sourceRevision", "version"]) ||
    packageManifest.opensteerBuild.version !== record.version ||
    packageManifest.opensteerBuild.sourceRevision !== record.sourceRevision
  ) {
    fail("The fixed Opensteer package stamp does not match the immutable release record.");
  }
  for (const [name, value] of [
    ["OPENSTEER_RELEASE_VERSION", record.version],
    ["OPENSTEER_SOURCE_REVISION", record.sourceRevision],
  ]) {
    if (target[name] !== undefined && target[name] !== value) {
      fail(`${name} does not match the immutable Opensteer release record.`);
    }
    target[name] = value;
  }
  target.OPENSTEER_RELEASE_RECORD = immutableReleaseRecordPath;
}

async function readRegularText(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${filePath} must be one real regular file.`);
  }
  return await readFile(filePath, "utf8");
}

async function runChild(command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", (error) =>
        rejectPromise(new Error(`Could not start Opensteer: ${error.message}`)),
      );
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

export async function expandSecretFiles(target) {
  const entries = Object.entries(target).filter(([name]) => name.endsWith("_FILE"));
  for (const [fileVariable, path] of entries) {
    if (!path) continue;
    const variable = fileVariable.slice(0, -"_FILE".length);
    if (target[variable] !== undefined) {
      fail(`${variable} and ${fileVariable} cannot both be set.`);
    }
    let value;
    try {
      value = (await readFile(path, "utf8")).replace(/[\r\n]+$/u, "");
    } catch (error) {
      fail(`Could not read the secret file configured by ${fileVariable}: ${safeMessage(error)}`);
    }
    if (!value) fail(`The secret file configured by ${fileVariable} is empty.`);
    target[variable] = value;
    delete target[fileVariable];
  }
}

async function configureBrowserRuntime(target) {
  const publicKeyPath = target.OPENSTEER_BROWSER_PUBLIC_KEY_PATH;
  if (publicKeyPath) {
    const keyId = target.OPENSTEER_BROWSER_ATTACH_KEY_ID || "host-v1";
    let publicKey;
    try {
      publicKey = await readFile(publicKeyPath, "utf8");
    } catch (error) {
      fail(`Could not read the Host browser ticket public key: ${safeMessage(error)}`);
    }
    target.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
    delete target.OPENSTEER_BROWSER_PUBLIC_KEY_PATH;
    delete target.OPENSTEER_BROWSER_ATTACH_KEY_ID;
  }

  if (!target.OPENSTEER_CHROMIUM_EXECUTABLE && target.OPENSTEER_BROWSER_PROFILE_ROOT) {
    const roots = (target.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright").split(delimiter);
    for (const root of roots) {
      const executable = await findChromiumExecutable(root);
      if (executable) {
        target.OPENSTEER_CHROMIUM_EXECUTABLE = executable;
        break;
      }
    }
  }
}

async function findChromiumExecutable(root) {
  let revisions;
  try {
    revisions = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const revision of revisions) {
    if (!revision.isDirectory() || !revision.name.startsWith("chromium")) continue;
    candidates.push(
      join(root, revision.name, "chrome-linux", "chrome"),
      join(root, revision.name, "chrome-linux64", "chrome"),
      join(root, revision.name, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    );
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next exact Playwright layout.
    }
  }
  return undefined;
}

export async function verifyPortableFsArtifact(target) {
  const [binaryVariable, checksumVariable] = portableFsArtifactEnvironmentVariables;
  const binary = target[binaryVariable];
  const expectedText = target[checksumVariable];
  if (!binary && !expectedText) return;
  if (!binary || !expectedText) {
    fail(`${binaryVariable} and ${checksumVariable} must be set together.`);
  }
  const expected = expectedText.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    fail(`${checksumVariable} must be a lowercase SHA-256 digest.`);
  }
  let artifact;
  try {
    artifact = await readFile(binary);
  } catch (error) {
    fail(`Could not read the pinned PortableFS artifact: ${safeMessage(error)}`);
  }
  const actual = createHash("sha256").update(artifact).digest();
  const expectedBytes = Buffer.from(expected, "hex");
  if (!timingSafeEqual(actual, expectedBytes)) {
    fail(`The supplied PortableFS artifact does not match ${checksumVariable}.`);
  }
}

export async function prepareRunnerWorkspaceRoot(target) {
  const root = target.OPENSTEER_RUNNER_WORKSPACE_ROOT;
  if (!root) return;
  try {
    await mkdir(root, { mode: 0o700, recursive: true });
    await chmod(root, 0o700);
  } catch (error) {
    fail(`Could not create OPENSTEER_RUNNER_WORKSPACE_ROOT: ${safeMessage(error)}`);
  }
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    fail(`Could not inspect OPENSTEER_RUNNER_WORKSPACE_ROOT: ${safeMessage(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("OPENSTEER_RUNNER_WORKSPACE_ROOT must be a real directory.");
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined && (metadata.uid !== uid || metadata.gid !== gid)) {
    fail("OPENSTEER_RUNNER_WORKSPACE_ROOT must be owned by the Runner process identity.");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    fail("OPENSTEER_RUNNER_WORKSPACE_ROOT must have mode 0700.");
  }
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 1_000) : "unknown error";
}

function fail(message) {
  throw new Error(message);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
