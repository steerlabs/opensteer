import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MachineStatusSchema } from "../packages/protocol/src/problems.js";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Runs deploy/home/machine-status.sh with Docker stood in for, as the maintenance timer would. */
function run(script: string) {
  const home = mkdtempSync(join(tmpdir(), "machine-status-"));
  directories.push(home);
  const out = join(home, "handed-to-host.json");
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
source deploy/home/machine-status.sh
home_dir=$HOME_DIR
compose() {
  if [[ $1 == ps ]]; then
    printf '%s\\n' '{"Service":"host","State":"running","Health":"healthy"}' \\
      '{"Service":"runner","State":"running","Health":"unhealthy"}' \\
      '{"Service":"my-laptop-name","State":"running","Health":"healthy"}' \\
      '{"Service":"postgres","State":"exited","Health":""}'
  elif [[ $1 == exec ]]; then
    cat > "$OUT"; echo exec >> "$HOME_DIR/exec-calls"
  fi
}
${script}`,
    ],
    { cwd: root, env: { ...process.env, HOME_DIR: home, OUT: out } },
  );
  return { home, out };
}

describe("the machine status a Linux Home's maintenance hands its Host", () => {
  it("holds only fixed values the Host accepts: no service names, error text or versions it does not know", () => {
    const { out } = run(`record_backup_result failed "restic: dial tcp /Users/alex/.secret"
record_update_result rolled-back 1.3.9 "1.4.0 /etc/opensteer-home"
publish_machine_status`);
    const status = MachineStatusSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(status).toEqual({
      services: { host: "healthy", runner: "unhealthy", postgres: "stopped" },
      lastBackup: { result: "failed", failure: "snapshot-failed", at: expect.any(String) },
      lastUpdate: { result: "rolled-back", fromVersion: "1.3.9", at: expect.any(String) },
    });
    expect(readFileSync(out, "utf8")).not.toMatch(/Users|etc|laptop|restic/u);
  });

  it("hands it over again only when it changed", () => {
    const { home } = run(`publish_machine_status
publish_machine_status
record_backup_result ok
publish_machine_status`);
    expect(readFileSync(join(home, "exec-calls"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(join(home, "last-backup.json"))).toBe(true);
  });
});
