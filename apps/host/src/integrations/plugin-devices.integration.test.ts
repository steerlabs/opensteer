import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { expect, vi } from "vitest";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { IntegrationPlatformStore, personalReachableGrant } from "@opensteer/database";
import {
  enrollTestRunner,
  describeStore,
  reachOnlyModules,
} from "@opensteer/database/test-support/store";
import { IntegrationPlatformService } from "./integration-platform-service.js";
import { executeIntegrationAdministration } from "./integration-administration.js";

describeStore("plugin devices", (test) => {
  test("agent installs retain their nearest task, personal devices and refresh approval context", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("plugin-device");
    const pluginComputerId = createId("runner");
    await f.enablePersonalRemoteAccess();
    await enrollTestRunner(f.store, {
      allowedModules: personalReachableGrant,
      modules: reachOnlyModules,
      createdBy: run.userId,
      runnerKind: "local",
      runnerId: pluginComputerId,
      environmentId: createId("environment"),
      name: "Plugin computer",
      tokenSuffix: "initial-plugin-device",
    });
    const platform = new IntegrationPlatformStore(f.database);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-device-"));
    const changed = vi.fn();
    const service = new IntegrationPlatformService({
      store: platform,
      dataDirectory: directory,
      adapters: [],
      definitions: [],
      authorizationSource: { providerAuthorizations: async () => ({}) },
      listConnections: async () => [],
      credentialMaterializer: {} as ConstructorParameters<
        typeof IntegrationPlatformService
      >[0]["credentialMaterializer"],
      computerApps: {} as ConstructorParameters<
        typeof IntegrationPlatformService
      >[0]["computerApps"],
      isRunnerConnected: () => false,
      mcpOauth: {} as ConstructorParameters<typeof IntegrationPlatformService>[0]["mcpOauth"],
      secretVault: new AesGcmSecretVault(
        new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
      ),
      onDeploymentEvent: () => undefined,
      onConnectionsChanged: changed,
      onRequestsChanged: () => undefined,
    });
    try {
      const pluginDirectory = join(directory, "source");
      await mkdir(pluginDirectory);
      await writeFile(
        join(pluginDirectory, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "camera-fixture",
          extensions: {
            "com.opensteer": { device: { name: "Main Bedroom Apple TV", kind: "tv" } },
          },
        }),
      );
      await writeFile(
        join(pluginDirectory, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { camera: { type: "stdio", command: "node", args: ["server.cjs"] } },
        }),
      );
      const parent = await f.database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", run.thread.id)
        .executeTakeFirstOrThrow();
      const child = {
        ...parent,
        id: createId("thread"),
        parentThreadId: run.thread.id,
        listed: false,
        title: "Child",
      };
      await f.database.insertInto("threads").values(child).execute();
      const input = {
        actorUserId: run.userId,
        directory: pluginDirectory,

        runnerId: pluginComputerId,
        threadId: child.id,
        requestId: randomUUID(),
      };
      const installed = await service.installAgentPlugin(input);
      const pluginId = installed.installation.pluginId!;
      expect(installed.installation.title).toBe("Main Bedroom Apple TV");
      expect((await platform.plugins.list())[0]?.setupThreadId).toBe(run.thread.id);
      const detail = await platform.settings.detail(run.userId, { kind: "plugin", pluginId });
      expect(detail).toMatchObject({
        setupThreadId: run.thread.id,
        row: {
          device: { name: "Main Bedroom Apple TV", kind: "tv" },
          permissions: { canRemove: true },
        },
      });
      const devices = await platform.settings.otherDevices(run.userId, [
        { id: pluginComputerId, name: "Computer", status: "offline" },
      ]);
      const serverStatus = await f.database
        .selectFrom("integrationServers")
        .select("statusDetail")
        .executeTakeFirstOrThrow();
      expect(serverStatus.statusDetail).not.toBeNull();
      expect(devices).toMatchObject([
        {
          pluginId,
          computer: { id: pluginComputerId, status: "offline" },
          issue: serverStatus.statusDetail,
          setupThreadId: run.thread.id,
        },
      ]);
      const request = () =>
        f.database
          .selectFrom("computerAppSetupRequests")
          .selectAll()
          .where("kind", "=", "server")
          .executeTakeFirstOrThrow();
      expect(await request()).toMatchObject({
        threadId: run.thread.id,

        threadTitle: run.thread.title,
      });
      const secondTask = { ...parent, id: createId("thread"), title: "Second task" };
      secondTask.lineageRootThreadId = secondTask.id;
      await f.database.insertInto("threads").values(secondTask).execute();
      await service.installAgentPlugin({
        ...input,
        threadId: secondTask.id,
        requestId: randomUUID(),
      });
      expect((await platform.plugins.list())[0]?.versions).toHaveLength(1);
      expect((await platform.plugins.list())[0]?.setupThreadId).toBe(secondTask.id);
      expect(await request()).toMatchObject({ threadId: secondTask.id });
      await writeFile(join(pluginDirectory, "server.cjs"), "// Updated device server\n");
      await service.installAgentPlugin({
        ...input,
        threadId: run.thread.id,
        requestId: randomUUID(),
      });
      expect((await platform.plugins.list())[0]).toMatchObject({ setupThreadId: run.thread.id });
      expect((await platform.plugins.list())[0]?.versions).toHaveLength(2);
      const moved = { runnerId: createId("runner"), userId: run.userId };
      await f.enablePersonalRemoteAccess();
      await enrollTestRunner(f.store, {
        allowedModules: personalReachableGrant,
        modules: reachOnlyModules,
        createdBy: run.userId,
        runnerKind: "local",
        runnerId: moved.runnerId,
        environmentId: createId("environment"),
        name: "Second computer",
        tokenSuffix: "moved-device",
      });
      await f.database
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", pluginComputerId)
        .execute();
      await service.installAgentPlugin({
        ...input,
        runnerId: moved.runnerId,
        requestId: randomUUID(),
      });
      expect(
        await f.database
          .selectFrom("runnerPluginDataRemovals")
          .selectAll()
          .where("runnerId", "=", pluginComputerId)
          .where("pluginId", "=", pluginId)
          .execute(),
      ).toHaveLength(1);
      expect(await platform.plugins.pendingDataRemovals(pluginComputerId)).toEqual([]);
      await writeFile(
        join(pluginDirectory, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { replacement: { type: "stdio", command: "node", args: ["server.cjs"] } },
        }),
      );
      await service.installAgentPlugin({
        ...input,
        runnerId: moved.runnerId,
        requestId: randomUUID(),
      });
      // Historical rows from before retirement cleared their status detail must be ignored too.
      const retired = await f.database
        .selectFrom("integrationServers")
        .select("transport")
        .where("name", "=", "camera")
        .executeTakeFirstOrThrow();
      await f.database
        .updateTable("integrationServers")
        .set({
          statusDetail: "Old failure",
          transport: { ...retired.transport, runnerId: pluginComputerId },
        })
        .where("name", "=", "camera")
        .execute();
      const replacementRequest = (await platform.listComputerAppSetupRequests(moved.userId)).find(
        (r) => r.server?.name === "replacement",
      );
      if (!replacementRequest) throw new Error("Replacement approval was not opened");
      await platform.localMcp.decline({
        actorUserId: moved.userId,
        runnerId: moved.runnerId,
        setupRequestId: replacementRequest.id,
      });
      const currentDevice = (
        await platform.settings.otherDevices(run.userId, [
          { id: pluginComputerId, name: "Old", status: "offline" },
          { id: moved.runnerId, name: "New", status: "online" },
        ])
      )[0];
      expect(currentDevice?.computer?.id).toBe(moved.runnerId);
      expect(currentDevice?.issue).toContain("declined");
      expect(currentDevice?.issue).not.toContain("Old failure");
      const personViewer = run.userId;
      await writeFile(
        join(pluginDirectory, "plugin.json"),
        JSON.stringify({ name: "person-camera-fixture" }),
      );
      const person = await service.installAgentPlugin({
        actorUserId: personViewer,
        directory: pluginDirectory,
        runnerId: moved.runnerId,
        requestId: randomUUID(),
      });
      const personId = person.installation.pluginId!;
      expect(
        (await platform.plugins.list()).find((p) => p.id === personId)?.setupThreadId,
      ).toBeNull();
      await platform.plugins.recordSetupThread(personId, run.thread.id);
      await writeFile(join(pluginDirectory, "server.cjs"), "// Person updated device server\n");
      await service.installAgentPlugin({
        actorUserId: personViewer,
        pluginId: personId,
        directory: pluginDirectory,
        runnerId: moved.runnerId,
        requestId: randomUUID(),
      });
      expect((await platform.plugins.list()).find((p) => p.id === personId)?.setupThreadId).toBe(
        run.thread.id,
      );
      expect(
        (await platform.settings.detail(personViewer, { kind: "plugin", pluginId: personId }))
          .setupThreadId,
      ).toBe(run.thread.id);
      expect(
        (await platform.settings.otherDevices(personViewer, [])).find(
          (p) => p.pluginId === personId,
        )?.setupThreadId,
      ).toBe(run.thread.id);
      const installationRow = await f.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("id", "=", installed.installation.id)
        .executeTakeFirstOrThrow();
      await f.database
        .insertInto("integrationInstallations")
        .values({
          ...installationRow,
          id: pluginId as typeof installationRow.id,
          name: "legacy-data-name",
        })
        .execute();
      const legacy = join(directory, "plugins", "data", "legacy-data-name");
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "pairing"), "retained");
      const orphan = join(directory, "plugins", "data", "failed-install");
      await mkdir(orphan);
      await writeFile(join(orphan, "pairing"), "stranded");
      await service.recoverPluginData();
      expect(await readFile(join(legacy, "pairing"), "utf8")).toBe("retained");
      await expect(readFile(join(orphan, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removal and canRemove require the personal owner and preserve data on refusal", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("device-remove");
    const platform = new IntegrationPlatformStore(f.database);
    const foreign = createId("user");
    const directory = await mkdtemp(join(tmpdir(), "plugin-removal-authority-"));
    const removeRunnerData = vi.fn(async () => undefined);
    const service = new IntegrationPlatformService({
      store: platform,
      dataDirectory: directory,
      adapters: [],
      definitions: [],
      authorizationSource: { providerAuthorizations: async () => ({}) },
      listConnections: async () => [],
      credentialMaterializer: {} as ConstructorParameters<
        typeof IntegrationPlatformService
      >[0]["credentialMaterializer"],
      computerApps: { removePluginData: removeRunnerData } as unknown as ConstructorParameters<
        typeof IntegrationPlatformService
      >[0]["computerApps"],
      isRunnerConnected: () => false,
      mcpOauth: {} as ConstructorParameters<typeof IntegrationPlatformService>[0]["mcpOauth"],
      secretVault: new AesGcmSecretVault(
        new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
      ),
      onDeploymentEvent: () => undefined,
      onConnectionsChanged: () => undefined,
      onRequestsChanged: () => undefined,
    });
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(
        join(source, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "removable",
        }),
      );
      await writeFile(
        join(source, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { device: { type: "stdio", command: "node" } },
        }),
      );
      const install = () =>
        service.installAgentPlugin({
          actorUserId: run.userId,

          runnerId: run.runnerId,
          directory: source,
          requestId: randomUUID(),
        });
      const installed = await install(),
        pluginId = installed.installation.pluginId!,
        target = { kind: "plugin", pluginId } as const;
      const data = join(directory, "plugins", "data", pluginId, "pairing");
      await writeFile(data, "retained");
      expect((await platform.settings.detail(run.userId, target)).row.permissions.canRemove).toBe(
        true,
      );
      await expect(platform.settings.detail(foreign, target)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        platform.plugins.assertCanRemove(pluginId, { userId: foreign }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        executeIntegrationAdministration(
          { platform: service },
          { userId: foreign },
          { type: "plugin.remove", pluginId, idempotencyKey: "denied" },
          "denied",
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await platform.plugins.list()).some((p) => p.id === pluginId)).toBe(true);
      expect(
        (await platform.listInstallations()).some((i) => i.id === installed.installation.id),
      ).toBe(true);
      expect(await readFile(data, "utf8")).toBe("retained");
      expect(await f.database.selectFrom("runnerPluginDataRemovals").selectAll().execute()).toEqual(
        [],
      );
      expect(removeRunnerData).not.toHaveBeenCalled();
      await executeIntegrationAdministration(
        { platform: service },
        { userId: run.userId },
        { type: "plugin.remove", pluginId, idempotencyKey: "remove" },
        "remove",
      );
      expect((await platform.plugins.list()).some((p) => p.id === pluginId)).toBe(false);
      expect((await platform.listInstallations()).some((i) => i.pluginId === pluginId)).toBe(false);
      await expect(readFile(data)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
