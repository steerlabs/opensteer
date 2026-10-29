import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("requires the receipt-switch result as well as the other scheduled window cases", () => {
  const out = mkdtempSync(path.join(tmpdir(), "window-evidence-"));
  try {
    writeFileSync(path.join(out, "windows.log"), "");
    for (const name of ["current", "settle", "cancellation", "video", "receipt-switch"]) {
      const dir = path.join(out, "windows", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "result.json"), JSON.stringify({ passed: true }));
    }
    const receipt = path.join(out, "windows/receipt-switch/result.json");
    for (const [report, expected] of [
      [{ passed: true }, 0],
      [{ passed: false }, 1],
      [undefined, 1],
    ] as const) {
      if (report) writeFileSync(receipt, JSON.stringify(report));
      else rmSync(receipt);
      expect(
        spawnSync(process.execPath, [
          "apps/desktop/scripts/journey-evidence.mjs",
          out,
          "windows",
          "0",
          "1",
        ]).status,
      ).toBe(0);
      const rows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(rows.at(-1)!).exitCode).toBe(expected);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
