import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { assertRegularFile } from "@opensteer/shared/privateFiles";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DesktopLocalExecutionStatusSchema,
  type DesktopLocalExecutionStatus,
  type DesktopPortableFsIssue,
  type DesktopPortableFsState,
} from "@opensteer/protocol/desktop";
import {
  PortableFsCliRunner,
  type PortableFsMountCheckResult,
} from "@opensteer/workspace-portablefs";
import type { DesktopLocalExecutionConfiguration } from "../config.js";

const requiredFeature = "hosted-automatic-mount-reauthorization-v2";
const approvalMarkerVersion = 1;
const installerTimeoutMs = 15 * 60_000;
const installerOutputLimit = 2 * 1_024 * 1_024;

export interface PortableFsSetupDependencies {
  readonly homeDirectory?: string;
  readonly openApplication?: (path: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly runInstaller?: (path: string, version: string, signal?: AbortSignal) => Promise<void>;
}

export interface PortableFsSetupSnapshot {
  readonly binaryPath: string | null;
  readonly detail: string;
  readonly installAvailable: boolean;
  readonly issue: DesktopPortableFsIssue;
  readonly state: DesktopPortableFsState;
  readonly version: string | null;
}

export class PortableFsSetupService {
  readonly #approvalMarkerPath: string;
  readonly #config: DesktopLocalExecutionConfiguration;
  readonly #homeDirectory: string;
  readonly #openApplication: (path: string) => Promise<void>;
  readonly #platform: NodeJS.Platform;
  readonly #runInstaller: NonNullable<PortableFsSetupDependencies["runInstaller"]>;
  #installing: Promise<PortableFsSetupSnapshot> | undefined;

  constructor(
    config: DesktopLocalExecutionConfiguration,
    dependencies: PortableFsSetupDependencies = {},
  ) {
    this.#config = config;
    this.#homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
    this.#platform = dependencies.platform ?? process.platform;
    this.#approvalMarkerPath = path.join(config.dataDirectory, "portablefs-approval.json");
    this.#openApplication = dependencies.openApplication ?? openMacApplication;
    this.#runInstaller = dependencies.runInstaller ?? runPortableFsInstaller;
  }

  async status(): Promise<PortableFsSetupSnapshot> {
    if (this.#installing) {
      return {
        binaryPath: null,
        detail: "Installing the signed PortableFS release…",
        installAvailable: true,
        issue: null,
        state: "installing",
        version: null,
      };
    }
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      return {
        binaryPath: null,
        // Shared-storage mounts, not local execution: this machine still runs
        // agents on directories of its own.
        detail:
          this.#platform === "win32"
            ? "Windows runs agents on this computer's own folders; shared Workspace storage needs macOS or Linux."
            : "Shared Workspace storage currently requires macOS FSKit or Linux FUSE.",
        installAvailable: false,
        issue: "unsupported-os",
        state: "unsupported",
        version: null,
      };
    }
    const binaryPath = await this.#findBinary();
    if (!binaryPath) {
      return {
        binaryPath: null,
        detail: this.#config.portableFsInstaller
          ? "PortableFS is not installed on this computer."
          : "This Opensteer build does not contain a pinned PortableFS installer.",
        installAvailable: this.#config.portableFsInstaller !== undefined,
        issue: null,
        state: "missing",
        version: null,
      };
    }
    return this.#inspectBinary(binaryPath);
  }

