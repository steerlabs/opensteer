import { z } from "zod";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runningSupervisedProcesses, type HarnessProcessLaunchWrapper } from "@opensteer/harness";

const execFileAsync = promisify(execFile);

/**
 * Names the execution a process belongs to. A process inherits it from the
 * launch the Runner wrapped and passes it on to everything it starts, including
 * descendants that leave its process group. A descendant that drops it is
 * still found below one that carries it.
 */
export const executionScopeVariable = "OPENSTEER_EXECUTION_SCOPE";

/** How long an execution's processes get to exit after SIGTERM before SIGKILL. */
const terminationGraceMs = 2_000;
/** How long SIGKILLed processes get to disappear before termination is unknown. */
const killSettleMs = 3_000;
const pollMs = 100;

/**
 * `unknown`: something of the execution survived even SIGKILL. `unverifiable`:
 * this platform cannot list an execution's processes at all.
 */
export type TerminationProof = "proven" | "unknown" | "unverifiable";

export const RunnerShutdownProofSchema = z.strictObject({
  bootId: z.string().regex(/^rbt_[a-zA-Z0-9_-]+$/u),
  termination: z.enum(["proven", "unknown", "unverifiable"]),
  processIdentities: z.array(z.string()),
  unconfirmedScopes: z.array(z.string()).default([]),
});
export type RunnerShutdownProof = z.infer<typeof RunnerShutdownProofSchema>;

