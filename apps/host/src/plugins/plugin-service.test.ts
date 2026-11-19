import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { HostMessageSchema } from "./engine-protocol.js";
import { PluginService } from "./plugin-service.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));
vi.mock("./engine-resources.js", () => ({ pluginEngineUnavailableReason: async () => undefined }));

it("refreshes what the Host keeps beside a published version before answering the engine", async () => {
  const plugin = "app_252169e9-de1b-4743-a005-50b6ed1b1fa0";
  const answered = Promise.withResolvers<unknown>();
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null,
    signalCode: null,
    send(raw: unknown) {
      const message = HostMessageSchema.parse(raw);
      if (message.type === "init") child.emit("message", { type: "ready", pid: 1, startupMs: 0 });
      if (message.type === "stop") child.emit("exit");
      if (message.type === "callbackResult" || message.type === "callbackError")
        answered.resolve(message);
      if (message.type !== "request") return;
      if (message.operation === "health")
        child.emit("message", {
          type: "result",
          id: message.id,
          operation: message.operation,
          result: { pid: 1, rss: 1, startupMs: 0 },
        });
      if (message.operation === "skillFiles")
        child.emit("message", {
          type: "result",
          id: message.id,
          operation: message.operation,
          result: { plugin, slug: "fixture", version: "v2", hasPage: true, files: [] },
        });
    },
  });
  vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-cache-test-"));
  const published: unknown[] = [];
  const service = new PluginService({
    processEntry: new URL("file:///unused.js"),
    databaseUrl: "postgres://unused.invalid/unused",
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32),
    origin: "https://fixture.invalid",
    onVersionPublished: async (version) => {
      // The skill record already names the version when its provenance is recorded.
      expect(await service.skillCache.get(plugin)).toMatchObject({ version: "v2" });
      published.push(version);
    },
  });
  try {
    await service.health({}, { caller: "owner", mode: "automatic" });
    child.emit("message", {
      type: "callback",
      id: "published",
      operation: "versionPublished",
      input: { plugin, version: "v2", from: "v1" },
    });
    expect(
      await withTimeout(answered.promise, 4_000, {
        timeoutError: () => new Error("The publication was never answered"),
      }),
    ).toMatchObject({ type: "callbackResult", id: "published" });
    expect(published).toEqual([{ plugin, version: "v2", from: "v1" }]);
    expect(await service.skillCache.get(plugin)).toMatchObject({ version: "v2", hasPage: true });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
