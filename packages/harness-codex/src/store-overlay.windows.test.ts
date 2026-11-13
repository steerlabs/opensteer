import {
  linkNames,
  nativeUserHarnessRuntimeBoundary,
  type SupervisedProcess,
} from "@opensteer/harness";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHarnessDriver } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function* noOutput(): AsyncIterable<Buffer> {
  yield* [];
}

function signedOut(): SupervisedProcess {
  return {
    child: { stdin: new PassThrough() } as unknown as SupervisedProcess["child"],
    exited: Promise.resolve({ code: 0, signal: null }),
    stderr: noOutput(),
    stdout: noOutput(),
    terminate: async () => undefined,
  };
}

function isolatedProfile(directory: string) {
  const privateStateRoot = join(directory, "state");
  return {
    continuationKey: `test:${directory}:isolated`,
    kind: "isolated" as const,
    privateStateRoot,
    providerHomeDirectory: join(directory, "profile", "provider-home"),
    store: {
      directory: join(privateStateRoot, "harness-stores", "codex", "store"),
      id: "store-fixture",
    },
  };
}

describe("the Codex session store overlay on Windows", () => {
  it("joins a profile to the shared store through junctions, merging what it held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer codex store "));
    roots.push(directory);
    const profile = isolatedProfile(directory);
    const home = profile.providerHomeDirectory;
    const store = profile.store.directory;
    const day = join("2026", "09", "05");
    // A legacy profile owns real rollout files, one of them already in the store.
    await mkdir(join(home, "sessions", day), { recursive: true });
    await writeFile(join(home, "sessions", day, "legacy.jsonl"), "legacy\n");
    await writeFile(join(home, "sessions", day, "shared.jsonl"), "same\n");
    await mkdir(join(store, "sessions", day), { recursive: true });
    await writeFile(join(store, "sessions", day, "shared.jsonl"), "same\n");
    // A stale junction still leads to history that must be adopted, not lost.
    const stale = join(directory, "stale-store");
    await mkdir(stale);
    await writeFile(join(stale, "archived.jsonl"), "archived\n");
    await symlink(stale, join(home, "archived_sessions"), "junction");
    // A junction inside the legacy tree must lead into the store once that tree is gone.
    await symlink(join(home, "sessions", day), join(home, "sessions", "latest"), "junction");
    await symlink(stale, join(home, "sessions", "elsewhere"), "junction");

    const driver = new CodexHarnessDriver({
      launch: { arguments: [], executable: process.execPath },
      spawnAuthenticationProcess: () => signedOut(),
    });
    const logout = () =>
      driver.logout({
        config: {},
        environment: {},
        providerState: profile,
        runtimeBoundary: nativeUserHarnessRuntimeBoundary,
        signal: new AbortController().signal,
        sourceId: "openai",
        workingDirectory: directory,
      });
    // Concurrent setups see the same legacy state; exactly one overlay results.
    await Promise.all([logout(), logout(), logout()]);
    await logout();

    for (const entry of ["sessions", "archived_sessions"]) {
      expect((await lstat(join(home, entry))).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(join(home, "sessions", day, "legacy.jsonl"), "utf8")).toBe("legacy\n");
    expect(await readFile(join(store, "sessions", day, "legacy.jsonl"), "utf8")).toBe("legacy\n");
    expect(await readFile(join(store, "archived_sessions", "archived.jsonl"), "utf8")).toBe(
      "archived\n",
    );
    expect(await readFile(join(stale, "archived.jsonl"), "utf8")).toBe("archived\n");

    // A rollout written through the profile lands in the shared store.
    await writeFile(join(home, "sessions", day, "new.jsonl"), "new\n");
    expect(await readFile(join(store, "sessions", day, "new.jsonl"), "utf8")).toBe("new\n");

    // Deleting the profile removes its junctions and never the shared history.
    await rm(join(directory, "profile"), { force: true, recursive: true });
    expect(await readFile(join(store, "sessions", day, "new.jsonl"), "utf8")).toBe("new\n");
    expect(await readFile(join(store, "sessions", day, "shared.jsonl"), "utf8")).toBe("same\n");
    expect(await linkNames(join(store, "sessions", "latest"), join(store, "sessions", day))).toBe(
      true,
    );
    expect(await readFile(join(store, "sessions", "latest", "legacy.jsonl"), "utf8")).toBe(
      "legacy\n",
    );
    expect(await linkNames(join(store, "sessions", "elsewhere"), stale)).toBe(true);
    expect(await readFile(join(store, "sessions", "elsewhere", "archived.jsonl"), "utf8")).toBe(
      "archived\n",
    );
  });
});
