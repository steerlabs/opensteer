import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Reject growth, deletion, renames and invalid metrics; the explicit label
// permits reviewed changes but cannot make malformed accounting valid.
it("enforces each metric against main and honors only the explicit waiver", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-context-gate-"));
  try {
    const baseline = join(directory, "main.json");
    const current = join(directory, "current.json");
    writeFileSync(baseline, JSON.stringify({ a: 10, b: 20 }));
    const run = (value: unknown, allow: string) => {
      writeFileSync(current, JSON.stringify(value));
      return spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../scripts/check-agent-context-budget.mjs"),
          baseline,
          current,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, ALLOW_INCREASE: allow },
        },
      );
    };
    expect(run({ a: 10, b: 19 }, "false").status).toBe(0);
    for (const value of [
      { a: 11, b: 20 },
      { a: 10 },
      { a: 10, renamed: 20 },
      { a: 10, b: 20, c: 1 },
    ]) {
      expect(run(value, "false").status).toBe(1);
      expect(run(value, "true").status).toBe(0);
    }
    expect(run({ a: "10", b: 20 }, "true").status).toBe(1);
    expect(run({ a: -1, b: 20 }, "true").status).toBe(1);
    expect(run({ a: 11, b: 20 }, "false").stdout).toContain("a: 10 -> 11");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