export async function confirmRunnerShutdown(
  dataDirectory: string,
  proof?: Pick<RunnerShutdownProof, "bootId" | "processIdentities">,
  options?: { readonly terminationGraceMs?: number },
): Promise<boolean> {
  const containment = new ExecutionContainment({
    bootId: proof?.bootId ?? "desktop",
    dataDirectory,
    ...(options?.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
  });
  if (!proof) {
    await containment.reapEarlierBoots();
    return false;
  }
  return (await containment.reapBoot(proof.processIdentities)) === "proven";
}

/** One of the Runner user's processes, and the execution its environment names, if any. */
interface ListedProcess {
  /** The pid and when the process started: a pid the system gave out again is another process. */
  readonly identity: string;
  readonly pid: number;
  readonly ppid: number;
  readonly processGroupId?: number;
  readonly scope: string | null;
  /** True when this process's start environment or identity could not be read. */
  readonly unreadable?: boolean;
  /** How to signal it when that is not `process.kill`. */
  readonly signal?: (name: NodeJS.Signals) => void;
}

/** Result of one process scan; `incomplete` means the scanner knows it could have missed a member. */
interface ProcessInventory {
  readonly processes: readonly ListedProcess[];
  readonly incomplete?: boolean;
  readonly vanishedPids?: ReadonlySet<number>;
}

/** Every process of the Runner's user, with the marker each carries. */
type ProcessLister = (variable: string) => Promise<readonly ListedProcess[] | ProcessInventory>;

type ProcessProbe = (pid: number) => "alive" | "gone" | "unknown";

function normalizeInventory(result: readonly ListedProcess[] | ProcessInventory): {
  readonly processes: readonly ListedProcess[];
  readonly incomplete: boolean;
  readonly vanishedPids: ReadonlySet<number>;
} {
  if (Array.isArray(result)) {
    return {
      processes: result,
      incomplete: false,
      vanishedPids: new Set(),
    };
  }
  const inventory = result as ProcessInventory;
  return {
    processes: inventory.processes,
    incomplete: inventory.incomplete === true,
    vanishedPids: inventory.vanishedPids ?? new Set(),
  };
}

function ownRootPids(): ReadonlySet<number> {
  const roots = new Set<number>([process.pid]);
  for (const running of runningSupervisedProcesses()) {
    if (running.pid > 0) roots.add(running.pid);
  }
  return roots;
}

/**
 * An unreadable process entry (e.g. setuid EACCES on `/proc/<pid>/environ` or
 * `hidepid` EPERM on `/proc/<pid>/stat`) makes a scope unverifiable only when
 * that entry is a member or could be one: it is in the member/noted/Runner-or-
 * supervisor set, or its parent chain reaches one of those without passing
 * through a readable ancestor carrying a different execution's scope. An
 * unreadable process whose parent chain reaches PID 1 through non-members says
 * nothing about this execution.
 */
function hasRelevantUnreadable(
  processes: readonly ListedProcess[],
  members: readonly ListedProcess[],
  matches: (scope: string) => boolean,
  found: ReadonlySet<string>,
  roots: ReadonlySet<number>,
): boolean {
  let hasAnyUnreadable = false;
  for (const proc of processes) {
    if (proc.unreadable === true) {
      hasAnyUnreadable = true;
      break;
    }
  }
  if (!hasAnyUnreadable) return false;
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const memberPids = new Set(members.map((member) => member.pid));
  const notedPids = new Set<number>();
  for (const identity of found) {
    const pid = pidFromIdentity(identity);
    if (pid > 0) notedPids.add(pid);
  }
  for (const proc of processes) {
    if (proc.unreadable !== true) continue;
    if (memberPids.has(proc.pid) || notedPids.has(proc.pid) || roots.has(proc.pid)) {
      return true;
    }
    const visited = new Set<number>([proc.pid]);
    let currentPpid = proc.ppid;
    while (currentPpid > 1 && !visited.has(currentPpid)) {
      visited.add(currentPpid);
      if (memberPids.has(currentPpid) || notedPids.has(currentPpid) || roots.has(currentPpid)) {
        return true;
      }
      const parent = byPid.get(currentPpid);
      if (!parent) break;
      if (parent.scope !== null && !matches(parent.scope)) break;
      currentPpid = parent.ppid;
    }
  }
  return false;
}

function hasVanishedMemberCandidate(
  vanishedPids: ReadonlySet<number>,
  members: readonly ListedProcess[],
  found: ReadonlySet<string>,
  roots: ReadonlySet<number>,
): boolean {
  if (vanishedPids.size === 0) return false;
  for (const member of members) {
    if (vanishedPids.has(member.pid)) return true;
  }
  for (const identity of found) {
    const pid = pidFromIdentity(identity);
    if (pid > 0 && vanishedPids.has(pid)) return true;
  }
  for (const root of roots) {
    if (vanishedPids.has(root)) return true;
  }
  return false;
}

function defaultProbeAlive(pid: number): "alive" | "gone" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function pidFromIdentity(identity: string): number {
  const prefix = identity.split("@", 1)[0];
  const pid = Number(prefix);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * Finds, stops and proves gone every process one execution started.
 *
 * A Run's engine may hang in its own shutdown, leave descendants behind when
 * its leader exits, or start one that detaches into a session of its own. None
 * of that may outlive the Run, because the Runner starts the Thread's next
 * execution only once this proves the previous one gone. A Runner that died
 * leaves its executions running; the next boot of the same installation reaps
 * them before it accepts work. One Runner holds an installation's data
 * directory at a time, so a scope from another boot of it is always a dead one.
 *
 * An execution's processes are those that carry its marker and everything
 * below them. They are noted before the engine is told to stop, and a process
 * found once is followed by its pid and start time until it is gone, though
 * its parent dies and it is handed to init. What escapes both — a process
 * that drops the marker and leaves the tree between two looks — is beyond any
 * user-level inventory; only a sandbox with a pid namespace of its own ends
 * it with its engine.
 *
 * macOS and Linux expose a same-user process's start environment. Windows
 * does not, but there every launch runs under the process supervisor, whose
 * Job holds all it starts: each running supervisor stands for its whole tree.
 */
export class ExecutionContainment {
  readonly #bootId: string;
  readonly #installation: string;
  readonly #list: ProcessLister | undefined;
  readonly #probeAlive: ProcessProbe | undefined;
  readonly #terminationGraceMs: number;
  /** The processes noted for each execution before its engine was told to stop. */
  readonly #noted = new Map<string, Set<string>>();

  constructor(options: {
    readonly bootId: string;
    /** The Runner's data directory, which one Runner process holds at a time. */
    readonly dataDirectory: string;
    readonly listProcesses?: ProcessLister;
    readonly probeAlive?: ProcessProbe;
    readonly platform?: NodeJS.Platform;
    readonly terminationGraceMs?: number;
  }) {
    this.#bootId = options.bootId;
    this.#installation = createHash("sha256")
      .update(options.dataDirectory)
      .digest("base64url")
      .slice(0, 16);
    const platform = options.platform ?? process.platform;
    this.#list = options.listProcesses ?? processListerFor(platform);
    this.#probeAlive =
      options.probeAlive ??
      (options.listProcesses === undefined && (platform === "linux" || platform === "darwin")
        ? defaultProbeAlive
        : undefined);
    this.#terminationGraceMs = options.terminationGraceMs ?? terminationGraceMs;
  }

  scope(executionId: string): string {
    return `${this.#installation}.${this.#bootId}.${executionId}`;
  }

  /** Marks every process a launch starts as belonging to `executionId`. */
  wrap(executionId: string, inner: HarnessProcessLaunchWrapper): HarnessProcessLaunchWrapper {
    const scope = this.scope(executionId);
    return (launch) =>
      inner({ ...launch, environment: { ...launch.environment, [executionScopeVariable]: scope } });
  }

  /** Stops whatever of `executionId` is still running and says whether all of it is gone. */
  /**
   * Notes every process of `executionId` now, before its engine is told to
   * stop: what the engine orphans as it exits is then still known to
   * `terminate`.
   */
  async note(
    executionId: string,
    processGroups: readonly number[] = [],
  ): Promise<readonly string[]> {
    const list = this.#list;
    if (!list) return [];
    const scope = this.scope(executionId);
    const noted = this.#noted.get(scope) ?? new Set<string>();
    const { processes } = normalizeInventory(await list(executionScopeVariable));
    const groups = new Set(processGroups);
    for (const process of processes)
      if (process.processGroupId !== undefined && groups.has(process.processGroupId))
        noted.add(process.identity);
    for (const { identity } of membersOf(processes, (candidate) => candidate === scope, noted))
      noted.add(identity);
    this.#noted.set(scope, noted);
    return [...noted];
  }

  /**
   * Stops whatever of `executionId` is still running and says whether all of
   * it is gone. With `stopEngine`, every process is noted first and the
   * engine then stops itself.
   */
  async terminate(
    executionId: string,
    stopEngine?: () => Promise<unknown>,
  ): Promise<TerminationProof> {
    const scope = this.scope(executionId);
    const proof = await this.#terminate(
      (candidate) => candidate === scope,
      stopEngine,
      this.#noted.get(scope),
    );
    if (proof === "proven") this.#noted.delete(scope);
    return proof;
  }

  /**
   * How many process trees `executionId` runs: its processes whose parent is
   * outside it. One is exactly what the Runner launched, so nothing it started
   * lives on detached; none is an execution whose engine is shared and that
   * left nothing behind. A warm engine is kept for the next Run only on this
   * proof.
   */
  async liveRoots(executionId: string): Promise<number | "unverifiable"> {
    const list = this.#list;
    if (!list) return "unverifiable";
    const scope = this.scope(executionId);
    const matches = (candidate: string) => candidate === scope;
    const scan = normalizeInventory(await list(executionScopeVariable));
    if (scan.incomplete) return "unverifiable";
    const members = membersOf(scan.processes, matches, new Set());
    const roots = ownRootPids();
    if (
      hasRelevantUnreadable(scan.processes, members, matches, new Set(), roots) ||
      hasVanishedMemberCandidate(scan.vanishedPids, members, new Set(), roots)
    ) {
      return "unverifiable";
    }
    const pids = new Set(members.map(({ pid }) => pid));
    return members.filter(({ ppid }) => !pids.has(ppid)).length;
  }

  /** Reaps a stopped owner's boot without touching a replacement already running. */
  async reapBoot(processIdentities: readonly string[] = []): Promise<TerminationProof> {
    const prefix = `${this.#installation}.${this.#bootId}.`;
    return this.#terminate(
      (scope) => scope.startsWith(prefix),
      undefined,
      new Set([...processIdentities, ...[...this.#noted.values()].flatMap((notes) => [...notes])]),
    );
  }

  async shutdownProof(): Promise<RunnerShutdownProof> {
    const prefix = `${this.#installation}.${this.#bootId}.`;
    const observed = new Set([...this.#noted.values()].flatMap((notes) => [...notes]));
    let remaining: readonly ListedProcess[] = [];
    const termination = await this.#terminate(
      (scope) => scope.startsWith(prefix),
      undefined,
      observed,
      (processes) => {
        remaining = processes;
        for (const process of processes) observed.add(process.identity);
      },
    ).catch(() => "unknown" as const);
    return {
      bootId: this.#bootId,
      processIdentities: [...observed],
      termination,
      unconfirmedScopes:
        termination === "proven"
          ? []
          : [...new Set(remaining.map((process) => process.scope ?? process.identity))],
    };
  }

  /** Stops what an earlier boot of this installation left running. */
  async reapEarlierBoots(): Promise<TerminationProof> {
    const prefix = `${this.#installation}.`;
    const current = `${prefix}${this.#bootId}.`;
    return this.#terminate((scope) => scope.startsWith(prefix) && !scope.startsWith(current));
  }

  async #terminate(
    matches: (scope: string) => boolean,
    stopEngine?: () => Promise<unknown>,
    noted?: ReadonlySet<string>,
    observe?: (members: readonly ListedProcess[]) => void,
  ): Promise<TerminationProof> {
    const list = this.#list;
    if (!list) {
      await stopEngine?.();
      return "unverifiable";
    }
    // Followed until gone: a member whose parent dies is handed to init and
    // is no longer below anything that carries the marker. Any previously seen
    // member whose fate cannot be observed (incomplete scan or PID still alive
    // outside the user listing) keeps termination unverifiable rather than proven.
    const found = new Set<string>(noted);
    const foundPids = new Map<string, number>();
    for (const identity of found) {
      const pid = pidFromIdentity(identity);
      if (pid > 0) foundPids.set(identity, pid);
    }
    let lastScanUnverifiable = false;
    const remaining = async (): Promise<readonly ListedProcess[]> => {
      const scan = normalizeInventory(await list(executionScopeVariable));
      const members = membersOf(scan.processes, matches, found);
      observe?.(members);
      const presentIdentities = new Set(members.map(({ identity }) => identity));
      const listedByPid = new Map(scan.processes.map((process) => [process.pid, process]));
      let unobservedFate = false;
      const nextFound = new Set<string>();
      for (const member of members) {
        nextFound.add(member.identity);
        foundPids.set(member.identity, member.pid);
      }
      for (const previous of found) {
        if (presentIdentities.has(previous)) continue;
        if (scan.incomplete) {
          nextFound.add(previous);
          unobservedFate = true;
          continue;
        }
        const pid = foundPids.get(previous) ?? pidFromIdentity(previous);
        if (pid > 0) {
          const currentAtPid = listedByPid.get(pid);
          // A different readable start identity at the same PID proves PID reuse after exit.
          if (currentAtPid && !currentAtPid.unreadable && currentAtPid.identity !== previous)
            continue;
          if (this.#probeAlive && this.#probeAlive(pid) !== "gone") {
            nextFound.add(previous);
            unobservedFate = true;
          }
        }
      }
      const roots = ownRootPids();
      const unreadableRelevant = hasRelevantUnreadable(
        scan.processes,
        members,
        matches,
        found,
        roots,
      );
      const vanishedRelevant = hasVanishedMemberCandidate(scan.vanishedPids, members, found, roots);
      found.clear();
      for (const identity of nextFound) found.add(identity);
      lastScanUnverifiable =
        scan.incomplete || unobservedFate || unreadableRelevant || vanishedRelevant;
      return members;
    };
    let processes: readonly ListedProcess[];
    if (stopEngine) {
      // The engine is stopped whatever this first look finds or fails to.
      await remaining().catch(() => undefined);
      await stopEngine();
    }
    processes = await remaining();
    if (processes.length === 0) return lastScanUnverifiable ? "unverifiable" : "proven";
    signal(processes, "SIGTERM");
    processes = await waitUntilGone(remaining, this.#terminationGraceMs);
    if (processes.length === 0) return lastScanUnverifiable ? "unverifiable" : "proven";
    processes = await waitUntilGone(remaining, killSettleMs, "SIGKILL");
    if (processes.length > 0) return "unknown";
    return lastScanUnverifiable ? "unverifiable" : "proven";
  }
}

/**
 * Polls until nothing remains, sending `resignal` to whatever each poll finds.
 * Its timers keep the process alive: a boot that reaps an earlier one's
 * processes has nothing else holding it open yet.
 */
async function waitUntilGone(
  remaining: () => Promise<readonly ListedProcess[]>,
  withinMs: number,
  resignal?: NodeJS.Signals,
): Promise<readonly ListedProcess[]> {
  const deadline = Date.now() + withinMs;
  let processes = await remaining();
  while (processes.length > 0 && Date.now() < deadline) {
    if (resignal) signal(processes, resignal);
    await delay(pollMs);
    processes = await remaining();
  }
  return processes;
}

/**
 * The processes of the executions `matches` names: each that carries one of
 * their markers, each already `found`, and everything below them. A process
 * that carries another execution's marker is that execution's.
 */
function membersOf(
  processes: readonly ListedProcess[],
  matches: (scope: string) => boolean,
  found: ReadonlySet<string>,
): readonly ListedProcess[] {
  const children = new Map<number, ListedProcess[]>();
  const groups = new Map<number, ListedProcess[]>();
  for (const listed of processes) {
    if (listed.processGroupId !== undefined) {
      const group = groups.get(listed.processGroupId);
      if (group) group.push(listed);
      else groups.set(listed.processGroupId, [listed]);
    }
    const siblings = children.get(listed.ppid);
    if (siblings) siblings.push(listed);
    else children.set(listed.ppid, [listed]);
  }
  const members = new Map<number, ListedProcess>();
  const pending = processes.filter(({ identity, scope }) =>
    scope === null ? found.has(identity) : matches(scope),
  );
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (members.has(next.pid)) continue;
    members.set(next.pid, next);
    const ownedGroup = next.processGroupId === next.pid ? groups.get(next.pid) : undefined;
    for (const child of [...(children.get(next.pid) ?? []), ...(ownedGroup ?? [])]) {
      if (child.scope === null || matches(child.scope)) pending.push(child);
    }
  }
  return [...members.values()];
}

function signal(processes: readonly ListedProcess[], name: NodeJS.Signals): void {
  for (const { pid, signal: own } of processes) {
    try {
      if (own) own(name);
      else process.kill(pid, name);
    } catch {
      // Gone already, or never ours to signal; the next listing decides.
    }
  }
}

function processListerFor(platform: NodeJS.Platform): ProcessLister | undefined {
  if (platform === "linux") return listLinuxProcesses;
  if (platform === "darwin") return listDarwinProcesses;
  if (platform === "win32") return listSupervisedProcesses;
  return undefined;
}

/**
 * The supervisors this Runner started whose trees are not proven gone. A Job
 * lets nothing out, and its supervisor exits only once it has waited out every
 * other member, so a tree is gone exactly when its supervisor is; one that
 * exits without that proof stays listed, and its execution stays unknown. One
 * a dead Runner started ends with the Runner, because its control pipe closes.
 */
async function listSupervisedProcesses(variable: string): Promise<readonly ListedProcess[]> {
  return runningSupervisedProcesses().map((running) => ({
    identity: running.identity,
    pid: running.pid,
    ppid: process.pid,
    scope: running.environment[variable] ?? null,
    signal: (name) => running.control(name === "SIGKILL" ? "force" : "graceful"),
  }));
}

const linuxProcSliceBudgetMs = 15;

/** A process's start identity remains readable after it loses its start environment. */
export async function listLinuxProcesses(
  variable: string,
  procRoot = "/proc",
): Promise<ProcessInventory> {
  const maxAttempts = 3;
  let previousVanished: ReadonlySet<number> | undefined;
  let last: ProcessInventory = {
    processes: [],
    incomplete: true,
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const scan = await scanLinuxProcOnce(variable, procRoot);
    if (scan.incomplete) {
      return { processes: scan.processes, incomplete: true, vanishedPids: scan.vanishedPids };
    }
    if (previousVanished) {
      // A PID that stays listed and keeps failing with ENOENT/ESRCH across
      // passes indicates an unstable or broken /proc listing, not a normal exit.
      for (const pid of scan.vanishedPids) {
        if (previousVanished.has(pid)) {
          return { processes: scan.processes, incomplete: true, vanishedPids: scan.vanishedPids };
        }
      }
    }
    if (scan.vanishedPids.size === 0) {
      return { processes: scan.processes, incomplete: false };
    }
    previousVanished = scan.vanishedPids;
    // After retrying so any child forked before prior vanished PIDs exited is
    // captured in a fresh readdirSync, strictly disjoint exits on a busy host
    // do not poison containment unless a PID keeps vanishing or a member vanished.
    last = { processes: scan.processes, incomplete: false, vanishedPids: scan.vanishedPids };
  }
  return last;
}

async function scanLinuxProcOnce(
  variable: string,
  procRoot: string,
): Promise<{
  readonly processes: readonly ListedProcess[];
  readonly incomplete: boolean;
  readonly vanishedPids: ReadonlySet<number>;
}> {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return {
      processes: [],
      incomplete: true,
      vanishedPids: new Set(),
    };
  }
  const prefix = `${variable}=`;
  const found: ListedProcess[] = [];
  const vanishedPids = new Set<number>();
  let incomplete = false;
  let sliceStart = performance.now();
  // /proc entries are kernel-backed memory; yielding only when a slice reaches
  // its wall-clock budget keeps normal scans fast and atomic while bounding
  // event-loop stalls on large or heavily loaded hosts.
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    if (performance.now() - sliceStart >= linuxProcSliceBudgetMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${entry}/stat`, "latin1");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ESRCH") {
        vanishedPids.add(pid);
      } else if (code === "EACCES" || code === "EPERM") {
        // Under hidepid, other users' /proc/<pid>/stat returns EACCES/EPERM.
        // Mark the entry unreadable so only a previously noted or related PID
        // affects containment instead of poisoning every Stop on the machine.
        found.push({
          identity: `${pid}@unreadable`,
          pid,
          ppid: 0,
          scope: null,
          unreadable: true,
        });
      } else {
        incomplete = true;
      }
      continue;
    }
    // The command name is parenthesized and may hold anything; after its
    // closing parenthesis the state is field 0, parent pid field 1, pgid field 2,
    // and start time in clock ticks since boot field 19.
    const close = stat.lastIndexOf(")");
    if (close < 0) {
      incomplete = true;
      continue;
    }
    const fields = stat.slice(close + 2).split(" ");
    const state = fields[0];
    const ppid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (
      !state ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(processGroupId) ||
      !startTime ||
      !/^[0-9]+$/u.test(startTime)
    ) {
      incomplete = true;
      continue;
    }
    // Linux kernel threads (kthreadd and its children) never belong to a user
    // execution and never expose a readable /proc/<pid>/environ.
    if (pid === 2 || ppid === 2) continue;
    let environ = "";
    try {
      environ = readFileSync(`${procRoot}/${entry}/environ`, "latin1");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        code === "ESRCH" ||
        ((state === "Z" || state === "X") &&
          (code === "ENOENT" || code === "EACCES" || code === "EPERM"))
      ) {
        // Linux clears a dying/zombie process's mm_struct before its parent reaps
        // it, so /proc/<pid>/environ returns ESRCH or EACCES even for a direct child
        // while its stat still shows Z/X. Keep its start identity listed so containment
        // still tracks already-seen PIDs until reaped without falsely failing the scan.
        found.push({
          identity: `${pid}@${startTime}`,
          pid,
          ppid,
          processGroupId,
          scope: null,
        });
        continue;
      }
      if (code === "ENOENT") {
        vanishedPids.add(pid);
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        // Record the entry unreadable with its parent and process group so
        // membership and ancestry decide whether it can belong to this scope.
        found.push({
          identity: `${pid}@${startTime}`,
          pid,
          ppid,
          processGroupId,
          scope: null,
          unreadable: true,
        });
        continue;
      }
      incomplete = true;
      continue;
    }
    const scope = environ.split("\0").find((value) => value.startsWith(prefix));
    found.push({
      identity: `${pid}@${startTime}`,
      pid,
      ppid,
      processGroupId,
      scope: scope ? scope.slice(prefix.length) : null,
    });
  }
  return { processes: found, incomplete, vanishedPids };
}

/**
 * `ps -E` prints a same-user process's start environment after its arguments.
 * A scope holds no whitespace, so the first one after the variable's name ends
 * it.
 */
async function listDarwinProcesses(variable: string): Promise<ProcessInventory> {
  const uid = process.getuid?.();
  if (uid === undefined) return { processes: [], incomplete: true };
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(
      "/bin/ps",
      ["-E", "-ww", "-U", String(uid), "-o", "pid=,ppid=,pgid=,lstart=,command="],
      { maxBuffer: 64 * 1_024 * 1_024 },
    ));
  } catch {
    return { processes: [], incomplete: true };
  }
  let incomplete = stderr.trim().length > 0;
  const marker = ` ${variable}=`;
  const found: ListedProcess[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    // `lstart` is always five words: weekday, month, day, time and year.
    const words = line.trimStart().split(/\s+/u, 9);
    if (words.length < 8) {
      incomplete = true;
      continue;
    }
    const [pid, ppid, processGroupId] = words.slice(0, 3).map(Number);
    const lstart = words.slice(3, 8);
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(processGroupId) ||
      !/^\d{2}:\d{2}:\d{2}$/u.test(lstart[3] ?? "") ||
      !/^\d{4}$/u.test(lstart[4] ?? "")
    ) {
      incomplete = true;
      continue;
    }
    if (pid === process.pid) continue;
    const at = line.indexOf(marker);
    const scope = at < 0 ? null : line.slice(at + marker.length).split(/\s/u, 1)[0] || null;
    found.push({
      identity: `${pid}@${lstart.join(" ")}`,
      pid: pid!,
      ppid: ppid!,
      processGroupId: processGroupId!,
      scope,
    });
  }
  return { processes: found, ...(incomplete ? { incomplete: true } : {}) };
}

let cachedMachineBootId: string | null | undefined;

/**
 * Reads a stable identifier for the current OS boot (changes on machine reboot).
 * Returns `undefined` when the platform cannot supply one so unknown stays unknown.
 */
export function readMachineBootId(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === process.platform && cachedMachineBootId !== undefined) {
    return cachedMachineBootId ?? undefined;
  }
  let resolved: string | undefined;
  try {
    if (platform === "linux") {
      const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (value) resolved = `linux:${value}`;
    } else if (platform === "darwin") {
      const output = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(output);
      if (match) resolved = `darwin:${match[1]}.${match[2]}`;
    }
  } catch {
    resolved = undefined;
  }
  if (platform === process.platform) cachedMachineBootId = resolved ?? null;
  return resolved;
}
