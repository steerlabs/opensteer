import type { RunnerConfig } from "@opensteer/config";
import { createId, harnessCatalogEntry, type ThreadAccessMode } from "@opensteer/core";
import {
  spawnSupervised,
  type HarnessProcessLaunchWrapper,
  type HarnessRuntimeBoundary,
} from "@opensteer/harness";
import type { MachineAccessRunContext, MachineAccessRunMachine } from "@opensteer/protocol";
import {
  setFileMode,
  setPrivateDirectoryMode,
  setPrivateFileMode,
} from "@opensteer/shared/privateFiles";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type { RunnerLogger } from "../host/host-connection.js";
import { ShellRelay } from "./shell-relay.js";
import { shellSentence } from "./shell-transport.js";

const relaySocketPathMaxBytes = 99;
const validationProbeTimeoutMs = 10_000;
const validationProbeOutputMaxBytes = 256 * 1024;

/**
 * What one Run can reach and how its launch directory would be written, decided
 * before anything is created. Its notice is the Run's own; everything else is
 * what an engine's launch directory is built from, and stays fixed for as long
 * as that engine runs.
 */
export interface MachineAccessRoutes {
  readonly clients: { readonly scp?: string; readonly sftp?: string; readonly ssh: string };
  readonly helperBinary: string;
  /** Fitted with the notice, so the notice names exactly what ssh_config addresses. */
  readonly inventory: MachineAccessRunContext;
  readonly notice: string;
  readonly platform: "darwin" | "linux";
}

export type MachineAccessPlan = MachineAccessRoutes | MachineAccessUnavailable;

/**
 * An engine's launch directory — shims, ssh_config, known_hosts — and the relay
 * socket in it. The engine's PATH and sandbox are fixed to it when the engine
 * starts, so it lives as long as the engine; its relay is lent to one Run at a
 * time.
 */
export interface MachineAccessSetup {
  readonly environment: Readonly<Record<string, string>>;
  readonly machineAccessPlatform: "darwin" | "linux";
  readonly machineAccessRelaySocket: string;
  readonly launchDirectory: string;
  readonly relay: Pick<ShellRelay, "bind" | "suspend">;
  /** The exact launch seam the probe went through; the harness must start through the same one. */
  readonly wrapProcessLaunch: HarnessProcessLaunchWrapper;
  /** Ends every connection, stops listening and removes the launch directory. */
  close(): Promise<void>;
}

/**
 * Why a Run has no reachable computers. Each reason becomes one sentence in the
 * model's notice, so the agent can tell the person what actually stands in the
 * way instead of guessing at settings that are already right.
 */
export type MachineAccessUnavailableReason =
  | "none-reachable"
  | "platform"
  | "driver-unsupported"
  | "driver-access-mode"
  | "no-ssh"
  | "probe-failed";

export interface MachineAccessUnavailable {
  readonly reason: MachineAccessUnavailableReason;
}

export type MachineAccessOutcome = MachineAccessSetup | MachineAccessUnavailable;

export function isMachineAccessSetup(outcome: MachineAccessOutcome): outcome is MachineAccessSetup {
  return "machineAccessRelaySocket" in outcome;
}

export function isMachineAccessRoutes(plan: MachineAccessPlan): plan is MachineAccessRoutes {
  return "inventory" in plan;
}

export interface MachineAccessValidationCommand {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  /** The Run's Workspace: harness commands start there, so the probe does too. */
  readonly workingDirectory: string;
}

export interface MachineAccessValidationHook {
  execute(command: MachineAccessValidationCommand): Promise<{ readonly stdout: string }>;
}

/**
 * Whether this Run's harness can reach the relay socket, measured per driver
 * and access mode rather than assumed per boundary, and declared on the
 * harness catalog entry (`machineAccess` in `harnessCatalog`). Claude's sandbox takes an
 * explicit Unix-socket allowance on every platform. Codex's sandbox allows
 * AF_UNIX exactly when its network is on, which Opensteer's full-access
 * configuration turns on for both boundaries; every other Codex mode denies
 * connect() outright and has no per-path allowance, so nothing is set up and
 * the notice says why. A driver kind the catalog does not name is denied:
 * nothing has measured what its sandbox permits.
 */
