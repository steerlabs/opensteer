import { createHostRuntime } from "../runtime/runtime.js";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type HostApiCommand, runnerIntegrationsProtocolVersion } from "@opensteer/protocol";
import { LocalMcpServers } from "@opensteer/runner";
import { IntegrationPlatformStore } from "@opensteer/database";
import { testRpcData } from "../server/test-host-api-request.js";
import { connectComputerAppMachine } from "../runtime/computer-apps.test-support.js";
import {
  createMachineAccessDatabase,
  startMachineAccessHost,
} from "../runtime/machine-access.test-support.js";

let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
beforeAll(async () => {
  database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
}, 120_000);
afterAll(async () => {
  await database?.drop();
}, 120_000);

it("queues plugin cleanup atomically, gates old Runners, acknowledges and replays on attach", async () => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "plugin-data-removal-")));
  const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
  const closers: (() => Promise<void>)[] = [];
  try {
    const local = new LocalMcpServers({ stateDirectory: work });
    const remove = vi.spyOn(local, "removePluginData").mockImplementationOnce(async () => {});
    const capable = await connectComputerAppMachine(host, [], {
      desktop: { localMcp: local },
      integrations: {
        platform: "darwin",
        protocolVersion: runnerIntegrationsProtocolVersion,
        pluginDataRemoval: 1,
      },
    });
    closers.push(() => capable.close());
    const oldLocal = new LocalMcpServers({ stateDirectory: work });
    const oldRemove = vi.spyOn(oldLocal, "removePluginData");
    const old = await connectComputerAppMachine(host, [], { desktop: { localMcp: oldLocal } });
    closers.push(() => old.close());
    const plugin = join(work, "plugin");
    await mkdir(plugin);
    await writeFile(
      join(plugin, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "removal-fixture",
      }),
    );
    await writeFile(
      join(plugin, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          device: { type: "stdio", command: "node", args: ["-e", "process.stdin.resume()"] },
        },
      }),
    );
    const dispatch = (
      input: Extract<
        HostApiCommand,
        { type: "plugin.install" | "plugin.remove" | "integration.uninstall" }
      >,
    ) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          ...input,
          idempotencyKey: globalThis.crypto.randomUUID(),
        },
        { headers: host.ownerHeaders },
      );
    await dispatch({
      idempotencyKey: globalThis.crypto.randomUUID(),
      type: "plugin.install",
      input: { directory: plugin, runnerId: capable.runnerId },
    });
    const installed = await host.store.database
      .selectFrom("plugins")
      .select("id")
      .where("name", "=", "removal-fixture")
      .executeTakeFirstOrThrow();
    const servers = await host.store.database
      .selectFrom("integrationServers")
      .selectAll()
      .execute();
    const server = servers.find((row) => row.transport.runnerId === capable.runnerId);
    if (!server) throw new Error("Plugin server was not installed on the capable Runner");
    // A second server on an older computer must leave a durable cleanup obligation.
    await host.store.database
      .insertInto("integrationServers")
      .values({
        ...server,
        id: `isrv_${globalThis.crypto.randomUUID()}` as typeof server.id,
        name: "old-device",
        transport: { ...server.transport, runnerId: old.runnerId },
      })
      .execute();
    const data = join(work, "plugin-data", installed.id);
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "pairing"), "secret");
    const hostData = join(host.config.dataDirectory, "plugins", "data", installed.id);
    await mkdir(hostData, { recursive: true });
    await writeFile(join(hostData, "pairing"), "host-secret");
    await dispatch({
      idempotencyKey: globalThis.crypto.randomUUID(),
      type: "integration.uninstall",
      installationId: server.installationId,
    });
    expect(
      await host.store.database
        .selectFrom("integrationInstallations")
        .select("id")
        .where("id", "=", server.installationId)
        .execute(),
    ).toEqual([]);
    expect(
      await host.store.database
        .selectFrom("integrationServers")
        .select("id")
        .where("installationId", "=", server.installationId)
        .execute(),
    ).toEqual([]);
    expect(
      await host.store.database
        .selectFrom("runnerPluginDataRemovals")
        .select("runnerId")
        .where("pluginId", "=", installed.id)
        .execute(),
    ).toEqual(expect.arrayContaining([{ runnerId: capable.runnerId }, { runnerId: old.runnerId }]));
    expect(
      await new IntegrationPlatformStore(host.store.database).plugins.pendingDataRemovals(),
    ).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    await dispatch({
      idempotencyKey: globalThis.crypto.randomUUID(),
      type: "plugin.remove",
      pluginId: installed.id,
    });
    await vi.waitFor(
      () =>
        expect(remove, "Attached capable Runner did not receive cleanup").toHaveBeenCalledTimes(1),
      { timeout: 10_000 },
    );
    await capable.disconnectModule();
    const store = new IntegrationPlatformStore(host.store.database);
    expect(await store.plugins.pendingDataRemovals()).toHaveLength(2);
    expect(oldRemove).not.toHaveBeenCalled();
    await expect(readFile(join(hostData, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
    await capable.reconnectModule();
    await vi.waitFor(
      async () => {
        expect(
          await store.plugins.pendingDataRemovals(capable.runnerId),
          "Runner did not confirm plugin data removal after reattach",
        ).toEqual([]);
      },
      { timeout: 10_000 },
    );
    expect(remove).toHaveBeenCalledWith(installed.id);
    await expect(readFile(join(data, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.plugins.pendingDataRemovals(old.runnerId)).toHaveLength(1);
    // A crash after commit can leave the Host directory, as can a failed pre-commit install.
    await mkdir(hostData, { recursive: true });
    await writeFile(join(hostData, "pairing"), "stranded");
    const packageData = join(host.config.dataDirectory, "plugins", "data", "packages");
    await mkdir(packageData, { recursive: true });
    await writeFile(join(packageData, "snapshot"), "retained");
    const survivorId = globalThis.crypto.randomUUID();
    await store.plugins.install({
      id: survivorId,
      name: "survivor",
      actorUserId: host.ownerId,
      source: {},
      digest: "one",
      manifest: { name: "survivor" },
    });
    const survivorData = join(host.config.dataDirectory, "plugins", "data", survivorId);
    await mkdir(survivorData);
    await writeFile(join(survivorData, "pairing"), "retained");
    // Simulate a lost confirmation: the next attachment must repeat safely.
    await host.store.database
      .insertInto("runnerPluginDataRemovals")
      .values({ runnerId: capable.runnerId, pluginId: installed.id })
      .execute();
    await capable.disconnectModule();
    await capable.reconnectModule();
    await vi.waitFor(
      () =>
        expect(remove, "Cleanup was not re-sent on the next attachment").toHaveBeenCalledTimes(3),
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () =>
        expect(
          await store.plugins.pendingDataRemovals(capable.runnerId),
          "Repeat cleanup was not confirmed",
        ).toEqual([]),
      { timeout: 10_000 },
    );
    for (const close of closers.splice(0).reverse()) await close();
    await host.runtime.close();
    const restarted = await ownTestDatabaseProducer(database.url, () =>
      createHostRuntime(host.config, { logger: false }),
    );
    closers.push(() => restarted.close());
    await restarted.listen();
    await expect(readFile(join(hostData, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(packageData, "snapshot"), "utf8")).toBe("retained");
    expect(await readFile(join(survivorData, "pairing"), "utf8")).toBe("retained");
  } finally {
    for (const close of closers.reverse()) await close();
    await host.close();
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
