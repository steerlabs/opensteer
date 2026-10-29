#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { verifyNativeImageDecoder } from "@opensteer/harness";
import { inspectClaudeExecutable } from "@opensteer/harness-claude";
import { parseAgentExecutionConfig } from "./app-config.js";
import { harnessRuntimeVersionMismatches } from "./harness/verify-harness-runtimes.js";

/**
 * Fails when an engine this Runner ships does not answer `--version` with the
 * harness catalog's pin, or when the image decoder its drivers fit images with
 * cannot load. The container image runs it at build time. Private images can
 * additionally require the installed Claude CLI, without making it mandatory
 * for the public image.
 */
async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--require-installed-claude")) {
    const { harnessExecutables } = parseAgentExecutionConfig(process.env);
    const inspection = await inspectClaudeExecutable(
      harnessExecutables.claude,
      process.env,
      process.execPath,
    );
    process.stdout.write(`${JSON.stringify(inspection)}\n`);
    if (inspection.status !== "available") process.exitCode = 1;
  }
  await verifyNativeImageDecoder();
  const mismatches = await harnessRuntimeVersionMismatches(process.execPath);
  for (const { actual, executable, expected, kind } of mismatches) {
    process.stderr.write(`${kind}: ${executable} printed "${actual}", expected "${expected}"\n`);
  }
  if (mismatches.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