export function machineAccessUnavailableReason(
  platform: NodeJS.Platform,
  driverKind: string,
  accessMode: ThreadAccessMode,
): MachineAccessUnavailableReason | undefined {
  const machineAccess = harnessCatalogEntry(driverKind)?.machineAccess;
  if (!machineAccess) return "driver-unsupported";
  if (!machineAccess.platforms.some((supported) => supported === platform)) return "platform";
  if (machineAccess.accessModes === "all") return undefined;
  return machineAccess.accessModes.includes(accessMode) ? undefined : "driver-access-mode";
}

export function isMachineAccessEligible(
  platform: NodeJS.Platform,
  driverKind: string,
  accessMode: ThreadAccessMode,
): boolean {
  return machineAccessUnavailableReason(platform, driverKind, accessMode) === undefined;
}

export async function planMachineAccess(options: {
  readonly accessMode: ThreadAccessMode;
  readonly driverKind: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly helperBinary: string;
  readonly machineAccess: MachineAccessRunContext;
  readonly now?: number;
  readonly platform?: NodeJS.Platform;
}): Promise<MachineAccessPlan> {
  const platform = options.platform ?? process.platform;
  if (options.machineAccess.machines.length === 0) {
    return { reason: "none-reachable" };
  }
  const ineligible = machineAccessUnavailableReason(
    platform,
    options.driverKind,
    options.accessMode,
  );
  if (ineligible || (platform !== "darwin" && platform !== "linux")) {
    return { reason: ineligible ?? "platform" };
  }
  // What the note lists is what the ssh config addresses: one fitted list
  // feeds both, so the note never names a computer the Run cannot reach, and
  // one clock reading keeps the delivered note the size that was fitted.
  const now = options.now ?? Date.now();
  const inventory = fitMachineAccessNotice(options.machineAccess, now);
  if (inventory.machines.length === 0) return { reason: "none-reachable" };
  const path = options.environment.PATH;
  const clients = path ? await resolveClientBinaries(path) : undefined;
  if (!clients) return { reason: "no-ssh" };
  return {
    clients,
    helperBinary: resolve(options.helperBinary),
    inventory,
    notice: renderMachineAccessNotice(inventory, now),
    platform,
  };
}

/**
 * Everything a launch directory is written from, for the warm-engine key: two
 * Runs with the same value can share one engine's launch directory. The route
 * manifest is each fitted computer's alias, Runner and pinned host key; what
 * the note says about a computer — online, shares, commands, forwarding — is
 * the Run's and is left out, since the Host authorizes every connection
 * against the live policy. A launch that could not be set up is its own
 * value, which no plan produces, so the next Run starts a fresh engine.
 */
export function machineAccessLaunchIdentity(plan: MachineAccessPlan | undefined): string {
  if (!plan) return JSON.stringify(null);
  if (!isMachineAccessRoutes(plan)) return JSON.stringify({ unavailable: plan.reason });
  return JSON.stringify({
    clients: [plan.clients.ssh, plan.clients.scp ?? null, plan.clients.sftp ?? null],
    helperBinary: plan.helperBinary,
    platform: plan.platform,
    routes: plan.inventory.machines
      .map((machine) => [machine.alias, machine.runnerId, machine.hostPublicKey])
      .sort((left, right) => (left.join("\n") < right.join("\n") ? -1 : 1)),
  });
}

/** The Runners a Run's relay binding may reach: exactly what its note lists. */
export function machineAccessTargets(plan: MachineAccessRoutes): readonly string[] {
  return plan.inventory.machines.map((machine) => machine.runnerId);
}

