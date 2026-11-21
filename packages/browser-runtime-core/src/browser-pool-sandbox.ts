/**
 * Chromium's sandbox as the running browser has it (pool-runtime-in-guest.md, decision 8): for
 * each renderer of the Chromium this runtime launched, its seccomp mode, its no_new_privs bit and
 * whether it is in a pid namespace of its own, read from /proc.
 *
 * Round D, D4: this is evidence, never a gate. Everything it reads is inside the guest, and a
 * compromised guest can make it say anything (a process can rewrite its own command line, a
 * decoy can install an allow-all filter). Nothing may decide on it. It reads only the
 * runtime's own process tree (the browser it launched and that browser's children), and a
 * process that exits or is replaced while it is read is left out, never paired with stale
 * values.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserRendererSandbox {
  readonly pid: number;
  /** Chromium's own process type (`--type=`), such as renderer, zygote or gpu-process. */
  readonly type: string;
  /** 2 is a seccomp-bpf filter. */
  readonly seccomp: number | null;
  readonly noNewPrivs: boolean | null;
  /** Its pid in each namespace from the root down; two or more is a namespace of its own. */
  readonly nspid: readonly number[];
}

export interface BrowserSandboxReport {
  /** The renderers, and every other Chromium child process (`others`). */
  readonly renderers: readonly BrowserRendererSandbox[];
  readonly others: readonly BrowserRendererSandbox[];
  /** Every renderer has a seccomp filter, no_new_privs and its own pid namespace. */
  readonly sandboxed: boolean;
}

/** The parent and start time from /proc/<pid>/stat (fields 4 and 22). */
async function statOf(
  procRoot: string,
  pid: string,
): Promise<{ readonly ppid: number; readonly start: string } | undefined> {
  const text = await readFile(join(procRoot, pid, "stat"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), start: fields[19] ?? "" };
}

export async function readBrowserSandbox(
  procRoot = "/proc",
  rootPid: number = process.pid,
): Promise<BrowserSandboxReport> {
  const entries = (await readdir(procRoot)).filter((entry) => /^\d+$/u.test(entry));
  const parents = new Map<string, number>();
  for (const entry of entries) {
    const stat = await statOf(procRoot, entry);
    if (stat) parents.set(entry, stat.ppid);
  }
  // The runtime's own descendants: the Chromium it launched, and that browser's children.
  const descendants = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parents)
      if (!descendants.has(pid) && (ppid === rootPid || descendants.has(String(ppid)))) {
        descendants.add(pid);
        grew = true;
      }
  }
  const renderers: BrowserRendererSandbox[] = [];
  const others: BrowserRendererSandbox[] = [];
  for (const pid of [...descendants].sort((a, b) => Number(a) - Number(b))) {
    const before = await statOf(procRoot, pid);
    const cmdline = await readFile(join(procRoot, pid, "cmdline"), "utf8").catch(() => undefined);
    const status = await readFile(join(procRoot, pid, "status"), "utf8").catch(() => undefined);
    const after = await statOf(procRoot, pid);
    // Gone or replaced while it was read: left out.
    if (!before || !after || before.start !== after.start || !cmdline || !status) continue;
    // Chromium rewrites its process title, so its arguments may be one space-separated string.
    const type = cmdline
      .split(/[\0 ]/u)
      .find((argument) => argument.startsWith("--type="))
      ?.slice("--type=".length);
    if (!type) continue;
    const field = (name: string) =>
      status
        .split("\n")
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const seccomp = field("Seccomp");
    const noNewPrivs = field("NoNewPrivs");
    (type === "renderer" ? renderers : others).push({
      pid: Number(pid),
      type,
      seccomp: seccomp === undefined ? null : Number(seccomp),
      noNewPrivs: noNewPrivs === undefined ? null : noNewPrivs === "1",
      nspid: (field("NSpid") ?? "").split(/\s+/u).filter(Boolean).map(Number),
    });
  }
  return {
    renderers,
    others,
    sandboxed:
      renderers.length > 0 &&
      renderers.every(
        (renderer) =>
          renderer.seccomp === 2 && renderer.noNewPrivs === true && renderer.nspid.length >= 2,
      ),
  };
}
