#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { verifyNativeImageDecoder } from "@opensteer/harness";
import { inspectClaudeExecutable } from "@opensteer/harness-claude";
import { parseAgentExecutionConfig } from "./app-config.js";
import {
  harnessRuntimeVersionMismatches,
  verifyInstalledClaudeVersion,
} from "./harness/verify-harness-runtimes.js";

/**
 * Fails when an engine this Runner ships does not answer `--version` with the
 * harness catalog's pin, or when the image decoder its drivers fit images with
 * cannot load. The container image runs it at build time. Private images can
 * check that an installed Claude CLI is supported. An image that bundles it
 * can also require its exact version.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--require-claude-version");
  if (versionIndex >= 0) {
    const version = args[versionIndex + 1];
    if (!version || !/^\d+\.\d+\.\d+$/u.test(version))
      throw new Error("Expected a Claude Code version");
    const { harnessExecutables } = parseAgentExecutionConfig(process.env);
    await verifyInstalledClaudeVersion(
      harnessExecutables.claude,
      version,
      process.env,
      process.execPath,
    );
  }
  if (args.includes("--require-installed-claude")) {
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
