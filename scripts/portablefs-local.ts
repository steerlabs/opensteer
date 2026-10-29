#!/usr/bin/env node
import {
  setFileMode,
  setPrivateDirectoryMode,
  setPrivateFileMode,
} from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  Ed25519PortableFsProductAuthorizationSigner,
  PortableFsManagerClient,
} from "../packages/workspace-portablefs/src/control-plane.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const localRoot = join(repositoryRoot, ".opensteer", "portablefs", "local");
const deploymentPath = join(localRoot, "deployment.json");
const composeEnvironmentPath = join(localRoot, "compose.env");
const opensteerEnvironmentPath = join(localRoot, "opensteer.env");
const composePath = join(repositoryRoot, "deploy", "portablefs-local", "compose.yaml");
const containerfilePath = join(repositoryRoot, "deploy", "portablefs-local", "Containerfile");
const localDeploymentFiles = [
  "Containerfile",
  "bootstrap-cell.sh",
  "cell-entrypoint.sh",
  "cell-storage.service",
  "cell-storage.sh",
  "compose.yaml",
  "manager-entrypoint.sh",
] as const;
const managerServerName = "manager.portablefs.internal";
const authorityDnsZone = "authority.portablefs.internal";
const productIssuer = "opensteer-local";
const authorizationDomain = "opensteer-local";
const operatorId = "opensteer-local";
const schemaVersion = 1;

export type LocalPortableFsCommand = "down" | "status" | "up";

export interface LocalPortableFsDeployment {
  readonly authorityHost: string;
  readonly authorityPortEnd: number;
  readonly authorityPortStart: number;
  readonly bindAddress: string;
  readonly cellId: string;
  readonly deploymentId: string;
  readonly managerHost: string;
  readonly managerPort: number;
  readonly portableFsCommit: string;
  readonly portableFsSourceDirectory: string;
  readonly schemaVersion: 1;
}

export interface LocalPortableFsEnvironment {
  readonly OPENSTEER_FILES_BINARY: string;
  readonly OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN: string;
  readonly OPENSTEER_PORTABLEFS_SERVICE_ID: string;
  readonly OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: string;
  readonly OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: string;
  readonly OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: string;
  readonly OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME: string;
  readonly OPENSTEER_PORTABLEFS_MANAGER_URL: string;
  readonly OPENSTEER_PORTABLEFS_MOUNT_BINARY: string;
  readonly OPENSTEER_PORTABLEFS_PRODUCT_ISSUER: string;
  readonly OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: string;
}

export function localDeploymentManifestChanged(
  persisted: LocalPortableFsDeployment,
  upgraded: LocalPortableFsDeployment,
): boolean {
  return (
    upgraded.deploymentId !== persisted.deploymentId ||
    upgraded.portableFsCommit !== persisted.portableFsCommit ||
    upgraded.portableFsSourceDirectory !== persisted.portableFsSourceDirectory
  );
}

export function parseLocalPortableFsCommand(arguments_: readonly string[]): LocalPortableFsCommand {
  if (arguments_.length === 0) return "up";
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "up" || arguments_[0] === "down" || arguments_[0] === "status")
  ) {
    return arguments_[0];
  }
  throw new Error("Usage: pnpm portablefs:local [up|down|status]");
}

export function parseLocalPortableFsEndpointConfiguration(
  environment: NodeJS.ProcessEnv,
): Pick<
  LocalPortableFsDeployment,
  | "authorityHost"
  | "authorityPortEnd"
  | "authorityPortStart"
  | "bindAddress"
  | "managerHost"
  | "managerPort"
