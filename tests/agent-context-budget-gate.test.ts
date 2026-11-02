import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Reports growth, savings, removals and new metrics without failing; only
// malformed accounting fails, because the report would be meaningless.
it("reports each metric change against main and never blocks on growth", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-context-gate-"));
  try {
    const baseline = join(directory, "main.json");
    const current = join(directory, "current.json");
    writeFileSync(baseline, JSON.stringify({ a: 10, b: 20 }));
    const run = (value: unknown) => {
      writeFileSync(current, JSON.stringify(value));
      const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
      return spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../scripts/check-agent-context-budget.mjs"),
          baseline,
          current,
        ],
        { encoding: "utf8", env },
      );
    };
    expect(run({ a: 10, b: 20 }).stdout).toContain("unchanged");
    const reported = [
      [{ a: 11, b: 20 }, "a: 10 -> 11 (+1)"],
      [{ a: 10, b: 19 }, "b: 20 -> 19 (-1)"],
      [{ a: 10 }, "b: removed or renamed (was 20)"],
      [{ a: 10, b: 20, c: 1 }, "c: new metric -> 1"],
    ] as const;
    for (const [value, line] of reported) {
      const result = run(value);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(line);
    }
    expect(run({ a: "10", b: 20 }).status).toBe(1);
    expect(run({ a: -1, b: 20 }).status).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
