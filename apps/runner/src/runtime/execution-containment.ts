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
  /** How to signal it when that is not `process.kill`. */
  readonly signal?: (name: NodeJS.Signals) => void;
}

/** Every process of the Runner's user, with the marker each carries. */
type ProcessLister = (variable: string) => Promise<readonly ListedProcess[]>;

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
  readonly #terminationGraceMs: number;
  /** The processes noted for each execution before its engine was told to stop. */
  readonly #noted = new Map<string, Set<string>>();

  constructor(options: {
    readonly bootId: string;
    /** The Runner's data directory, which one Runner process holds at a time. */
    readonly dataDirectory: string;
    readonly listProcesses?: ProcessLister;
    readonly platform?: NodeJS.Platform;
    readonly terminationGraceMs?: number;
  }) {
    this.#bootId = options.bootId;
    this.#installation = createHash("sha256")
      .update(options.dataDirectory)
      .digest("base64url")
      .slice(0, 16);
    this.#list = options.listProcesses ?? processListerFor(options.platform ?? process.platform);
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
    const processes = await list(executionScopeVariable);
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
    const members = membersOf(
      await list(executionScopeVariable),
      (candidate) => candidate === scope,
      new Set(),
    );
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
    // is no longer below anything that carries the marker.
    const found = new Set<string>(noted);
    const remaining = async (): Promise<readonly ListedProcess[]> => {
      const members = membersOf(await list(executionScopeVariable), matches, found);
      observe?.(members);
      found.clear();
      for (const { identity } of members) found.add(identity);
      return members;
    };
    let processes: readonly ListedProcess[];
    if (stopEngine) {
      // The engine is stopped whatever this first look finds or fails to.
      await remaining().catch(() => undefined);
      await stopEngine();
    }
    processes = await remaining();
    if (processes.length === 0) return "proven";
    signal(processes, "SIGTERM");
    processes = await waitUntilGone(remaining, this.#terminationGraceMs);
    if (processes.length === 0) return "proven";
    processes = await waitUntilGone(remaining, killSettleMs, "SIGKILL");
    return processes.length === 0 ? "proven" : "unknown";
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

/** A process's start identity remains readable after it loses its start environment. */
async function listLinuxProcesses(variable: string): Promise<readonly ListedProcess[]> {
  const prefix = `${variable}=`;
  const found: ListedProcess[] = [];
  // /proc entries are kernel-backed memory; reading them synchronously avoids thousands of
  // sequential libuv threadpool round-trips per scan under CPU load.
  for (const entry of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ = "";
    try {
      environ = readFileSync(`/proc/${entry}/environ`, "latin1");
    } catch {
      // Linux removes a zombie's address space before its PID is reaped.
      // Its start identity must remain listed even when environ returns ESRCH.
    }
    const scope = environ.split("\0").find((value) => value.startsWith(prefix));
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue;
    }
    // The command name is parenthesized and may hold anything; after its
    // closing parenthesis the parent pid is the second field and the start
    // time, in clock ticks since boot, the twentieth.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    found.push({
      identity: `${pid}@${fields[19] ?? ""}`,
      pid,
      ppid,
      processGroupId: Number(fields[2]),
      scope: scope ? scope.slice(prefix.length) : null,
    });
  }
  return found;
}

/**
 * `ps -E` prints a same-user process's start environment after its arguments.
 * A scope holds no whitespace, so the first one after the variable's name ends
 * it.
 */
async function listDarwinProcesses(variable: string): Promise<readonly ListedProcess[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-E", "-ww", "-U", String(uid), "-o", "pid=,ppid=,pgid=,lstart=,command="],
    { maxBuffer: 64 * 1_024 * 1_024 },
  );
  const marker = ` ${variable}=`;
  const found: ListedProcess[] = [];
  for (const line of stdout.split("\n")) {
    // `lstart` is always five words: weekday, month, day, time and year.
    const words = line.trimStart().split(/\s+/u, 8);
    const [pid, ppid, processGroupId] = words.slice(0, 3).map(Number);
    if (!Number.isSafeInteger(pid) || pid === process.pid || !Number.isSafeInteger(ppid)) continue;
    const at = line.indexOf(marker);
    const scope = at < 0 ? null : line.slice(at + marker.length).split(/\s/u, 1)[0] || null;
    found.push({
      identity: `${pid}@${words.slice(3, 8).join(" ")}`,
      pid: pid!,
      ppid: ppid!,
      ...(processGroupId === undefined ? {} : { processGroupId }),
      scope,
    });
  }
  return found;
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