export async function setupMachineAccess(options: {
  readonly environment: Readonly<Record<string, string>>;
  readonly logger?: RunnerLogger;
  readonly plan: MachineAccessRoutes;
  readonly privateStateRoot: string;
  readonly runtimeBoundary: HarnessRuntimeBoundary;
  readonly temporaryDirectory?: string;
  readonly transport: Pick<RunnerConfig, "controlCaPath" | "hostUrl" | "mode">;
  readonly validationHook?: MachineAccessValidationHook;
  /** Where the harness will run, and so where the setup probe runs. */
  readonly workspacePath: string;
  /**
   * How this Run's harness launches a model command under its own command
   * sandbox. The probe goes through it first, then through the Runner's
   * process-launch seam, so what it proves is what a command the model runs
   * will find.
   */
  readonly wrapModelCommand: HarnessProcessLaunchWrapper;
  /**
   * The Runner's process-launch seam for this Run, given the launch directory
   * once it exists.
   */
  readonly wrapProcessLaunch: (launchDirectory: string) => Promise<HarnessProcessLaunchWrapper>;
}): Promise<MachineAccessOutcome> {
  const { plan } = options;
  const path = options.environment.PATH ?? "";
  let launchDirectory: string | undefined;
  let relay: ShellRelay | undefined;
  try {
    launchDirectory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "opensteer-"));
    await setPrivateDirectoryMode(launchDirectory);
    const canonicalLaunch = await realpath(launchDirectory);
    const canonicalPrivate = await canonicalPath(options.privateStateRoot);
    if (pathContains(canonicalPrivate, canonicalLaunch)) {
      throw new Error("Machine access launch directory resolved inside Runner private state");
    }
    const relaySocket = join(canonicalLaunch, "relay.sock");
    if (Buffer.byteLength(relaySocket, "utf8") > relaySocketPathMaxBytes) {
      throw new Error("Machine access relay socket path must be shorter than 100 UTF-8 bytes");
    }
    const binDirectory = join(canonicalLaunch, "bin");
    await mkdir(binDirectory, { mode: 0o700 });
    await setPrivateDirectoryMode(binDirectory);
    await access(plan.helperBinary, constants.X_OK);

    const machines = plan.inventory.machines;
    const configPath = join(canonicalLaunch, "ssh_config");
    const knownHostsPath = join(canonicalLaunch, "known_hosts");
    await writePrivateFile(
      configPath,
      renderSshConfig({
        helperBinary: plan.helperBinary,
        knownHostsPath,
        machines,
        nativeUser: options.runtimeBoundary.kind === "native-user",
        relaySocket,
      }),
    );
    await writePrivateFile(
      knownHostsPath,
      `${machines.map((machine) => `${machine.runnerId} ${machine.hostPublicKey}`).join("\n")}\n`,
    );
    for (const name of ["ssh", "scp", "sftp"] as const) {
      const binary = plan.clients[name];
      if (!binary) continue;
      const shim = join(binDirectory, name);
      await writeFile(shim, renderShim(binary, configPath), { mode: 0o700 });
      await setFileMode(shim, 0o700);
    }

    const validationTarget = createId("runner");
    relay = new ShellRelay({
      socketPath: relaySocket,
      transport: options.transport,
      validationTarget,
    });
    await relay.start();
    const environment = Object.freeze({
      ...options.environment,
      PATH: `${binDirectory}${delimiter}${path}`,
    });
    // v3.2: one probe for every Runner kind, launched the way the Runner
    // launches harness commands. The test harness may inject its own.
    const validationHook = options.validationHook ?? harnessLaunchValidationHook;
    // A sandbox that cannot be planned is a Run that cannot start, not a probe
    // that failed; it is cleaned up here and reported by the caller.
    const wrapProcessLaunch = await options
      .wrapProcessLaunch(canonicalLaunch)
      .catch(async (error: unknown) => {
        await relay?.close().catch(() => undefined);
        await rm(canonicalLaunch, { force: true, recursive: true }).catch(() => undefined);
        throw new SandboxPlanError(error);
      });
    const relayProbeError = await validateMachineAccessSetup({
      alias: machines[0]?.alias,
      environment,
      helperBinary: plan.helperBinary,
      knownHostsPath,
      proxyTarget: validationTarget,
      relaySocket,
      runnerId: machines[0]?.runnerId,
      validationHook: {
        execute: (command) => {
          const launch = wrapProcessLaunch(
            options.wrapModelCommand({
              args: command.arguments,
              cwd: command.workingDirectory,
              environment: command.environment,
              executable: command.executable,
            }),
          );
          return validationHook.execute({
            arguments: launch.args,
            environment: launch.environment,
            executable: launch.executable,
            workingDirectory: launch.cwd,
          });
        },
      },
      workingDirectory: options.workspacePath,
    });
    // The relay is the judge of the second probe: it answers the request line
    // itself, so a reply of either kind proves the socket was reached from the
    // harness launch surface. Only a probe that never got that far matters.
    if (!relay.validationAnswered) {
      throw (
        relayProbeError ??
        new Error("The harness launch surface did not reach the shell relay socket")
      );
    }
    const activeRelay = relay;
    return {
      close: async () => {
        await activeRelay.close();
        await rm(canonicalLaunch, { force: true, recursive: true });
      },
      environment,
      launchDirectory: canonicalLaunch,
      machineAccessPlatform: plan.platform,
      machineAccessRelaySocket: relaySocket,
      relay: activeRelay,
      wrapProcessLaunch,
    };
  } catch (error) {
    if (error instanceof SandboxPlanError) throw error.cause;
    await relay?.close().catch(() => undefined);
    if (launchDirectory)
      await rm(launchDirectory, { force: true, recursive: true }).catch(() => undefined);
    options.logger?.error("Machine access was not set up for this Run", {
      error: safeMessage(error, { fallback: "Machine access setup failed", singleLine: true }),
    });
    return { reason: "probe-failed" };
  }
}

