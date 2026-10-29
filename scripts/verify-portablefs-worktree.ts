#!/usr/bin/env node
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyPortableFsSourceTree } from "./verify-portablefs-origin-main.js";

async function main(): Promise<void> {
  const configured =
    process.env.OPENSTEER_PORTABLEFS_SOURCE_DIR ??
    resolve(import.meta.dirname, "..", "..", "portablefs");
  const sourceDirectory = await realpath(configured).catch((error: unknown) => {
    throw new Error(`PortableFS source directory is unavailable: ${configured}`, { cause: error });
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opensteer-portablefs-worktree-"));
  try {
    const verified = await verifyPortableFsSourceTree({
      label: sourceDirectory,
      sourceDirectory,
      temporaryDirectory,
    });
    process.stdout.write(`${JSON.stringify({ sourceDirectory, ...verified }, null, 2)}\n`);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
