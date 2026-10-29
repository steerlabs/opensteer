import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runBounded } from "../scripts/command-runner.js";
import { migrationTimeoutMs } from "../scripts/test-migration-compat.js";
import type { TestDatabaseAuthority } from "../packages/database/src/test-database-admin.test-support.js";

export async function runMigrationPhase(
  root: string,
  phase: "migrate" | "seed" | "replay",
  authority: TestDatabaseAuthority,
  url: string,
  options: {
    readonly receipt?: string;
    readonly control?: "break-column" | "timeout";
    readonly signal?: AbortSignal;
  } = {},
) {
  const interrupted = new AbortController();
  const cancel = () => interrupted.abort(new Error("Migration phase interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel);
  try {
    return await runBounded(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./migration-compat-child.test-support.ts", import.meta.url)),
        resolve(root),
        phase,
        authority,
        url,
        options.receipt ?? "",
        options.control ?? "",
      ],
      {
        cwd: root,
        timeoutMs: migrationTimeoutMs,
        signal: AbortSignal.any([interrupted.signal, ...(options.signal ? [options.signal] : [])]),
        env: { PGOPTIONS: `-c statement_timeout=${migrationTimeoutMs}` },
      },
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel);
  }
}
