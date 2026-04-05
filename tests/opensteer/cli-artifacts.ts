import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");
const CLI_BUILD_LOCK = path.resolve(process.cwd(), ".opensteer", "test-locks", "cli-build");
const CLI_BUILD_STAMP = path.resolve(process.cwd(), ".opensteer", "test-locks", "cli-build-ready.json");
const CLI_BUILD_TIMEOUT_MS = 120_000;
const CLI_BUILD_POLL_INTERVAL_MS = 100;
const CLI_BUILD_INPUTS = [
  "package.json",
  "scripts/sync-package-skills.mjs",
  "packages/browser-core/src",
  "packages/engine-abp/src",
  "packages/engine-playwright/src",
  "packages/opensteer/package.json",
  "packages/opensteer/src",
  "packages/protocol/src",
  "packages/runtime-core/src",
  "skills",
] as const;

let buildPromise: Promise<void> | undefined;

export async function ensureCliArtifactsBuilt(): Promise<void> {
  buildPromise ??= ensureCliArtifactsBuiltOnce();
  await buildPromise;
}

async function ensureCliArtifactsBuiltOnce(): Promise<void> {
  const sourceMtimeMs = await getLatestCliInputMtimeMs();
  if (await isCliBuildReady(sourceMtimeMs)) {
    return;
  }

  await mkdir(path.dirname(CLI_BUILD_LOCK), { recursive: true });

  while (true) {
    try {
      await mkdir(CLI_BUILD_LOCK, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        throw error;
      }

      await waitForCliArtifactsOrLockRelease(sourceMtimeMs);
    }
  }

  try {
    if (await isCliBuildReady(sourceMtimeMs)) {
      return;
    }

    await execFile("pnpm", ["build"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });

    if (!(await pathExists(CLI_SCRIPT))) {
      throw new Error("pnpm build completed without creating packages/opensteer/dist/cli/bin.js.");
    }

    await writeFile(CLI_BUILD_STAMP, JSON.stringify({ sourceMtimeMs }), "utf8");
  } finally {
    await rm(CLI_BUILD_LOCK, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitForCliArtifactsOrLockRelease(sourceMtimeMs: number): Promise<void> {
  const deadline = Date.now() + CLI_BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isCliBuildReady(sourceMtimeMs)) {
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

async function isCliBuildReady(sourceMtimeMs: number): Promise<boolean> {
  if (!(await pathExists(CLI_SCRIPT)) || !(await pathExists(CLI_BUILD_STAMP))) {
    return false;
  }

  try {
    const stamp = JSON.parse(await readFile(CLI_BUILD_STAMP, "utf8")) as {
      readonly sourceMtimeMs?: number;
    };
    return typeof stamp.sourceMtimeMs === "number" && stamp.sourceMtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

async function getLatestCliInputMtimeMs(): Promise<number> {
  let latestMtimeMs = 0;
  for (const relativePath of CLI_BUILD_INPUTS) {
    latestMtimeMs = Math.max(latestMtimeMs, await getLatestPathMtimeMs(path.resolve(process.cwd(), relativePath)));
  }
  return latestMtimeMs;
}

async function getLatestPathMtimeMs(targetPath: string): Promise<number> {
  const targetStat = await stat(targetPath);
  let latestMtimeMs = targetStat.mtimeMs;
  if (!targetStat.isDirectory()) {
    return latestMtimeMs;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    latestMtimeMs = Math.max(
      latestMtimeMs,
      await getLatestPathMtimeMs(path.join(targetPath, entry.name)),
    );
  }
  return latestMtimeMs;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
