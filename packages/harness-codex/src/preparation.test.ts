import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  type HarnessProviderState,
} from "@opensteer/harness";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CodexHarnessDriver } from "./codex-driver.js";
import { CodexHarnessConfigSchema, TESTED_CODEX_CLI_VERSION } from "./config.js";
import { packagedCodexExecutable } from "./executable.js";
import { CodexStdioClient } from "./process.js";
import { requireObject, requireString } from "./protocol.js";

const execFileAsync = promisify(execFile);
const codexExecutable = packagedCodexExecutable();
const installedCodex = await probeCodex(codexExecutable);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Codex native store preparation", () => {
  it("keeps private profile indices resumable through one shared rollout store", async () => {
    expect(installedCodex.version).toBe(TESTED_CODEX_CLI_VERSION);
    const root = await mkdtemp(join(tmpdir(), "opensteer-codex-native-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const store = join(root, "store");
    const osHome = join(root, "os-home");
    await Promise.all([mkdir(workspace), mkdir(osHome), mkdir(store)]);

    const threadId = randomUUID();
    const rolloutPath = await writeSyntheticRollout(store, workspace, threadId);
    const profileA = providerState(root, store, "profile-a");
    const profileB = providerState(root, store, "profile-b");
    const profileC = providerState(root, store, "profile-c-isolated-service");
    const driver = new CodexHarnessDriver({
      launch: { arguments: [], executable: codexExecutable },
    });
    const context = (providerState: HarnessProviderState) => ({
      config: {},
      environment: isolatedEnvironment(osHome),
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "openai",
      workingDirectory: workspace,
    });

    await driver.prepare(context(profileA));
    expect(indexedThreadCount(profileA)).toBe(0);
    await expect(driver.inspect(context(profileA))).resolves.toMatchObject({
      status: "authentication-required",
    });
    await expect(resumeThread(profileA, workspace, osHome, threadId)).resolves.toBe(threadId);
    expect(indexedThreadCount(profileA)).toBe(1);

    const profileASqlite = join(profileHome(profileA), "sqlite");
    const profileAIndex = await snapshotDirectory(profileASqlite);
    await driver.prepare(context(profileB));
    expect(indexedThreadCount(profileB)).toBe(0);
    await expect(driver.inspect(context(profileB))).resolves.toMatchObject({
      status: "authentication-required",
    });
    expect(await snapshotDirectory(profileASqlite)).toEqual(profileAIndex);

    const sessionsA = join(profileHome(profileA), "sessions");
    const sessionsB = join(profileHome(profileB), "sessions");
    expect(resolve(dirname(sessionsA), await readlink(sessionsA))).toBe(join(store, "sessions"));
    expect(resolve(dirname(sessionsB), await readlink(sessionsB))).toBe(join(store, "sessions"));
    expect((await lstat(profileASqlite)).isDirectory()).toBe(true);
    expect((await lstat(join(profileHome(profileB), "sqlite"))).isDirectory()).toBe(true);
    expect(await readdir(profileASqlite)).toContain("state_5.sqlite");
    expect(await readdir(join(profileHome(profileB), "sqlite"))).toContain("state_5.sqlite");

    const isolatedServiceContext = {
      ...context(profileC),
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    };
    await driver.prepare(isolatedServiceContext);
    expect(indexedThreadCount(profileC)).toBe(0);
    await expect(driver.inspect(isolatedServiceContext)).resolves.toMatchObject({
      status: "authentication-required",
    });
    expect(await readdir(join(profileHome(profileC), "sqlite"))).toContain("state_5.sqlite");

    await rm(profileHome(profileA), { force: true, recursive: true });
    expect(await readFile(rolloutPath, "utf8")).toContain(threadId);
    await expect(resumeThread(profileB, workspace, osHome, threadId)).resolves.toBe(threadId);
  }, 30_000);

  it("seeds once before concurrent first callers can link the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-codex-first-start-"));
    temporaryDirectories.push(root);
    const store = join(root, "store");
    const osHome = join(root, "os-home");
    await mkdir(osHome);
    await writeSyntheticRollout(store, root, randomUUID());
    const profile = providerState(root, store, "profile");
    const context = {
      config: {},
      environment: isolatedEnvironment(osHome),
      providerState: profile,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "openai",
      workingDirectory: root,
    };
    const driver = new CodexHarnessDriver({
      launch: { arguments: [], executable: codexExecutable },
    });
    const start = CodexStdioClient.start.bind(CodexStdioClient);
    let emptyStarts = 0;
    const starts = vi.spyOn(CodexStdioClient, "start").mockImplementation(async (options) => {
      const sessions = await lstat(join(profileHome(profile), "sessions")).catch((error) => {
        if (nodeErrorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      const client = await start(options);
      if (!sessions) {
        emptyStarts += 1;
        const request = client.request.bind(client);
        vi.spyOn(client, "request").mockImplementationOnce(async (...args) => {
          expect(args[0]).toBe("initialize");
          const initialized = await request(...args);
          for (const entry of ["sessions", "archived_sessions"]) {
            await expect(lstat(join(profileHome(profile), entry))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          return initialized;
        });
      }
      return client;
    });
    try {
      await Promise.all([driver.prepare(context), driver.inspect(context), driver.logout(context)]);
      expect(emptyStarts).toBe(1);
      expect(indexedThreadCount(profile)).toBe(0);
      for (const entry of ["sessions", "archived_sessions"]) {
        const link = join(profileHome(profile), entry);
        expect(resolve(dirname(link), await readlink(link))).toBe(join(store, entry));
      }
    } finally {
      starts.mockRestore();
    }
  });

  it("leaves the store unlinked after a failed seed and retries even with a database", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-codex-seed-retry-"));
    temporaryDirectories.push(root);
    const store = join(root, "store");
    const osHome = join(root, "os-home");
    await mkdir(osHome);
    const threadId = randomUUID();
    await writeSyntheticRollout(store, root, threadId);
    const profile = providerState(root, store, "profile");
    const context = {
      config: {},
      environment: isolatedEnvironment(osHome),
      providerState: profile,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "openai",
      workingDirectory: root,
    };
    const driver = new CodexHarnessDriver({
      launch: { arguments: [], executable: codexExecutable },
    });
    const start = CodexStdioClient.start.bind(CodexStdioClient);
    const starts = vi.spyOn(CodexStdioClient, "start").mockImplementationOnce(async (options) => {
      const client = await start(options);
      const request = client.request.bind(client);
      vi.spyOn(client, "request").mockImplementationOnce(async (...args) => {
        await request(...args);
        throw new Error("Seed initialize failed");
      });
      return client;
    });
    try {
      await expect(driver.prepare(context)).rejects.toThrow("Seed initialize failed");
      for (const entry of ["sessions", "archived_sessions"]) {
        await expect(lstat(join(profileHome(profile), entry))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(indexedThreadCount(profile)).toBe(0);
      await driver.prepare(context);
      expect(starts).toHaveBeenCalledTimes(3);
      expect(indexedThreadCount(profile)).toBe(0);
      await expect(resumeThread(profile, root, osHome, threadId)).resolves.toBe(threadId);
    } finally {
      starts.mockRestore();
    }
  });
});

function indexedThreadCount(state: HarnessProviderState): number {
  const database = new DatabaseSync(join(profileHome(state), "sqlite", "state_5.sqlite"), {
    readOnly: true,
  });
  try {
    return Number(database.prepare("SELECT count(*) AS count FROM threads").get()?.count);
  } finally {
    database.close();
  }
}

async function probeCodex(executable: string): Promise<{ readonly version: string }> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env: isolatedEnvironment(tmpdir()),
      timeout: 5_000,
    });
    const match = /codex-cli\s+(\S+)/.exec(stdout);
    if (!match?.[1])
      throw new Error(`Could not parse Codex version from ${JSON.stringify(stdout)}`);
    return { version: match[1] };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new Error(
        "Packaged Codex is required. Install it from the repository root with: pnpm install --frozen-lockfile",
        { cause: error },
      );
    }
    throw error;
  }
}

function isolatedEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: tmpdir(),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function providerState(root: string, store: string, profile: string): HarnessProviderState {
  const privateStateRoot = join(root, profile);
  return {
    continuationKey: `codex:${store}`,
    kind: "isolated",
    privateStateRoot,
    providerHomeDirectory: join(privateStateRoot, "provider-home"),
    store: { directory: store, id: "shared-codex-store" },
  };
}

function profileHome(state: HarnessProviderState): string {
  if (!state.providerHomeDirectory) throw new Error("Expected an isolated provider home");
  return state.providerHomeDirectory;
}

async function writeSyntheticRollout(
  store: string,
  cwd: string,
  threadId: string,
): Promise<string> {
  const now = new Date();
  const timestamp = now.toISOString();
  const [date] = timestamp.split("T");
  const [year, month, day] = date?.split("-") ?? [];
  if (!year || !month || !day) throw new Error("Could not derive rollout date");
  const filenameTimestamp = timestamp.slice(0, 19).replaceAll(":", "-");
  const directory = join(store, "sessions", year, month, day);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${filenameTimestamp}-${threadId}.jsonl`);
  const records = [
    {
      payload: {
        cli_version: TESTED_CODEX_CLI_VERSION,
        cwd,
        history_mode: "legacy",
        id: threadId,
        model_provider: "openai",
        originator: "cli",
        selected_capability_roots: [],
        session_id: threadId,
        source: "cli",
        timestamp,
      },
      timestamp,
      type: "session_meta",
    },
    {
      payload: {
        content: [{ text: "native store preparation probe", type: "input_text" }],
        role: "user",
        type: "message",
      },
      timestamp,
      type: "response_item",
    },
  ];
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

async function resumeThread(
  state: HarnessProviderState,
  cwd: string,
  osHome: string,
  threadId: string,
): Promise<string> {
  const home = profileHome(state);
  const config = CodexHarnessConfigSchema.parse({});
  const client = await CodexStdioClient.start({
    appServerArgs: [
      "--strict-config",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      'cli_auth_credentials_store="file"',
    ],
    config,
    cwd,
    environment: {
      ...isolatedEnvironment(osHome),
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: join(home, "sqlite"),
    },
    launch: { arguments: [], executable: codexExecutable },
    onFailure: () => undefined,
    onMethodMessage: () => undefined,
    signal: new AbortController().signal,
  });
  try {
    const initialized = requireObject(
      await client.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: { name: "opensteer_test", title: "Opensteer Test", version: "0.0.0" },
      }),
      "initialize result",
    );
    expect(requireString(initialized.userAgent, "initialize result.userAgent")).toContain(
      TESTED_CODEX_CLI_VERSION,
    );
    await client.notify("initialized", {});
    const resumed = requireObject(
      await client.request("thread/resume", { excludeTurns: true, threadId }),
      "thread/resume result",
    );
    const thread = requireObject(resumed.thread, "thread/resume result.thread");
    return requireString(thread.id, "thread/resume result.thread.id");
  } finally {
    await client.close();
  }
}

async function snapshotDirectory(directory: string): Promise<Readonly<Record<string, Buffer>>> {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => [basename(entry.name), await readFile(join(directory, entry.name))]),
    ),
  );
}
