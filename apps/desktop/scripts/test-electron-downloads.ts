import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DesktopDownloadSchema } from "@opensteer/protocol/desktop";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

const directory =
  process.env.OPENSTEER_DOWNLOADS_E2E_ARTIFACT_DIR ??
  (process.env.OPENSTEER_QUIT_E2E_ARTIFACT_DIR
    ? path.join(path.dirname(process.env.OPENSTEER_QUIT_E2E_ARTIFACT_DIR), "downloads")
    : path.join(tmpdir(), `opensteer-downloads-e2e-${Date.now()}`));
mkdirSync(directory, { recursive: true });
const electron = z.string().parse(createRequire(import.meta.url)("electron"));
const child = spawn(electron, [path.resolve(".electron-smoke/electron-downloads-smoke.js")], {
  env: { ...process.env, OPENSTEER_DOWNLOADS_E2E_ARTIFACT_DIR: directory },
  stdio: "inherit",
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
let exit: unknown;
try {
  exit = await once(child, "exit");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
const [code, signal] = z.tuple([z.number().nullable(), z.string().nullable()]).parse(exit);
const pathsFile = path.join(directory, "exit-paths.json");
const exitPaths = existsSync(pathsFile)
  ? z
      .object({ staging: z.string(), partial: z.string() })
      .parse(JSON.parse(readFileSync(pathsFile, "utf8")))
  : null;
// Chromium may recreate a cancelled download's empty folder after close; its bytes never return.
const stagedFiles =
  exitPaths && existsSync(exitPaths.staging)
    ? readdirSync(exitPaths.staging, { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];
const remaining = exitPaths && existsSync(exitPaths.partial) ? [exitPaths.partial] : [];
const reportFile = path.join(directory, "electron.json");
const report = existsSync(reportFile)
  ? z
      .object({
        cases: z.array(z.object({ name: z.string(), passed: z.boolean() })),
        states: z.array(DesktopDownloadSchema),
      })
      .parse(JSON.parse(readFileSync(reportFile, "utf8")))
  : null;
// Chromium deletes temporary files asynchronously even after DownloadItem's done event.
// The parent inventories files only after the Electron process and its file threads exit.
const files = readdirSync(path.join(directory, "downloads")).map((name) => {
  const file = path.join(directory, "downloads", name);
  const bytes = readFileSync(file);
  const download = report?.states.find(
    (entry) => entry.filename === name && entry.state === "completed",
  );
  let quarantine: string | null = null;
  try {
    quarantine = execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* The preexisting fixture is intentionally unmarked. */
  }
  return {
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    state: download?.state ?? null,
    receivedBytes: download?.receivedBytes ?? null,
    quarantine,
  };
});
const unexpectedFiles = files.filter(
  (file) => file.state !== "completed" && file.name !== "existing.txt",
);
const sizeMismatches = files.filter(
  (file) => file.state === "completed" && file.size !== file.receivedBytes,
);
const unmarked = files.filter(
  (file) =>
    file.state === "completed" &&
    !/^[0-9a-f]{4};[0-9a-f]+;[^;]+;[A-Za-z0-9-]*$/iu.test(file.quarantine ?? ""),
);
const passed =
  code === 0 &&
  signal === null &&
  exitPaths !== null &&
  remaining.length === 0 &&
  stagedFiles.length === 0 &&
  unexpectedFiles.length === 0 &&
  sizeMismatches.length === 0 &&
  unmarked.length === 0 &&
  report !== null &&
  report.cases.length === 22 &&
  report.cases.every((test) => test.passed);
writeFileSync(
  path.join(directory, "parent.json"),
  JSON.stringify(
    {
      passed,
      code,
      signal,
      exitPaths,
      remaining,
      stagedFiles,
      unexpectedFiles,
      sizeMismatches,
      unmarked,
      files,
      states: report?.states,
      childExited: true,
      cases: report?.cases,
    },
    null,
    2,
  ),
);
process.stdout.write(
  `${JSON.stringify({ event: "electron-downloads-smoke.parent", passed, directory })}\n`,
);
assert(passed, `Downloads smoke failed; inspect ${directory}`);
