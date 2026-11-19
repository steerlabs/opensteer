import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostMessageSchema } from "./engine-protocol.js";
import { PluginService } from "./plugin-service.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));
vi.mock("./engine-resources.js", () => ({ pluginEngineUnavailableReason: async () => undefined }));
const active = vi.hoisted(() => new Map<string, string>());
vi.mock("./engine-storage.js", () => ({
  engineActiveVersions: async () => active,
  engineDemand: async () => ({ busy: false, dueInMs: null }),
}));

it("makes the skill record follow the active version, and repairs a refresh that failed", async () => {
  const plugin = "app_252169e9-de1b-4743-a005-50b6ed1b1fa0";
  active.set(plugin, "v2");
  const answered: unknown[] = [];
  let reads = 0;
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null,
    signalCode: null,
    send(raw: unknown) {
      const message = HostMessageSchema.parse(raw);
      if (message.type === "init") child.emit("message", { type: "ready", pid: 1, startupMs: 0 });
      if (message.type === "stop") child.emit("exit");
      if (message.type === "callbackResult" || message.type === "callbackError")
        answered.push(message);
      if (message.type !== "request") return;
      if (message.operation === "health")
        child.emit("message", {
          type: "result",
          id: message.id,
          operation: message.operation,
          result: { pid: 1, rss: 1, startupMs: 0 },
        });
      if (message.operation === "skillFiles")
        // The first refresh fails; every later one reads the active version's files.
        child.emit(
          "message",
          (reads += 1) === 1
            ? { type: "error", id: message.id, error: { code: "engine", message: "Read failed" } }
            : {
                type: "result",
                id: message.id,
                operation: message.operation,
                result: { plugin, slug: "fixture", version: "v2", hasPage: true, files: [] },
              },
        );
    },
  });
  vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-cache-test-"));
  const service = new PluginService({
    processEntry: new URL("file:///unused.js"),
    databaseUrl: "postgres://unused.invalid/unused",
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32),
    origin: "https://fixture.invalid",
  });
  const published = (id: string) => {
    child.emit("message", {
      type: "callback",
      id,
      operation: "versionPublished",
      input: { plugin },
    });
    return vi.waitFor(() => expect(answered).toContainEqual(expect.objectContaining({ id })), {
      timeout: 4_000,
    });
  };
  try {
    // The engine's start reconciles every plugin; this refresh fails and leaves no record.
    await service.health({}, { caller: "owner", mode: "automatic" });
    await vi.waitFor(() => expect(reads).toBe(1), { timeout: 4_000 });
    expect(await service.skillCache.get(plugin)).toBeUndefined();
    // The next promotion repairs it, and is answered once the record follows it.
    await published("first");
    expect(answered).toContainEqual(
      expect.objectContaining({ type: "callbackResult", id: "first" }),
    );
    expect(await service.skillCache.get(plugin)).toMatchObject({ version: "v2", hasPage: true });
    // A record that already follows the active version is not read again.
    await published("again");
    expect(reads).toBe(2);
    // A plugin with no active version has no record.
    active.delete(plugin);
    await published("removed");
    expect(await service.skillCache.get(plugin)).toBeUndefined();
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("writes no skill record for a version a later change replaced while it was read", async () => {
  const plugin = "app_0f6e2a43-6c55-4d1a-9f53-2b1f2f0e8c11";
  active.set(plugin, "v1");
  /** Each read of the plugin's files, answered when the test says. */
  const reads: Array<{ id: string; version: string }> = [];
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null,
    signalCode: null,
    send(raw: unknown) {
      const message = HostMessageSchema.parse(raw);
      if (message.type === "init") child.emit("message", { type: "ready", pid: 1, startupMs: 0 });
      if (message.type === "stop") child.emit("exit");
      if (message.type !== "request") return;
      if (message.operation === "health")
        child.emit("message", {
          type: "result",
          id: message.id,
          operation: message.operation,
          result: { pid: 1, rss: 1, startupMs: 0 },
        });
      // The engine reads the version active when the read reaches it.
      if (message.operation === "skillFiles")
        reads.push({ id: message.id, version: active.get(plugin)! });
    },
  });
  const answer = (read: { id: string; version: string }) =>
    child.emit("message", {
      type: "result",
      id: read.id,
      operation: "skillFiles",
      result: {
        plugin,
        slug: "fixture",
        version: read.version,
        hasPage: read.version === "v1",
        files: [],
      },
    });
  vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-cache-race-"));
  const service = new PluginService({
    processEntry: new URL("file:///unused.js"),
    databaseUrl: "postgres://unused.invalid/unused",
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32),
    origin: "https://fixture.invalid",
  });
  try {
    await service.health({}, { caller: "owner", mode: "automatic" });
    // The start's refresh reads v1 and is slow; v2 becomes active meanwhile and is published.
    await vi.waitFor(() => expect(reads).toHaveLength(1), { timeout: 4_000 });
    active.set(plugin, "v2");
    const second = service.reconcileSkills([plugin]);
    // Refreshes of one plugin run one at a time: the second has not read anything yet.
    expect(reads).toHaveLength(1);
    answer(reads[0]!);
    await vi.waitFor(() => expect(reads).toHaveLength(2), { timeout: 4_000 });
    // The slow refresh wrote nothing for the version v2 replaced.
    expect(await service.skillCache.get(plugin)).toBeUndefined();
    answer(reads[1]!);
    await second;
    expect(await service.skillCache.get(plugin)).toMatchObject({ version: "v2" });
    // Views use an entry only while it names the active version.
    expect(await service.activeEntry(plugin)).toMatchObject({ version: "v2" });
    active.set(plugin, "v3");
    expect(await service.activeEntry(plugin)).toBeUndefined();
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
