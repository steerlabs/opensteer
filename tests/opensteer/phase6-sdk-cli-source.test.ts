import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
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
  const { stdout, stderr } = await execFile(
    process.execPath,
    ["--import", tsxLoaderPath, sourceCliScript, ...args],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfigPath,
      },
      maxBuffer: 1024 * 1024,
    },
  );

  expect(stderr.trim()).toBe("");
  return JSON.parse(stdout.trim()) as T;
}
