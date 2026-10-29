import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects early success without result evidence and records smoke failures", () => {
  const out = mkdtempSync(path.join(tmpdir(), "electron-journey-"));
  try {
    mkdirSync(path.join(out, "downloads"), { recursive: true });
    writeFileSync(path.join(out, "downloads.log"), "");
    writeFileSync(path.join(out, "quit.log"), "");
    for (const [code, report, expected, log] of [
      [0, undefined, 1, ""],
      [0, { passed: false }, 1, ""],
      [1, { passed: true }, 1, ""],
      [0, { passed: true }, 0, ""],
      [0, { passed: true }, 1, "Test skipped"],
    ] as const) {
      writeFileSync(path.join(out, "downloads.log"), log);
      if (report) writeFileSync(path.join(out, "downloads/parent.json"), JSON.stringify(report));
      const result = spawnSync(
        process.execPath,
        [
          "apps/desktop/scripts/test-support/validate-electron-journey.mjs",
          out,
          "downloads",
          String(code),
          "2",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const rows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(rows.at(-1)!).exitCode).toBe(expected);
    }
    const quit = path.join(out, "quit/quit-owned");
    mkdirSync(quit, { recursive: true });
    writeFileSync(
      path.join(quit, "tab-restore.json"),
      JSON.stringify({
        results: ["restore-before", "restore-normal", "restore-crash", "restore-after-crash"].map(
          (trial) => ({ trial }),
        ),
      }),
    );
    expect(
      spawnSync(process.execPath, [
        "apps/desktop/scripts/test-support/validate-electron-journey.mjs",
        out,
        "quit",
        "0",
        "3",
      ]).status,
    ).toBe(0);
    const quitRows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(quitRows.at(-1)!).exitCode).toBe(0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("requires every folded smoke in order under the explicit journey output", () => {
  const out = mkdtempSync(path.join(tmpdir(), "journey-evidence-"));
  const smokes = [
    "cdp-boundary",
    "passwords",
    "attachments",
    "downloads",
    "profile-restore",
    "focus",
    "host-transport",
    "browser",
    "idle",
    "quit",
    "cookies",
    "passkeys",
    "usb",
  ];
  const passed = smokes.map((name) => ({ name, exitCode: 0, seconds: 1 }));
  try {
    mkdirSync(path.join(out, "electron"));
    writeFileSync(path.join(out, "electron.log"), "");
    for (const [rows, expected] of [
      [passed, 0],
      [passed.slice(1), 1],
      [[...passed].reverse(), 1],
      [[...passed, passed[0]], 1],
      [passed.map((row) => (row.name === "passkeys" ? { ...row, exitCode: 1 } : row)), 1],
    ] as const) {
      writeFileSync(
        path.join(out, "electron/results.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      expect(
        spawnSync(process.execPath, [
          "apps/desktop/scripts/journey-evidence.mjs",
          out,
          "electron",
          "0",
          "1",
        ]).status,
      ).toBe(0);
      const results = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(results.at(-1)!).exitCode).toBe(expected);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
