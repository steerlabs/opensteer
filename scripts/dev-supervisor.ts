import { setPrivateDirectoryMode } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";

const maximumLockBytes = 4 * 1_024;

export class DevelopmentStackAlreadyRunningError extends Error {
  readonly pid: number;
  readonly publicUrl: string;

  constructor(pid: number, publicUrl: string) {
    super(`Opensteer development is already running at ${publicUrl} (PID ${pid}).`);
    this.name = "DevelopmentStackAlreadyRunningError";
    this.pid = pid;
    this.publicUrl = publicUrl;
  }
}

export class DevelopmentStackLock {
  readonly #nonce: string;
  readonly #path: string;
  #handle: Awaited<ReturnType<typeof open>> | undefined;

  private constructor(path: string, nonce: string) {
    this.#path = path;
    this.#nonce = nonce;
  }

  static async acquire(path: string, publicUrl: string): Promise<DevelopmentStackLock> {
    const resolved = resolve(path);
    await mkdir(dirname(resolved), { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(dirname(resolved));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = randomUUID();
      const lock = new DevelopmentStackLock(resolved, nonce);
      try {
        lock.#handle = await open(resolved, "wx", 0o600);
        await lock.#handle.writeFile(
          `${JSON.stringify({ nonce, pid: process.pid, publicUrl, startedAt: new Date().toISOString() })}\n`,
          "utf8",
        );
        await lock.#handle.sync();
        return lock;
      } catch (error) {
        await lock.#handle?.close().catch(() => undefined);
        lock.#handle = undefined;
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const owner = await readLockOwner(resolved);
        if (owner && processIsAlive(owner.pid)) {
          throw new DevelopmentStackAlreadyRunningError(owner.pid, owner.publicUrl);
        }
        if (attempt > 0 || owner === null) {
          throw new Error(`Opensteer development lock is invalid: ${resolved}`);
        }
        await rm(resolved, { force: true });
      }
    }
    throw new Error(`Unable to acquire Opensteer development lock: ${resolved}`);
  }

  async release(): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await handle.close();
    const owner = await readLockOwner(this.#path).catch(() => null);
    if (owner?.nonce === this.#nonce) await rm(this.#path, { force: true });
  }
}

export interface DevelopmentListener {
  readonly host: string;
  readonly label: string;
  readonly port: number;
}

export type DevelopmentWorkspaceBacking = "local-directory" | "portablefs";

export function developmentWorkspaceBacking(
  environment: NodeJS.ProcessEnv,
): DevelopmentWorkspaceBacking {
  const value = environment.OPENSTEER_DEFAULT_WORKSPACE_BACKING?.trim() || "local-directory";
  if (value === "local-directory" || value === "portablefs") return value;
  throw new Error(
    "pnpm dev requires OPENSTEER_DEFAULT_WORKSPACE_BACKING=local-directory or portablefs",
  );
}

export function assertDevelopmentWorkspaceEnvironment(
  backing: DevelopmentWorkspaceBacking,
  environment: NodeJS.ProcessEnv,
): void {
  const localVariables = [
    "OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID",
    "OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH",
    "OPENSTEER_LOCAL_WORKSPACE_ROOT",
  ] as const;
  const portableFsVariables = [
    "OPENSTEER_FILES_BINARY",
    "OPENSTEER_FILES_SERVICE_URL",
    "OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN",
    "OPENSTEER_PORTABLEFS_MANAGER_CA_PATH",
    "OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH",
    "OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH",
    "OPENSTEER_PORTABLEFS_MANAGER_SERVER_NAME",
    "OPENSTEER_PORTABLEFS_MANAGER_URL",
    "OPENSTEER_PORTABLEFS_MOUNT_BINARY",
    "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_HOST",
    "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_END",
    "OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_START",
    "OPENSTEER_PORTABLEFS_LOCAL_BIND_ADDRESS",
    "OPENSTEER_PORTABLEFS_LOCAL_MANAGER_HOST",
    "OPENSTEER_PORTABLEFS_LOCAL_MANAGER_PORT",
    "OPENSTEER_PORTABLEFS_PRODUCT_ISSUER",
    "OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH",
    "OPENSTEER_PORTABLEFS_SERVICE_ID",
    "OPENSTEER_PORTABLEFS_SOURCE_DIR",
    "OPENSTEER_RUNNER_WORKSPACE_ROOT",
    "OPENSTEER_WORKSPACE_DEFAULT_BLOCK_LIMIT_BYTES",
    "OPENSTEER_WORKSPACE_DEFAULT_INODE_LIMIT",
  ] as const;
  const forbidden = backing === "local-directory" ? portableFsVariables : localVariables;
  const configured = forbidden.find((name) => environment[name]?.trim());
  if (configured) {
    throw new Error(`${backing} must not configure ${configured}`);
  }
  if (backing === "local-directory" && environment.OPENSTEER_DEV_PORTABLEFS?.trim()) {
    throw new Error(
      "OPENSTEER_DEV_PORTABLEFS is valid only with OPENSTEER_DEFAULT_WORKSPACE_BACKING=portablefs",
    );
  }
  if ((environment.OPENSTEER_DEPLOYMENT_KIND?.trim() || "server") !== "server") {
    throw new Error("pnpm dev requires OPENSTEER_DEPLOYMENT_KIND=server");
  }
}

export function localFilesServiceUrl(environment: NodeJS.ProcessEnv): URL {
  const value = environment.OPENSTEER_FILES_SERVICE_URL?.trim() || "http://127.0.0.1:4315";
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OPENSTEER_FILES_SERVICE_URL must be an HTTP origin for local development");
  }
  return url;
}

