/**
 * Chromium's sandbox as the running browser has it (pool-runtime-in-guest.md, decision 8): for
 * each renderer process, its seccomp mode, its no_new_privs bit and whether it is in a pid
 * namespace of its own, read from /proc. Read, not inferred from how the browser was started.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserRendererSandbox {
  readonly pid: number;
  /** 2 is a seccomp-bpf filter. */
  readonly seccomp: number | null;
  readonly noNewPrivs: boolean | null;
  /** Its pid in each namespace from the root down; two or more is a namespace of its own. */
  readonly nspid: readonly number[];
}

export interface BrowserSandboxReport {
  readonly renderers: readonly BrowserRendererSandbox[];
  /** Every renderer has a seccomp filter, no_new_privs and its own pid namespace. */
  readonly sandboxed: boolean;
}

export async function readBrowserSandbox(procRoot = "/proc"): Promise<BrowserSandboxReport> {
  const renderers: BrowserRendererSandbox[] = [];
  for (const entry of await readdir(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const cmdline = await readFile(join(procRoot, entry, "cmdline"), "utf8").catch(() => "");
    if (!cmdline.split("\0").includes("--type=renderer")) continue;
    const status = await readFile(join(procRoot, entry, "status"), "utf8").catch(() => "");
    const field = (name: string) =>
      status
        .split("\n")
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const seccomp = field("Seccomp");
    const noNewPrivs = field("NoNewPrivs");
    renderers.push({
      pid: Number(entry),
      seccomp: seccomp === undefined ? null : Number(seccomp),
      noNewPrivs: noNewPrivs === undefined ? null : noNewPrivs === "1",
      nspid: (field("NSpid") ?? "").split(/\s+/u).filter(Boolean).map(Number),
    });
  }
  return {
    renderers,
    sandboxed:
      renderers.length > 0 &&
      renderers.every(
        (renderer) =>
          renderer.seccomp === 2 && renderer.noNewPrivs === true && renderer.nspid.length >= 2,
      ),
  };
}
