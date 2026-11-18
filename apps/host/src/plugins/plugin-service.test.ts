import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { HostMessageSchema } from "./engine-protocol.js";
import { PluginService } from "./plugin-service.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));
vi.mock("./engine-resources.js", () => ({ pluginEngineUnavailableReason: async () => undefined }));

it("orders first-install cache publication with an update of the discovered plugin", async () => {
  const plugin = "app_252169e9-de1b-4743-a005-50b6ed1b1fa0";
  let version = "v1";
  const app = () => ({
    id: plugin,
    name: "Fixture",
    slug: "fixture",
    activeVersion: version,
    requirements: { accounts: {} },
  });
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null,
    signalCode: null,
    send(raw: unknown) {
      const message = HostMessageSchema.parse(raw);
      if (message.type === "init") child.emit("message", { type: "ready", pid: 1, startupMs: 0 });
      if (message.type === "stop") child.emit("exit");
      if (message.type !== "request") return;
      const reply = (result: unknown) =>
        child.emit("message", {
          type: "result",
          id: message.id,
          operation: message.operation,
          result,
        });
      if (message.operation === "install") {
        if ("plugin" in message.input) version = "v2";
        reply({ status: "installed", plugin: app(), version: { id: version }, origin: "files" });
      } else if (message.operation === "installed") {
        reply([{ plugin: app(), links: [], readiness: {} }]);
      } else if (message.operation === "skillFiles") {
        reply({ plugin, slug: "fixture", version, hasPage: version === "v2", files: [] });
      }
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
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const record = service.skillCache.record.bind(service.skillCache);
  vi.spyOn(service.skillCache, "record").mockImplementation(async (bundle) => {
    if (bundle.version === "v1") {
      publishing.resolve();
      await release.promise;
    }
    await record(bundle);
  });
  const owner = { caller: "owner", mode: "automatic" as const };
  const source = { kind: "files" as const, files: [{ path: "index.ts", content: "" }] };
  const install = service.install({ ...source, key: "first" }, owner);
  const settled = [install];
  void install.catch(publishing.reject);
  try {
    await withTimeout(publishing.promise, 4_000, {
      timeoutError: () => new Error("First install did not reach cache publication"),
    });
    const [installed] = await service.installed({}, owner);
    expect(installed?.plugin).toMatchObject({ id: plugin, activeVersion: "v1" });
    if (!installed) throw new Error("Could not find installed plugin");
    const update = service.install({ ...source, plugin: installed.plugin.id }, owner);
    settled.push(update);
    // The in-memory child handles any unqueued update by the end of this turn.
    await setImmediate();
    if (version === "v2") await update;
    release.resolve();
    await Promise.all(settled);
    expect(await service.skillCache.get(plugin)).toMatchObject({ version: "v2", hasPage: true });
  } finally {
    release.resolve();
    await service.close();
    await Promise.allSettled(settled);
    await rm(directory, { recursive: true, force: true });
  }
});
