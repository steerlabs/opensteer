/**
 * Chromium's sandbox as the running browser has it (pool-runtime-in-guest.md, decision 8): for
 * each renderer process, its seccomp mode, its no_new_privs bit and whether it is in a pid
 * namespace of its own, read from /proc. Read, not inferred from how the browser was started.
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

export async function readBrowserSandbox(procRoot = "/proc"): Promise<BrowserSandboxReport> {
  const renderers: BrowserRendererSandbox[] = [];
  const others: BrowserRendererSandbox[] = [];
  for (const entry of await readdir(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const cmdline = await readFile(join(procRoot, entry, "cmdline"), "utf8").catch(() => "");
    // Chromium rewrites its process title, so its arguments may be one space-separated string.
    const type = cmdline
      .split(/[\0 ]/u)
      .find((argument) => argument.startsWith("--type="))
      ?.slice("--type=".length);
    if (!type) continue;
    const status = await readFile(join(procRoot, entry, "status"), "utf8").catch(() => "");
    const field = (name: string) =>
      status
        .split("\n")
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const seccomp = field("Seccomp");
    const noNewPrivs = field("NoNewPrivs");
    (type === "renderer" ? renderers : others).push({
      pid: Number(entry),
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
