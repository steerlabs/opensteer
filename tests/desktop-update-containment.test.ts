import { test, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (file: import("node:fs").PathLike) =>
      file === "/Volumes/My Shared Files/inputs" || fs.existsSync(file),
  };
});
const watchdogs = vi.hoisted(() => [] as unknown[][]);
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 1, stdout: "" }),
  spawn: (...args: unknown[]) => {
    watchdogs.push(args);
    return { pid: 4242, once: () => undefined, unref: () => undefined };
  },
}));
import { containGuest, pfWatchdog } from "../scripts/public-download/containment.js";

test("containment requires an observed deny and restores PF even if final rule verification fails", () => {
  const out = mkdtempSync(path.join(tmpdir(), "opensteer-pf-proof-"));
  vi.stubEnv("SSH_CONNECTION", "192.168.64.1 50000 192.168.64.2 22");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    vi.stubEnv(key, "");
  let enabled = false,
    deny = 0,
    changed = false,
    denyControl = true;
  const calls: string[] = [],
    armedWhenEnabled: number[] = [];
  // This run's ancestry: node, its shell, then the SSH session serving the control connection.
  const parents: Record<string, string> = {
    [process.pid]: "200 node",
    200: "300 /bin/zsh",
    300: "1 /usr/libexec/sshd-session",
  };
  const run = (exe: string, args: string[]) => {
    const cmd = [exe, ...args].join(" ");
    calls.push(cmd);
    if (exe === "ps") return { code: 0, output: `  ${parents[args.at(-1)!]}\n` };
    if (exe === "scutil") return { code: 0, output: "" };
    if (exe === "curl") {
      if (denyControl) deny++;
      return { code: 1, output: "blocked" };
    }
    if (args.includes("-e")) {
      armedWhenEnabled.push(watchdogs.length);
      enabled = true;
    }
    if (args.includes("-d")) enabled = false;
    if (args.includes("info"))
      return { code: 0, output: `Status: ${enabled ? "Enabled" : "Disabled"}` };
    if (args.includes("-sr"))
      return {
        code: 0,
        output: changed ? "pass all" : 'block drop log all label "opensteer-egress-deny"',
      };
    if (args.includes("labels"))
      return { code: 0, output: `opensteer-egress-deny 10 ${deny} 0 0 0 0 0` };
    return { code: 0, output: "" };
  };
  try {
    const stop = containGuest(out, run);
    expect(enabled).toBe(true);
    // The watchdog is armed for the control session before PF can block anything.
    expect(watchdogs).toEqual([
      [
        "sudo",
        [
          "-n",
          "/bin/sh",
          "-c",
          pfWatchdog,
          "opensteer-pf-watchdog",
          "300",
          String(process.pid),
          "/sbin/pfctl",
        ],
        { detached: true, stdio: "ignore" },
      ],
    ]);
    expect(armedWhenEnabled).toEqual([1]);
    changed = true;
    expect(() => stop()).toThrow(/rules changed/u);
    expect(enabled).toBe(false);
    expect(calls).toContain("sudo -n pfctl -f /etc/pf.conf");
    changed = false;
    denyControl = false;
    expect(() => containGuest(out, run)).toThrow(/deny counter/u);
    expect(enabled).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    rmSync(out, { recursive: true, force: true });
  }
});

test("the PF watchdog restores PF once the control session ends", async () => {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "opensteer-pf-watchdog-"));
  const log = path.join(dir, "pfctl.log"),
    pfctl = path.join(dir, "pfctl");
  writeFileSync(pfctl, `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  const session = spawn("sleep", ["60"], { stdio: "ignore" });
  const watchdog = spawn(
    "/bin/sh",
    ["-c", pfWatchdog, "watchdog", String(session.pid), String(process.pid), pfctl],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => watchdog.once("close", resolve));
  let deadline: NodeJS.Timeout | undefined;
  try {
    expect(existsSync(log)).toBe(false);
    session.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("watchdog never restored PF after the session ended")),
          10_000,
        );
      }),
    ]);
    expect(readFileSync(log, "utf8")).toBe("-d\n-F all\n-f /etc/pf.conf\n");
  } finally {
    clearTimeout(deadline);
    session.kill();
    watchdog.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guest checks under containment never need Apple's network", () => {
  // stapler validate queries CloudKit; under PF it timed out and failed every case.
  for (const file of ["eu-guest.ts", "eu-journey.ts"])
    expect(
      readFileSync(path.join(import.meta.dirname, "../scripts/public-download", file), "utf8"),
    ).not.toMatch(/"stapler"/u);
});