export function renderSshConfig(options: {
  readonly helperBinary: string;
  readonly knownHostsPath: string;
  readonly machines: readonly MachineAccessRunMachine[];
  readonly nativeUser: boolean;
  readonly relaySocket: string;
}): string {
  const blocks = options.machines.map((machine) => {
    const proxyCommand = `${shellQuote(escapeSshTokens(options.helperBinary))} ssh-proxy --relay ${shellQuote(
      escapeSshTokens(options.relaySocket),
    )} %h`;
    return [
      `Host ${machine.alias}`,
      `  HostName ${machine.runnerId}`,
      "  User opensteer",
      `  ProxyCommand ${proxyCommand}`,
      `  UserKnownHostsFile ${sshToken(options.knownHostsPath)}`,
      "  StrictHostKeyChecking yes",
      "  CheckHostIP no",
      "  IdentitiesOnly yes",
      "  IdentityFile none",
      "  IdentityAgent none",
      "  PreferredAuthentications none",
      "  BatchMode yes",
      "  ControlMaster no",
      "  ControlPath none",
      "  ControlPersist no",
      "  ForwardAgent no",
      "  ForwardX11 no",
      "  ClearAllForwardings no",
      "  RequestTTY no",
      "  ServerAliveInterval 15",
      "  ServerAliveCountMax 3",
      "  GlobalKnownHostsFile /dev/null",
      "  KnownHostsCommand none",
      "  VerifyHostKeyDNS no",
      "  UpdateHostKeys no",
      "  HostKeyAlgorithms ssh-ed25519",
      "  CanonicalizeHostname no",
    ].join("\n");
  });
  if (options.nativeUser) {
    const patterns = [...options.machines.map((machine) => `!${machine.alias}`), "*"].join(",");
    blocks.push(`Match originalhost ${patterns}\n  Include ~/.ssh/config`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function renderShim(realBinary: string, configPath: string): string {
  return `#!/bin/sh\nexec ${doubleQuotedShell(realBinary)} -F ${doubleQuotedShell(configPath)} "$@"\n`;
}

/**
 * What the model reads when no computer is reachable. It is stated rather than
 * omitted because a resumed conversation may still hold an earlier Run's list,
 * and only an explicit replacement can retire it.
 */
export function noReachableComputersNotice(callerMachineName: string): string {
  return `This Run is on ${callerMachineName}. ${machineAccessUnavailableSentence("none-reachable")}`;
}

/**
 * The largest note a Run may carry. Codex accepts a per-turn context value of
 * at most 1,000 tokens, which it estimates at four bytes each and truncates
 * from the middle beyond that; a note cut in the middle would name computers
 * the Run cannot address or lose the guidance at its end. Whole machines are
 * dropped and counted instead, the way the Host fits the list to its own
 * transport budget.
 */
export const machineAccessNoticeMaxBytes = 3 * 1024;

// Folder details must not let one computer consume the entire Run's inventory.
// Keep complete paths: a shortened path would name a different resource.
const machineNoticeSharesMaxBytes = 512;
const machineNoticeSharesMaxCount = 3;

function renderMachineNoticeShares(shares: MachineAccessRunMachine["shares"]): string {
  if (shares.length === 0) return "no shared folders";
  const listed: string[] = [];
  let bytes = 0;
  for (const share of shares) {
    const entry = `${share.path} (${share.mode === "read" ? "read-only" : "read-write"})`;
    const size = Buffer.byteLength(entry, "utf8") + (listed.length > 0 ? 2 : 0);
    if (
      listed.length >= machineNoticeSharesMaxCount ||
      bytes + size > machineNoticeSharesMaxBytes
    ) {
      continue;
    }
    listed.push(entry);
    bytes += size;
  }
  const omitted = shares.length - listed.length;
  const summary =
    omitted > 0 ? `${omitted} shared ${omitted === 1 ? "folder" : "folders"} not listed` : "";
  return [listed.length > 0 ? `shares ${listed.join(", ")}` : "", summary]
    .filter(Boolean)
    .join("; ");
}

/**
 * What the macOS grant means for the commands the agent is about to write.
 *
 * Only a Mac has the gate, so only a Mac says anything: a clause on a Linux
 * computer would describe a setting that does not exist there. When it is off,
 * the clause says protected data may be unavailable without claiming that this
 * one permission is the only macOS gate on every protected location.
 */
function renderMachineNoticeFullAccess(machine: MachineAccessRunMachine): string {
  if (machine.platform !== "darwin" || machine.fullDiskAccess === null) return "";
  return machine.fullDiskAccess
    ? "; macOS Full Disk Access on"
    : "; macOS Full Disk Access off (some protected data may be unavailable)";
}

export function fitMachineAccessNotice(
  context: MachineAccessRunContext,
  now = Date.now(),
): MachineAccessRunContext {
  const machines = [...context.machines];
  let omittedMachines = context.omittedMachines;
  while (
    machines.length > 0 &&
    Buffer.byteLength(
      renderMachineAccessNotice(
        { callerMachineName: context.callerMachineName, machines, omittedMachines },
        now,
      ),
      "utf8",
    ) > machineAccessNoticeMaxBytes
  ) {
    machines.pop();
    omittedMachines += 1;
  }
  return { callerMachineName: context.callerMachineName, machines, omittedMachines };
}

/**
 * One sentence per reason, written for the person the agent will relay it to.
 * Nothing here names a setting to change on the target computer: when a Run
 * cannot reach anything, the cause is on this Runner or in this Run.
 */
export function machineAccessUnavailableSentence(reason: MachineAccessUnavailableReason): string {
  switch (reason) {
    case "none-reachable":
      return "No other computers are reachable from this Run. Nothing in the opensteer-computers skill applies.";
    case "platform":
      return "This Runner's operating system cannot reach other computers.";
    case "driver-unsupported":
      return "This AI engine cannot reach other computers.";
    case "driver-access-mode":
      return "This AI engine reaches other computers only in Full access mode, and this Run is not in it; a new Run in Full access can.";
    case "no-ssh":
      return "This Runner has no ssh client on its PATH.";
    case "probe-failed":
      return "This Runner could not reach its own shell relay, so no computer is addressable this Run.";
  }
}

export function renderMachineAccessNotice(
  context: MachineAccessRunContext,
  now = Date.now(),
  unavailable?: MachineAccessUnavailableReason,
): string {
  if (context.machines.length === 0 && context.omittedMachines === 0)
    return noReachableComputersNotice(context.callerMachineName);
  const lines = [
    `This Run is on ${context.callerMachineName}.`,
    context.machines.length === 0
      ? `No computers are listed for access from this Run.${
          unavailable ? ` ${machineAccessUnavailableSentence(unavailable)}` : ""
        }`
      : "Other computers you can reach over SSH (ssh, scp, sftp, rsync, git as usual; no interactive terminal, so run non-interactive commands):",
    ...context.machines.map((machine) => {
      const platform = machine.platform === "darwin" ? "macOS" : "Linux";
      const status =
        machine.status === "online"
          ? "online"
          : machine.lastSeenAt
            ? `offline ${relativeTime(Date.parse(machine.lastSeenAt), now)}`
            : "offline, never seen";
      const shares = renderMachineNoticeShares(machine.shares);
      return `- ${machine.alias} (${platform}, ${status}): ${shares}; commands ${machine.commands ? "allowed" : "off"}; port forwarding ${machine.forwarding ? "allowed" : "off"}${renderMachineNoticeFullAccess(machine)}.`;
    }),
  ];
  if (context.omittedMachines > 0) {
    lines.push(
      context.omittedMachines === 1
        ? "…and 1 more computer is not listed and cannot be addressed this Run."
        : `…and ${context.omittedMachines} more computers are not listed and cannot be addressed this Run.`,
    );
  }
  lines.push(
    "Paths are absolute or relative to that computer's home. Commands run as that computer's Opensteer account. A refusal means the owner's access settings said no, not that your command was wrong. Sessions end when your Run ends. Details: the opensteer-computers skill.",
  );
  return lines.join("\n");
}

/** Carries a sandbox planning failure past the probe-failure handling that follows it. */
class SandboxPlanError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("The Runner sandbox could not be planned for this Run");
    this.cause = cause;
  }
}

/**
 * Proves the launch surface the harness will actually use: `ssh` resolves the
 * managed alias through the shim, and the helper reaches the relay socket. The
 * `ssh -G` probe must succeed outright; the relay probe's verdict belongs to
 * the relay, so its failure is returned rather than thrown.
 */
async function validateMachineAccessSetup(options: {
  readonly alias: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
  readonly helperBinary: string;
  readonly knownHostsPath: string;
  readonly proxyTarget: string;
  readonly relaySocket: string;
  readonly runnerId: string | undefined;
  readonly validationHook: MachineAccessValidationHook;
  readonly workingDirectory: string;
}): Promise<Error | undefined> {
  if (!options.alias || !options.runnerId) throw new Error("Machine access has no managed alias");
  const result = await options.validationHook.execute({
    arguments: ["-G", options.alias],
    environment: options.environment,
    executable: "ssh",
    workingDirectory: options.workingDirectory,
  });
  const config = parseSshG(result.stdout);
  if (
    config.hostname !== options.runnerId ||
    !config.proxycommand?.includes("ssh-proxy") ||
    resolve(config.userknownhostsfile ?? "") !== resolve(options.knownHostsPath)
  ) {
    throw new Error("OpenSSH did not resolve the managed machine configuration as expected");
  }
  try {
    await options.validationHook.execute({
      arguments: ["ssh-proxy", "--relay", options.relaySocket, options.proxyTarget],
      environment: options.environment,
      executable: options.helperBinary,
      workingDirectory: options.workingDirectory,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error(safeMessage(error, { fallback: "The shell relay probe failed" }));
  }
}

/**
 * The production probe (v3.2). It is a child process launched exactly the way
 * the Runner launches harness commands — the same supervisor, the same
 * allowlisted environment with the launch bin directory first on PATH, and the
 * Run's Workspace as its working directory — so what it proves is what the
 * harness itself will find. Every Runner kind uses it; only the test harness
 * substitutes another.
 */
export const harnessLaunchValidationHook: MachineAccessValidationHook = {
  execute: async (command) => {
    const supervised = spawnSupervised({
      args: command.arguments,
      cwd: command.workingDirectory,
      environment: command.environment,
      executable: command.executable,
      maxOutputBytes: validationProbeOutputMaxBytes,
      signal: AbortSignal.timeout(validationProbeTimeoutMs),
    });
    // Nothing is piped in, and the relay proxy copies stdin until it ends.
    supervised.child.stdin?.end();
    const [stdout, stderr, exit] = await Promise.allSettled([
      collectProbeOutput(supervised.stdout),
      collectProbeOutput(supervised.stderr),
      supervised.exited,
    ]);
    if (exit.status === "rejected") {
      throw new Error(
        shellSentence(
          safeMessage(exit.reason, {
            fallback: "The setup probe could not start",
            singleLine: true,
          }),
          "The setup probe could not start",
        ),
      );
    }
    if (exit.value.code !== 0) {
      const detail = stderr.status === "fulfilled" ? stderr.value.trim().split("\n").at(-1) : "";
      throw new Error(
        `${command.executable} ${command.arguments[0] ?? ""} failed during machine access setup${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return { stdout: stdout.status === "fulfilled" ? stdout.value : "" };
  },
};

async function collectProbeOutput(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveClientBinaries(
  path: string,
): Promise<{ readonly scp?: string; readonly sftp?: string; readonly ssh: string } | undefined> {
  const [ssh, scp, sftp] = await Promise.all([
    findExecutable("ssh", path),
    findExecutable("scp", path),
    findExecutable("sftp", path),
  ]);
  if (!ssh) return undefined;
  return {
    ...(scp ? { scp } : {}),
    ...(sftp ? { sftp } : {}),
    ssh,
  };
}

async function findExecutable(name: string, path: string): Promise<string | undefined> {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH exactly as a shell would.
    }
  }
  return undefined;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await setPrivateFileMode(path);
}

function sshToken(value: string): string {
  assertSingleLinePath(value);
  return `"${escapeSshTokens(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function escapeSshTokens(value: string): string {
  assertSingleLinePath(value);
  return value.replace(/%/gu, "%%");
}

function shellQuote(value: string): string {
  assertSingleLinePath(value);
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function doubleQuotedShell(value: string): string {
  assertSingleLinePath(value);
  return `"${value.replace(/[\\"$`]/gu, "\\$&")}"`;
}

function assertSingleLinePath(value: string): void {
  if (/[\0\r\n]/u.test(value)) throw new Error("Machine access paths must fit on one line");
}

function parseSshG(output: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) parsed[line.slice(0, space)] ??= line.slice(space + 1);
  }
  return parsed;
}

function relativeTime(then: number, now: number): string {
  const milliseconds = Math.max(0, now - then);
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
