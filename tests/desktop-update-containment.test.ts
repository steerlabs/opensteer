import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
vi.mock("node:child_process", () => ({ spawnSync: () => ({ status: 1, stdout: "" }) }));
import { containGuest } from "../scripts/public-download/containment.js";

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
  const calls: string[] = [];
  const run = (exe: string, args: string[]) => {
    const cmd = [exe, ...args].join(" ");
    calls.push(cmd);
    if (exe === "scutil") return { code: 0, output: "" };
    if (exe === "curl") {
      if (denyControl) deny++;
      return { code: 1, output: "blocked" };
    }
    if (args.includes("-e")) enabled = true;
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
