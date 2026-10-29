import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { JOURNEY_PREPARATION, runtimeResourceJourney } from "./journey-preparation.js";

it.each([
  [["electron"], "electron"],
  [["native-browser"], "native-browser"],
  [["native-browser", "electron"], "native-browser"],
  [["launch"], undefined],
] as const)("stages current runtime services for %j in %s", (selected, expected) => {
  expect(runtimeResourceJourney(selected)).toBe(expected);
});

it("noninteractive preparation installs a workspace app's development dependencies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "journey-install-"));
  const desktop = path.join(root, "apps/desktop");
  const protocol = path.join(root, "packages/protocol");
  mkdirSync(desktop, { recursive: true });
  mkdirSync(protocol, { recursive: true });
  const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  try {
    json(path.join(root, "package.json"), { private: true, packageManager: "pnpm@10.29.3" });
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    json(path.join(desktop, "package.json"), {
      name: "journey-desktop",
      private: true,
      type: "module",
      devDependencies: { "@journey/protocol": "workspace:*" },
    });
    json(path.join(protocol, "package.json"), {
      name: "@journey/protocol",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    });
    writeFileSync(path.join(protocol, "index.js"), "export const probe = 1;\n");
    execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: root,
      env: { ...process.env, CI: "true" },
      stdio: "pipe",
      timeout: 10000,
    });
    const [, command] = JOURNEY_PREPARATION[0];
    execFileSync("/bin/bash", ["-c", command], {
      cwd: desktop,
      env: process.env,
      stdio: "pipe",
      timeout: 10000,
    });
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { probe } from "@journey/protocol"; if (probe !== 1) process.exit(1);',
        ],
        { cwd: desktop, stdio: "pipe" },
      ),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

import {
  prepareAcceptedRun,
  acceptedRunResult,
  type PreparationRow,
} from "./journey-preparation.js";
it("accepted preparation failure returns 1 and marks all unstarted journeys skipped", async () => {
  const rows: PreparationRow[] = [];
  expect(
    await prepareAcceptedRun(
      async () => 1,
      () => false,
      rows,
    ),
  ).toBe(false);
  const result = acceptedRunResult(["saved-password", "launch"], [], rows, false);
  expect(rows).toMatchObject([{ step: "install", exitCode: 1 }]);
  expect(result.exitCode).toBe(1);
  expect(result.journeys.map((row) => row.outcome)).toEqual(["skipped", "skipped"]);
});
it("SIGTERM during accepted preparation returns 1 and records skipped journeys", async () => {
  const rows: PreparationRow[] = [];
  let interrupted = false;
  expect(
    await prepareAcceptedRun(
      async () => {
        interrupted = true;
        return 143;
      },
      () => interrupted,
      rows,
    ),
  ).toBe(false);
  const result = acceptedRunResult(["launch"], [], rows, interrupted);
  expect(result).toMatchObject({
    exitCode: 1,
    passed: false,
    journeys: [{ name: "launch", outcome: "skipped" }],
  });
  expect(rows[0]?.exitCode).toBe(143);
});