  install(signal?: AbortSignal): Promise<PortableFsSetupSnapshot> {
    if (this.#installing) return this.#installing;
    const installer = this.#config.portableFsInstaller;
    if (!installer) throw new Error("This Opensteer build has no pinned PortableFS installer.");
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error("PortableFS installation is unsupported on this platform.");
    }
    const operation = (async () => {
      await assertRegularFile(installer.path, "PortableFS installer");
      await this.#runInstaller(installer.path, installer.version, signal);
      const snapshot = await this.statusAfterInstall();
      if (snapshot.state === "missing" || snapshot.state === "failed") {
        throw new Error(snapshot.detail);
      }
      return snapshot;
    })();
    this.#installing = operation;
    void operation.then(
      () => {
        if (this.#installing === operation) this.#installing = undefined;
      },
      () => {
        if (this.#installing === operation) this.#installing = undefined;
      },
    );
    return operation;
  }

  async acknowledgeApproval(): Promise<PortableFsSetupSnapshot> {
    if (this.#platform !== "darwin") return this.status();
    const binaryPath = await this.#findBinary();
    if (!binaryPath) throw new Error("PortableFS must be installed before FSKit setup can finish.");
    await writeApprovalMarker(this.#approvalMarkerPath);
    return this.#inspectBinary(binaryPath);
  }

  async openSetup(): Promise<PortableFsSetupSnapshot> {
    if (this.#platform !== "darwin") return this.status();
    const appPath = path.join(this.#homeDirectory, "Applications", "PortableFS.app");
    const metadata = await lstat(appPath).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("The signed PortableFS app is not installed at its canonical location.");
    }
    await this.#openApplication(appPath);
    return this.status();
  }

  async requireReadyBinary(): Promise<string> {
    const snapshot = await this.status();
    if (snapshot.state !== "ready-to-mount" || !snapshot.binaryPath) {
      throw new Error(snapshot.detail);
    }
    return snapshot.binaryPath;
  }

  private async statusAfterInstall(): Promise<PortableFsSetupSnapshot> {
    const binaryPath = await this.#findBinary();
    if (!binaryPath) {
      return {
        binaryPath: null,
        detail: "PortableFS installation completed without publishing its signed CLI.",
        installAvailable: true,
        issue: null,
        state: "failed",
        version: null,
      };
    }
    return this.#inspectBinary(binaryPath);
  }

  async #findBinary(): Promise<string | null> {
    const candidates = this.#config.portableFsBinary
      ? [this.#config.portableFsBinary]
      : this.#platform === "darwin"
        ? [
            path.join(
              this.#homeDirectory,
              "Applications",
              "PortableFS.app",
              "Contents",
              "Helpers",
              "portablefs",
            ),
            path.join(this.#homeDirectory, ".local", "bin", "portablefs"),
          ]
        : [path.join(this.#homeDirectory, ".local", "bin", "portablefs")];
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Try the next canonical install location.
      }
    }
    return null;
  }

  async #inspectBinary(binaryPath: string): Promise<PortableFsSetupSnapshot> {
    try {
      const cli = new PortableFsCliRunner({ binary: binaryPath });
      const version = await cli.getVersion({ timeoutMs: 10_000 });
      if (!version.features?.includes(requiredFeature)) {
        return snapshot(
          binaryPath,
          `PortableFS ${version.version} is incompatible with automatic Workspace mount renewal.`,
          "failed",
          version.version,
          this.#config.portableFsInstaller !== undefined,
          null,
        );
      }
      const support = await cli.checkMountSupport({ strategy: "auto", timeoutMs: 10_000 });
      const blocked = blockedMountSupport(support);
      if (blocked) {
        return snapshot(
          binaryPath,
          blocked.message,
          "failed",
          version.version,
          this.#config.portableFsInstaller !== undefined,
          portableFsIssue(blocked.code),
        );
      }
      if (!("facts" in support) || !support.facts) {
        return snapshot(
          binaryPath,
          "PortableFS returned no mount readiness facts.",
          "failed",
          version.version,
          this.#config.portableFsInstaller !== undefined,
          null,
        );
      }
      if (
        support.facts.state !== "verified" &&
        this.#platform === "darwin" &&
        !(await approvalAcknowledged(this.#approvalMarkerPath))
      ) {
        return snapshot(
          binaryPath,
          "PortableFS is installed. macOS requires one user-approved File System Extension setting before the first Workspace mount.",
          "needs-user-approval",
          version.version,
          this.#config.portableFsInstaller !== undefined,
          portableFsIssue(support.facts.issue ?? null),
        );
      }
      return snapshot(
        binaryPath,
        support.facts.state === "verified"
          ? support.facts.summary
          : "PortableFS is ready; the first real Workspace mount will provide authoritative verification.",
        "ready-to-mount",
        version.version,
        this.#config.portableFsInstaller !== undefined,
        null,
      );
    } catch (error) {
      return snapshot(
        binaryPath,
        safeDetail(error, "PortableFS readiness check failed."),
        "failed",
        null,
        this.#config.portableFsInstaller !== undefined,
        null,
      );
    }
  }
}

export function localExecutionPlatform(
  platform: NodeJS.Platform,
): DesktopLocalExecutionStatus["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "unsupported";
}

export function localExecutionStatus(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
  portableFs: PortableFsSetupSnapshot,
  runner: DesktopLocalExecutionStatus["runner"],
  computer: {
    readonly computerName: string;
    readonly mayRunAgents: boolean;
    readonly runAgents: boolean;
  },
  platform: NodeJS.Platform = process.platform,
): DesktopLocalExecutionStatus {
  return DesktopLocalExecutionStatusSchema.parse({
    available: true,
    computerName: computer.computerName,
    deploymentId,
    mayRunAgents: computer.mayRunAgents,
    platform: localExecutionPlatform(platform),
    portableFs,
    runAgents: computer.runAgents,
    runner,
    schemaVersion: 4,
  });
}

export function unavailableLocalExecutionStatus(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
  computerName: string,
  platform: NodeJS.Platform = process.platform,
): DesktopLocalExecutionStatus {
  const detail = "This Opensteer release does not include local agent support.";
  return DesktopLocalExecutionStatusSchema.parse({
    available: false,
    computerName,
    deploymentId,
    mayRunAgents: false,
    platform: localExecutionPlatform(platform),
    portableFs: {
      binaryPath: null,
      detail,
      installAvailable: false,
      issue: null,
      state: "unsupported",
      version: null,
    },
    runner: {
      detail,
      enrolled: false,
      environmentId: null,
      runnerId: null,
      state: "disabled",
    },
    runAgents: false,
    schemaVersion: 4,
  });
}

function snapshot(
  binaryPath: string,
  detail: string,
  state: DesktopPortableFsState,
  version: string | null,
  installAvailable: boolean,
  issue: DesktopPortableFsIssue,
): PortableFsSetupSnapshot {
  return { binaryPath, detail, installAvailable, issue, state, version };
}

function portableFsIssue(value: string | null): DesktopPortableFsIssue {
  return value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 120 ? value : null;
}

function blockedMountSupport(
  result: PortableFsMountCheckResult,
): { readonly code: string | null; readonly message: string } | null {
  return "error" in result && result.error
    ? { code: result.error.code ?? null, message: result.error.message }
    : null;
}

/** Rebuildable approval cache: an unknown marker version requires approval again. */
async function approvalAcknowledged(markerPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_096) return false;
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { version?: unknown };
    return parsed.version === approvalMarkerVersion;
  } catch {
    return false;
  }
}

async function writeApprovalMarker(markerPath: string): Promise<void> {
  await mkdir(path.dirname(markerPath), { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(path.dirname(markerPath));
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: approvalMarkerVersion })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, markerPath);
    await setPrivateFileMode(markerPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function openMacApplication(appPath: string): Promise<void> {
  await runBounded("/usr/bin/open", [appPath], {}, 30_000, 64 * 1_024);
}

async function runPortableFsInstaller(
  installerPath: string,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    HOME: homedir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
    PORTABLEFS_VERSION: version,
  };
  await runBounded(
    "/bin/sh",
    [installerPath],
    environment,
    installerTimeoutMs,
    installerOutputLimit,
    signal,
  );
}

async function runBounded(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      detached: true,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => terminate(new Error("PortableFS setup timed out.")), timeoutMs);
    timer.unref();
    const onAbort = () => terminate(new Error("PortableFS setup was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const consume = (value: Buffer) => {
      bytes += value.byteLength;
      if (bytes > maxOutputBytes) {
        terminate(new Error("PortableFS setup produced too much output."));
        return;
      }
      output = `${output}${value.toString("utf8")}`.slice(-8_192);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, childSignal) => {
      if (terminationError) finish(terminationError);
      else if (code === 0) finish();
      else
        finish(
          new Error(
            `PortableFS setup failed (${childSignal ?? `exit ${code ?? "unknown"}`}): ${safeInstallerOutput(output)}`,
          ),
        );
    });

    function terminate(error: Error): void {
      if (settled || terminationError) return;
      terminationError = error;
      killProcessGroup(child.pid, child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(child.pid, child, "SIGKILL"), 5_000);
      forceKillTimer.unref();
    }

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise();
    }
  });
}

function killProcessGroup(
  processId: number | undefined,
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (processId) {
    try {
      process.kill(-processId, signal);
      return;
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
  child.kill(signal);
}

function safeInstallerOutput(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(-2_000);
}

function safeDetail(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 2_000) || fallback;
}