> {
  const authorityPortStart = parsePort(
    environment.OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_START,
    23_000,
    "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_START",
  );
  const authorityPortEnd = parsePort(
    environment.OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_END,
    23_255,
    "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_END",
  );
  if (authorityPortEnd < authorityPortStart || authorityPortEnd - authorityPortStart > 255) {
    throw new Error("The local PortableFS authority range must contain from 1 through 256 ports");
  }
  const bindAddress = environment.OPENSTEER_PORTABLEFS_LOCAL_BIND_ADDRESS?.trim() || "127.0.0.1";
  if (isIP(bindAddress) === 0) {
    throw new Error("OPENSTEER_PORTABLEFS_LOCAL_BIND_ADDRESS must be an exact IP address");
  }
  return {
    authorityHost: parseHost(
      environment.OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_HOST,
      "127.0.0.1",
      "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_HOST",
    ),
    authorityPortEnd,
    authorityPortStart,
    bindAddress,
    managerHost: parseHost(
      environment.OPENSTEER_PORTABLEFS_LOCAL_MANAGER_HOST,
      "127.0.0.1",
      "OPENSTEER_PORTABLEFS_LOCAL_MANAGER_HOST",
    ),
    managerPort: parsePort(
      environment.OPENSTEER_PORTABLEFS_LOCAL_MANAGER_PORT,
      28_443,
      "OPENSTEER_PORTABLEFS_LOCAL_MANAGER_PORT",
    ),
  };
}

