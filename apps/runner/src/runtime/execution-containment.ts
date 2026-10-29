import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { HarnessProcessLaunchWrapper } from "@opensteer/harness";

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

/** One of the Runner user's processes, and the execution its environment names, if any. */
interface ListedProcess {
  /** The pid and when the process started: a pid the system gave out again is another process. */
  readonly identity: string;
  readonly pid: number;
  readonly ppid: number;
  readonly scope: string | null;
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
 * macOS and Linux expose a same-user process's start environment; Windows does
 * not, so there an execution ends with its engine's own process-tree stop.
 */
export class ExecutionContainment {
  readonly #bootId: string;
  readonly #installation: string;
  readonly #list: ProcessLister | undefined;
  /** The processes noted for each execution before its engine was told to stop. */
  readonly #noted = new Map<string, Set<string>>();

  constructor(options: {
    readonly bootId: string;
    /** The Runner's data directory, which one Runner process holds at a time. */
    readonly dataDirectory: string;
    readonly listProcesses?: ProcessLister;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#bootId = options.bootId;
    this.#installation = createHash("sha256")
      .update(options.dataDirectory)
      .digest("base64url")
      .slice(0, 16);
    this.#list = options.listProcesses ?? processListerFor(options.platform ?? process.platform);
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
  async note(executionId: string): Promise<void> {
    const list = this.#list;
    if (!list) return;
    const scope = this.scope(executionId);
    const noted = this.#noted.get(scope) ?? new Set<string>();
    for (const { identity } of membersOf(
      await list(executionScopeVariable),
      (candidate) => candidate === scope,
      noted,
    )) {
      noted.add(identity);
    }
    this.#noted.set(scope, noted);
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
   * Whether everything `executionId` runs is one process tree: exactly one of
   * its processes has a parent outside it — what the Runner launched — so
   * nothing it started lives on detached. A warm engine is kept for the next
   * Run only on this proof.
   */
  async isSingleTree(executionId: string): Promise<boolean | "unverifiable"> {
    const list = this.#list;
    if (!list) return "unverifiable";
    const scope = this.scope(executionId);
    const members = membersOf(
      await list(executionScopeVariable),
      (candidate) => candidate === scope,
      new Set(),
    );
    const pids = new Set(members.map(({ pid }) => pid));
    return members.filter(({ ppid }) => !pids.has(ppid)).length === 1;
  }

  /** Reaps a stopped owner's boot without touching a replacement already running. */
  async reapBoot(): Promise<TerminationProof> {
    const prefix = `${this.#installation}.${this.#bootId}.`;
    return this.#terminate((scope) => scope.startsWith(prefix));
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
    processes = await waitUntilGone(remaining, terminationGraceMs);
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
  for (const listed of processes) {
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
    for (const child of children.get(next.pid) ?? []) {
      if (child.scope === null || matches(child.scope)) pending.push(child);
    }
  }
  return [...members.values()];
}

function signal(processes: readonly ListedProcess[], name: NodeJS.Signals): void {
  for (const { pid } of processes) {
    try {
      process.kill(pid, name);
    } catch {
      // Gone already, or never ours to signal; the next listing decides.
    }
  }
}

function processListerFor(platform: NodeJS.Platform): ProcessLister | undefined {
  if (platform === "linux") return listLinuxProcesses;
  if (platform === "darwin") return listDarwinProcesses;
  return undefined;
}

/** Same-user processes' environments are readable in procfs; others' are not and are not ours. */
async function listLinuxProcesses(variable: string): Promise<readonly ListedProcess[]> {
  const prefix = `${variable}=`;
  const found: ListedProcess[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = await readFile(`/proc/${entry}/environ`, "latin1");
    } catch {
      continue;
    }
    const scope = environ.split("\0").find((value) => value.startsWith(prefix));
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry}/stat`, "latin1");
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
    ["-E", "-ww", "-U", String(uid), "-o", "pid=,ppid=,lstart=,command="],
    { maxBuffer: 64 * 1_024 * 1_024 },
  );
  const marker = ` ${variable}=`;
  const found: ListedProcess[] = [];
  for (const line of stdout.split("\n")) {
    // `lstart` is always five words: weekday, month, day, time and year.
    const words = line.trimStart().split(/\s+/u, 7);
    const [pid, ppid] = words.slice(0, 2).map(Number);
    if (!Number.isSafeInteger(pid) || pid === process.pid || !Number.isSafeInteger(ppid)) continue;
    const at = line.indexOf(marker);
    const scope = at < 0 ? null : line.slice(at + marker.length).split(/\s/u, 1)[0] || null;
    found.push({
      identity: `${pid}@${words.slice(2, 7).join(" ")}`,
      pid: pid!,
      ppid: ppid!,
      scope,
    });
  }
  return found;
}
