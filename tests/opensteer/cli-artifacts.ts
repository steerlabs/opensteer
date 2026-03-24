import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");
const CLI_BUILD_LOCK = path.resolve(process.cwd(), ".opensteer", "test-locks", "cli-build");
const CLI_BUILD_TIMEOUT_MS = 120_000;
const CLI_BUILD_POLL_INTERVAL_MS = 100;

let buildPromise: Promise<void> | undefined;

export async function ensureCliArtifactsBuilt(): Promise<void> {
  buildPromise ??= ensureCliArtifactsBuiltOnce();
  await buildPromise;
}

async function ensureCliArtifactsBuiltOnce(): Promise<void> {
  if (await pathExists(CLI_SCRIPT)) {
    return;
  }

  while (true) {
    try {
      await mkdir(CLI_BUILD_LOCK, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        throw error;
      }

      await waitForCliArtifactsOrLockRelease();
      if (await pathExists(CLI_SCRIPT)) {
        return;
      }
    }
  }

  try {
    if (!(await pathExists(CLI_SCRIPT))) {
      await execFile("pnpm", ["build"], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 4,
      });
    }
  } finally {
    await rm(CLI_BUILD_LOCK, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!(await pathExists(CLI_SCRIPT))) {
    throw new Error("pnpm build completed without creating packages/opensteer/dist/cli/bin.js.");
  }
}

async function waitForCliArtifactsOrLockRelease(): Promise<void> {
  const deadline = Date.now() + CLI_BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pathExists(CLI_SCRIPT)) {
      return;
    }
    if (!(await pathExists(CLI_BUILD_LOCK))) {
      return;
    }
    await sleep(CLI_BUILD_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out while waiting for another test worker to build CLI artifacts.");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