export async function startLocalPortableFs(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalPortableFsEnvironment> {
  const deployment = await initializeDeployment(environment);
  const imageTag = await localImageTag(deployment);
  await buildImages(deployment, imageTag, environment);
  const clientRelease = await buildPortableFsClientRelease(deployment, environment);
  const composeEnvironment = composeEnvironmentFor(deployment, imageTag);
  await writeEnvironmentFile(composeEnvironmentPath, composeEnvironment);
  await run(
    "docker",
    [
      "compose",
      "--env-file",
      composeEnvironmentPath,
      "-f",
      composePath,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
    ],
    { environment },
  );
  const opensteerEnvironment = environmentFor(deployment, clientRelease);
  await waitForManager(opensteerEnvironment);
  await writeEnvironmentFile(opensteerEnvironmentPath, opensteerEnvironment);
  return opensteerEnvironment;
}

export async function stopLocalPortableFs(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await access(composeEnvironmentPath);
  await run(
    "docker",
    ["compose", "--env-file", composeEnvironmentPath, "-f", composePath, "down"],
    { environment },
  );
}

export async function statusLocalPortableFs(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await access(composeEnvironmentPath);
  await run("docker", ["compose", "--env-file", composeEnvironmentPath, "-f", composePath, "ps"], {
    environment,
    stdio: "inherit",
  });
}

async function initializeDeployment(
  environment: NodeJS.ProcessEnv,
): Promise<LocalPortableFsDeployment> {
  const sourceDirectory = resolve(
    environment.OPENSTEER_PORTABLEFS_SOURCE_DIR || join(repositoryRoot, "..", "portablefs"),
  );
  await validatePortableFsSource(sourceDirectory);
  const commit = (await capture("git", ["rev-parse", "HEAD"], sourceDirectory)).trim();
  const endpoint = parseLocalPortableFsEndpointConfiguration(environment);
  try {
    const persisted = parseDeployment(JSON.parse(await readFile(deploymentPath, "utf8")));
    for (const [key, value] of Object.entries(endpoint)) {
      if (persisted[key as keyof LocalPortableFsDeployment] !== value) {
        throw new Error(
          `Local PortableFS deployment changed ${key}; preserve the existing deployment or explicitly remove ${localRoot} and its Docker volumes before creating a different storage identity`,
        );
      }
    }
    const upgraded = {
      ...persisted,
      deploymentId: persisted.deploymentId || randomUUID(),
      portableFsCommit: commit,
      portableFsSourceDirectory: sourceDirectory,
    };
    if (localDeploymentManifestChanged(persisted, upgraded)) {
      await writeJsonAtomically(deploymentPath, upgraded);
    }
    return upgraded;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await setPrivateDirectoryMode(localRoot);
  const deployment: LocalPortableFsDeployment = {
    ...endpoint,
    cellId: randomUUID(),
    deploymentId: randomUUID(),
    portableFsCommit: commit,
    portableFsSourceDirectory: sourceDirectory,
    schemaVersion,
  };
  const pkiPath = join(localRoot, "pki");
  await run(
    "bash",
    [
      join(sourceDirectory, "deploy", "gcp", "generate-hosted-pki.sh"),
      pkiPath,
      managerServerName,
      deployment.cellId,
      productIssuer,
      operatorId,
    ],
    { environment },
  );
  await writeJsonAtomically(deploymentPath, deployment);
  return deployment;
}

export async function validatePortableFsSource(sourceDirectory: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(join(sourceDirectory, "vcs", "go.mod"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `PortableFS source checkout was not found at ${sourceDirectory}. Create a clean sibling checkout at ../portablefs or set OPENSTEER_PORTABLEFS_SOURCE_DIR to its absolute path.`,
      );
    }
    throw error;
  }
  if (!metadata.isFile()) throw new Error(`${sourceDirectory} is not a PortableFS source tree`);
  const dirty = (await capture("git", ["status", "--porcelain"], sourceDirectory)).trim();
  if (dirty) {
    throw new Error(
      `PortableFS source must be clean before it becomes local storage infrastructure: ${sourceDirectory}`,
    );
  }
}

async function buildImages(
  deployment: LocalPortableFsDeployment,
  imageTag: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const releaseId = imageTag;
  for (const target of ["manager", "cell"] as const) {
    const image = `opensteer-portablefs-${target}:${imageTag}`;
    if (await imageExists(image, environment)) continue;
    await run(
      "docker",
      [
        "build",
        "--file",
        containerfilePath,
        "--build-context",
        `opensteer=${repositoryRoot}`,
        "--target",
        target,
        "--build-arg",
        `PORTABLEFS_RELEASE_ID=${releaseId}`,
        "--tag",
        image,
        deployment.portableFsSourceDirectory,
      ],
      { environment, stdio: "inherit" },
    );
  }
}

async function localImageTag(deployment: LocalPortableFsDeployment): Promise<string> {
  const digest = createHash("sha256");
  digest.update(deployment.portableFsCommit);
  for (const name of localDeploymentFiles) {
    digest.update("\0");
    digest.update(name);
    digest.update("\0");
    digest.update(await readFile(join(repositoryRoot, "deploy", "portablefs-local", name)));
  }
  return `local-${deployment.portableFsCommit.slice(0, 12)}-${digest.digest("hex").slice(0, 12)}`;
}

async function imageExists(image: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await run("docker", ["image", "inspect", image], { environment, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function buildPortableFsClientRelease(
  deployment: LocalPortableFsDeployment,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly filesBinary: string; readonly mountBinary: string }> {
  const directory = join(localRoot, "client-releases", `${deployment.portableFsCommit}-reader-v1`);
  const binary = join(directory, "portablefs");
  const daemon = join(directory, "portablefsd");
  const filesBinary = join(directory, "portablefs-files");
  try {
    const [binaryMetadata, daemonMetadata, filesMetadata] = await Promise.all([
      stat(binary),
      stat(daemon),
      stat(filesBinary),
    ]);
    if (!binaryMetadata.isFile() || !daemonMetadata.isFile() || !filesMetadata.isFile()) {
      throw new Error("Local PortableFS client release contains a non-file member");
    }
    return { filesBinary, mountBinary: binary };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const parent = dirname(directory);
  const temporaryDirectory = `${directory}.next-${randomUUID()}`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const version = `local-${deployment.portableFsCommit.slice(0, 12)}`;
  try {
    for (const name of ["portablefs", "portablefsd"] as const) {
      await run(
        "go",
        [
          "-C",
          join(deployment.portableFsSourceDirectory, "vcs"),
          "build",
          "-trimpath",
          "-ldflags",
          `-s -w -buildid= -X main.version=${version}`,
          "-o",
          join(temporaryDirectory, name),
          `./cmd/${name}`,
        ],
        { environment, stdio: "inherit" },
      );
      await setFileMode(join(temporaryDirectory, name), 0o555);
    }
    await run(
      "go",
      [
        "-C",
        join(deployment.portableFsSourceDirectory, "vcs"),
        "build",
        "-trimpath",
        "-ldflags",
        "-s -w -buildid=",
        "-o",
        join(temporaryDirectory, "portablefs-files"),
        "./cmd/portablefs-files",
      ],
      { environment, stdio: "inherit" },
    );
    await setFileMode(join(temporaryDirectory, "portablefs-files"), 0o555);
    const [cliVersion, daemonVersion] = await Promise.all([
      capture(join(temporaryDirectory, "portablefs"), ["version"], repositoryRoot),
      capture(join(temporaryDirectory, "portablefsd"), ["-version"], repositoryRoot),
    ]);
    if (cliVersion.trim() !== `portablefs ${version}` || daemonVersion.trim() !== version) {
      throw new Error("Built PortableFS client release does not share one exact version identity");
    }
    await rename(temporaryDirectory, directory);
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
  return { filesBinary, mountBinary: binary };
}

function composeEnvironmentFor(
  deployment: LocalPortableFsDeployment,
  imageTag: string,
): Record<string, string> {
  return {
    PORTABLEFS_AUTHORITY_DNS_ZONE: authorityDnsZone,
    PORTABLEFS_AUTHORITY_HOST: deployment.authorityHost,
    PORTABLEFS_CELL_CAPACITY_BYTES: "6442450944",
    PORTABLEFS_CELL_CAPACITY_INODES: "1000000",
    PORTABLEFS_CELL_ID: deployment.cellId,
    PORTABLEFS_CELL_IMAGE_SIZE: "8G",
    PORTABLEFS_LOCAL_AUTHORITY_PORT_END: String(deployment.authorityPortEnd),
    PORTABLEFS_LOCAL_AUTHORITY_PORT_START: String(deployment.authorityPortStart),
    PORTABLEFS_LOCAL_BIND_ADDRESS: deployment.bindAddress,
    PORTABLEFS_LOCAL_IMAGE_TAG: imageTag,
    PORTABLEFS_LOCAL_MANAGER_PORT: String(deployment.managerPort),
    PORTABLEFS_LOCAL_PKI_DIR: join(localRoot, "pki"),
    PORTABLEFS_PRODUCT_ISSUER: productIssuer,
  };
}

function environmentFor(
  deployment: LocalPortableFsDeployment,
  clientRelease: { readonly filesBinary: string; readonly mountBinary: string },
): LocalPortableFsEnvironment {
  const pki = join(localRoot, "pki");
  return {
    OPENSTEER_FILES_BINARY: clientRelease.filesBinary,
    OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN: authorizationDomain,
    OPENSTEER_PORTABLEFS_SERVICE_ID: deployment.deploymentId,
    OPENSTEER_PORTABLEFS_MANAGER_CA_PATH: join(pki, "product", "manager-ca.pem"),
    OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH: join(pki, "product", "product-client.cert"),
    OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH: join(pki, "product", "product-client.key"),
    OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME: managerServerName,
    OPENSTEER_PORTABLEFS_MANAGER_URL: `https://${formatUrlHost(deployment.managerHost)}:${deployment.managerPort}/`,
    OPENSTEER_PORTABLEFS_MOUNT_BINARY: clientRelease.mountBinary,
    OPENSTEER_PORTABLEFS_PRODUCT_ISSUER: productIssuer,
    OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH: join(pki, "product", "product-signing.key"),
  };
}

async function waitForManager(environment: LocalPortableFsEnvironment): Promise<void> {
  const [caCertificatePem, clientCertificatePem, clientPrivateKeyPem, signingKeyPem] =
    await Promise.all([
      readFile(environment.OPENSTEER_PORTABLEFS_MANAGER_CA_PATH, "utf8"),
      readFile(environment.OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH, "utf8"),
      readFile(environment.OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH, "utf8"),
      readFile(environment.OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH),
    ]);
  const client = new PortableFsManagerClient({
    authorizationDomain,
    baseUrl: new URL(environment.OPENSTEER_PORTABLEFS_MANAGER_URL),
    productIssuer,
    signer: new Ed25519PortableFsProductAuthorizationSigner(createPrivateKey(signingKeyPem)),
    tls: {
      caCertificatePem,
      clientCertificatePem,
      clientPrivateKeyPem,
      serverName: environment.OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME,
    },
  });
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.health({ timeoutMs: 3_000 });
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error("Local PortableFS Manager did not become ready", { cause: lastError });
}

async function writeEnvironmentFile(
  path: string,
  values: Record<string, string> | LocalPortableFsEnvironment,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = `${Object.entries(values)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
  const temporary = `${path}.next-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await setPrivateFileMode(path);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
  await setPrivateFileMode(path);
}

function parseDeployment(value: unknown): LocalPortableFsDeployment {
  if (!value || typeof value !== "object") throw new Error("Invalid local PortableFS deployment");
  const candidate = value as Partial<LocalPortableFsDeployment>;
  if (
    candidate.schemaVersion !== schemaVersion ||
    typeof candidate.cellId !== "string" ||
    typeof candidate.portableFsCommit !== "string" ||
    typeof candidate.portableFsSourceDirectory !== "string" ||
    typeof candidate.authorityHost !== "string" ||
    typeof candidate.managerHost !== "string" ||
    typeof candidate.bindAddress !== "string" ||
    typeof candidate.managerPort !== "number" ||
    typeof candidate.authorityPortStart !== "number" ||
    typeof candidate.authorityPortEnd !== "number"
  ) {
    throw new Error("Invalid local PortableFS deployment manifest");
  }
  return {
    ...candidate,
    // Schema v1 predates Opensteer's explicit Workspace-to-deployment
    // binding. The generated identity is persisted before it is returned.
    deploymentId:
      typeof candidate.deploymentId === "string" && candidate.deploymentId.length > 0
        ? candidate.deploymentId
        : "",
  } as LocalPortableFsDeployment;
}

function parseHost(value: string | undefined, fallback: string, name: string): string {
  const host = value?.trim() || fallback;
  if (isIP(host) !== 0) return host;
  if (
    host.length > 253 ||
    !host.includes(".") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)
  ) {
    throw new Error(`${name} must be an IP address or fully qualified DNS name`);
  }
  return host.toLowerCase();
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1024 through 65535`);
  }
  return parsed;
}

function formatUrlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

async function capture(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  await run(command, arguments_, { cwd, stdout: chunks });
  return Buffer.concat(chunks).toString("utf8");
}

async function run(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly stdio?: "ignore" | "inherit";
    readonly stdout?: Buffer[];
  } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd ?? repositoryRoot,
      env: options.environment ?? process.env,
      shell: false,
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = options.stdout ?? [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 16 * 1_024 * 1_024) child.kill("SIGKILL");
        else stdout.push(value);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 16 * 1_024 * 1_024) child.kill("SIGKILL");
        else stderr.push(value);
      });
    }
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (bytes > 16 * 1_024 * 1_024) {
        rejectPromise(new Error(`${command} output exceeded sixteen MiB`));
      } else if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `${command} ${arguments_.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${Buffer.concat(stderr).toString("utf8").slice(-8_000)}`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  switch (parseLocalPortableFsCommand(process.argv.slice(2))) {
    case "up": {
      const environment = await startLocalPortableFs();
      process.stdout.write(
        `${JSON.stringify({ environmentFile: opensteerEnvironmentPath, managerUrl: environment.OPENSTEER_PORTABLEFS_MANAGER_URL, status: "ready" })}\n`,
      );
      return;
    }
    case "down":
      await stopLocalPortableFs();
      return;
    case "status":
      await statusLocalPortableFs();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch(async (error: unknown) => {
    await rm(join(localRoot, ".incomplete"), { force: true }).catch(() => undefined);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
