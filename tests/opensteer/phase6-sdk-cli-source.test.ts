import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type {
  OpensteerPageSnapshotOutput,
  OpensteerSnapshotCounter,
} from "../../packages/protocol/src/index.js";
import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
  type Phase6FixtureServer,
} from "./phase6-fixture.js";

const execFile = promisify(execFileCallback);
const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx", { paths: [repoRoot] });
const sourceCliScript = path.resolve(repoRoot, "packages/opensteer/src/cli/bin.ts");
const repoTsconfigPath = path.resolve(repoRoot, "tsconfig.json");

let fixtureServer: Phase6FixtureServer | undefined;

beforeAll(async () => {
  fixtureServer = await startPhase6FixtureServer();
});

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

afterAll(async () => {
  await fixtureServer?.close();
});

describe("Phase 6 source-mode CLI", () => {
  test("source CLI preserves browser continuity across processes and tears down the session service on close", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase6-cli-source";

    const opened = await runSourceCliCommand<{ readonly url: string }>(rootDir, [
      "open",
      `${baseUrl}/phase6/main`,
      "--name",
      sessionName,
      "--headless",
      "true",
    ]);
    expect(opened.url).toBe(`${baseUrl}/phase6/main`);

    const snapshot = await runSourceCliCommand<OpensteerPageSnapshotOutput>(rootDir, [
      "snapshot",
      "action",
      "--name",
      sessionName,
    ]);
    expect(
      requireCounter(snapshot, (counter) => counter.pathHint.includes("#descriptor-button")),
    ).toBeDefined();

    const closed = await runSourceCliCommand<{ readonly closed: boolean }>(rootDir, [
      "close",
      "--name",
      sessionName,
    ]);
    expect(closed).toEqual({
      closed: true,
    });

    const metadataPath = path.join(
      rootDir,
      ".opensteer",
      "runtime",
      "sessions",
      encodeURIComponent(sessionName),
      "service.json",
    );
    await expect(access(metadataPath)).rejects.toThrow();
  }, 60_000);

  test("source CLI open surfaces structured profile inspection errors", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-cli-profile-blocked-"));

    try {
      await writeFile(path.join(userDataDir, "lockfile"), "");

      const { stdout, stderr } = await runFailingSourceCliCommand(rootDir, [
        "open",
        "https://example.com",
        "--browser",
        "profile",
        "--user-data-dir",
        userDataDir,
        "--headless",
        "true",
      ]);

      expect(stdout.trim()).toBe("");
      expect(stderr).toContain('"code":"profile-unavailable"');
      expect(stderr).toContain('"status":"browser_owned"');
      expect(stderr).toContain('"evidence":"singleton_artifacts"');
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});

function requireFixtureServer(): Phase6FixtureServer {
  if (!fixtureServer) {
    throw new Error("phase 6 fixture server is not running");
  }
  return fixtureServer;
}

function requireCounter(
  snapshot: OpensteerPageSnapshotOutput,
  predicate: (counter: OpensteerSnapshotCounter) => boolean,
): OpensteerSnapshotCounter {
  const match = snapshot.counters.find(predicate);
  if (!match) {
    throw new Error("failed to find expected snapshot counter");
  }
  return match;
}

async function runSourceCliCommand<T>(rootDir: string, args: readonly string[]): Promise<T> {
  const { stdout, stderr } = await runSourceCli(rootDir, args);
  expect(stderr.trim()).toBe("");
  return JSON.parse(stdout.trim()) as T;
}

async function runFailingSourceCliCommand(
  rootDir: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    return await runSourceCli(rootDir, args);
  } catch (error) {
    return {
      stdout:
        error instanceof Error && "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "",
      stderr:
        error instanceof Error && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "",
    };
  }
}

async function runSourceCli(
  rootDir: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFile(process.execPath, ["--import", tsxLoaderPath, sourceCliScript, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: repoTsconfigPath,
    },
    maxBuffer: 1024 * 1024,
  });
}