export function developmentListeners(
  services: readonly string[],
  environment: NodeJS.ProcessEnv,
): readonly DevelopmentListener[] {
  const listeners: DevelopmentListener[] = [];
  if (services.includes("files")) {
    const filesUrl = localFilesServiceUrl(environment);
    listeners.push({
      host: filesUrl.hostname,
      label: "Files service",
      port: environmentPort(filesUrl.port, 80, "OPENSTEER_FILES_SERVICE_URL"),
    });
  }
  if (services.includes("host")) {
    listeners.push({
      host: environment.OPENSTEER_BIND_ADDRESS?.trim() || "127.0.0.1",
      label: "Host",
      port: environmentPort(environment.OPENSTEER_PORT, 4310, "OPENSTEER_PORT"),
    });
  }
  if (services.includes("web")) {
    listeners.push({
      host: "127.0.0.1",
      label: "Web",
      port: environmentPort(environment.OPENSTEER_WEB_PORT, 43_100, "OPENSTEER_WEB_PORT"),
    });
  }
  if (services.includes("channel-runtime")) {
    listeners.push({
      host: environment.OPENSTEER_MESSAGING_BIND_ADDRESS?.trim() || "127.0.0.1",
      label: "Messaging service",
      port: environmentPort(environment.OPENSTEER_MESSAGING_PORT, 4320, "OPENSTEER_MESSAGING_PORT"),
    });
  }
  if (services.includes("browser-runtime")) {
    listeners.push({
      host: environment.OPENSTEER_BROWSER_HOST?.trim() || "127.0.0.1",
      label: "Browser Runtime",
      port: environmentPort(environment.OPENSTEER_BROWSER_PORT, 4312, "OPENSTEER_BROWSER_PORT"),
    });
  }
  return listeners;
}

export async function assertDevelopmentListenersAvailable(
  listeners: readonly DevelopmentListener[],
): Promise<void> {
  for (const listener of listeners) await assertListenerAvailable(listener);
}

export function spawnInProcessGroup(
  command: string,
  arguments_: readonly string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  return spawn(command, [...arguments_], {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
  });
}

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      const arguments_ = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
      const killer = spawn("taskkill.exe", arguments_, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
}

async function assertListenerAvailable(listener: DevelopmentListener): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      const detail =
        error.code === "EADDRINUSE" ? "is already in use" : `cannot be bound: ${error.message}`;
      rejectPromise(
        new Error(`${listener.label} listener ${listener.host}:${listener.port} ${detail}.`),
      );
    });
    server.listen(listener.port, listener.host, () => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
  });
}

async function readLockOwner(
  path: string,
): Promise<{ readonly nonce: string; readonly pid: number; readonly publicUrl: string } | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > maximumLockBytes ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.nonce !== "string" ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) < 1 ||
      typeof parsed.publicUrl !== "string" ||
      !URL.canParse(parsed.publicUrl)
    ) {
      return null;
    }
    return { nonce: parsed.nonce, pid: parsed.pid as number, publicUrl: parsed.publicUrl };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) ? error.code !== "ESRCH" : true;
  }
}

function environmentPort(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return parsed;
}
