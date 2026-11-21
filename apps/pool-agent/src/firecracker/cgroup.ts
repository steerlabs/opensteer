/**
 * The agent's delegated cgroup v2 subtree (systemd `Delegate=yes`): the agent's own process in
 * `agent`, every guest in `guests/<slot>/<jail>`. A slot's whole subtree is ended at once with
 * `cgroup.kill`, and the slot is empty only when `cgroup.events` says `populated 0`: that is
 * what "no other writer of this profile" is checked against.
 */
import { appendFile, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const mountPoint = "/sys/fs/cgroup";
const controllers = "+cpu +memory +pids";

export class GuestCgroups {
  /** Relative to the cgroup mount, such as `system.slice/opensteer-pool-agent.service`. */
  readonly #base: string;

  private constructor(base: string) {
    this.#base = base;
  }

  /** Moves the agent into its own leaf and enables the controllers guests are limited by. */
  static async delegate(configured?: string): Promise<GuestCgroups> {
    const base = configured ?? (await ownCgroup());
    const absolute = join(mountPoint, base);
    const leaf = join(absolute, "agent");
    await mkdir(leaf, { recursive: true });
    // A cgroup with processes cannot delegate controllers: the agent leaves its own first.
    for (const pid of (await readFile(join(absolute, "cgroup.procs"), "utf8"))
      .split("\n")
      .filter(Boolean))
      await writeFile(join(leaf, "cgroup.procs"), `${pid}\n`).catch(() => undefined);
    await writeFile(join(absolute, "cgroup.subtree_control"), controllers);
    await mkdir(join(absolute, "guests"), { recursive: true });
    await writeFile(join(absolute, "guests", "cgroup.subtree_control"), controllers);
    // Review G6(b): one limit over all guests leaves the host and the agent their room:
    // everything but max(2 GiB, 10 %) of the host's memory.
    const total = await memoryTotal();
    if (total)
      await writeFile(
        join(absolute, "guests", "memory.max"),
        String(total - Math.max(2 * 1024 ** 3, Math.floor(total / 10))),
      );
    return new GuestCgroups(base);
  }

  /** Moves one task (a VMM's kvm-pit kernel thread) into the VMM's cgroup. */
  async adopt(slotKey: string, jailId: string, task: string): Promise<void> {
    await writeFile(
      join(mountPoint, this.#base, "guests", slotKey, jailId, "cgroup.procs"),
      `${task}\n`,
    );
  }

  /** The parent the jailer creates a VMM's own cgroup in, relative to the cgroup mount. */
  async slotParent(slotKey: string): Promise<string> {
    const relative = join(this.#base, "guests", slotKey);
    const absolute = join(mountPoint, relative);
    await mkdir(absolute, { recursive: true });
    await writeFile(join(absolute, "cgroup.subtree_control"), controllers);
    return relative;
  }

  async populated(slotKey: string, jailId?: string): Promise<boolean> {
    const path = join(
      mountPoint,
      this.#base,
      "guests",
      slotKey,
      ...(jailId ? [jailId] : []),
      "cgroup.events",
    );
    const events = await readFile(path, "utf8").catch(() => "populated 0\n");
    return /^populated 1$/mu.test(events);
  }

  /** Ends every process of the slot (or of one jail) and waits until none is left. */
  /** Ends every process of the slot (or of one jail); true if there was one to end. */
  async kill(slotKey: string, signal: AbortSignal, jailId?: string): Promise<boolean> {
    const directory = join(mountPoint, this.#base, "guests", slotKey, ...(jailId ? [jailId] : []));
    if (!(await exists(directory))) return false;
    const ended = await this.populated(slotKey, jailId);
    await appendFile(join(directory, "cgroup.kill"), "1");
    while (await this.populated(slotKey, jailId)) {
      if (signal.aborted) throw new Error(`The processes of ${slotKey} did not end.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const child of await readdir(directory, { withFileTypes: true }))
      if (child.isDirectory()) await rmdir(join(directory, child.name)).catch(() => undefined);
    if (jailId) await rmdir(directory).catch(() => undefined);
    return ended;
  }

  async slotKeys(): Promise<readonly string[]> {
    const directory = join(mountPoint, this.#base, "guests");
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  async jailIds(slotKey: string): Promise<readonly string[]> {
    const directory = join(mountPoint, this.#base, "guests", slotKey);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  /** Whether `pid` lives in exactly this VMM's cgroup. */
  async owns(slotKey: string, jailId: string, pid: number): Promise<boolean> {
    const line = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
    return line.trim() === `0::/${join(this.#base, "guests", slotKey, jailId)}`;
  }
}

async function ownCgroup(): Promise<string> {
  const line = (await readFile("/proc/self/cgroup", "utf8"))
    .split("\n")
    .find((entry) => entry.startsWith("0::"));
  if (!line) throw new Error("The pool agent needs the unified cgroup v2 hierarchy.");
  const path = line
    .slice(3)
    .replace(/^\//u, "")
    .replace(/\/agent$/u, "");
  if (!path)
    throw new Error("The pool agent must run in a delegated cgroup (systemd Delegate=yes).");
  return path;
}

async function exists(path: string): Promise<boolean> {
  return readdir(path).then(
    () => true,
    () => false,
  );
}

async function memoryTotal(): Promise<number | undefined> {
  const text = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const kib = text.match(/^MemTotal:\s+([0-9]+) kB$/mu)?.[1];
  return kib ? Number(kib) * 1024 : undefined;
}
