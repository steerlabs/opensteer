import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { expect, vi } from "vitest";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { IntegrationPlatformStore } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { IntegrationPlatformService } from "./integration-platform-service.js";
import { executeIntegrationAdministration } from "./integration-administration.js";

describeStore("plugin devices", (test) => {
  test("agent installs retain their nearest task, project devices and refresh approval context", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("plugin-device", {
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
      workspaceBacking: "local-directory",
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
      onWorkspaceEvent: () => undefined,
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
        workspaceId: run.workspace.id,
        runnerId: run.runnerId,
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
        { id: run.runnerId, name: "Computer", status: "offline" },
      ]);
      const serverStatus = await f.database
        .selectFrom("integrationServers")
        .select("statusDetail")
        .executeTakeFirstOrThrow();
      expect(serverStatus.statusDetail).not.toBeNull();
      expect(devices).toMatchObject([
        {
          pluginId,
          computer: { id: run.runnerId, status: "offline" },
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
        workspaceId: run.workspace.id,
        threadTitle: run.thread.title,
      });
      expect(changed).toHaveBeenCalled();
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
      const personViewer = await f.store.createUser("Person installer");
      const person = await service.installAgentPlugin({
        actorUserId: personViewer,
        directory: pluginDirectory,
        runnerId: run.runnerId,
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
        runnerId: run.runnerId,
        requestId: randomUUID(),
      });
      expect((await platform.plugins.list()).find((p) => p.id === personId)?.setupThreadId).toBe(
        run.thread.id,
      );
      expect(
        (await platform.settings.detail(personViewer, { kind: "plugin", pluginId: personId }))
          .setupThreadId,
      ).toBeNull();
      expect(
        (await platform.settings.otherDevices(personViewer, [])).find(
          (p) => p.pluginId === personId,
        )?.setupThreadId,
      ).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removal and canRemove use the same administrator or workspace-installer rule", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("device-remove");
    const platform = new IntegrationPlatformStore(f.database);
    const member = await f.store.createUser("Member");
    const admin = await f.store.createUser("Administrator");
    await f.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", admin)
      .execute();
    for (const userId of [member, admin])
      await f.database
        .insertInto("workspaceMemberships")
        .values({
          id: createId("workspaceMembership"),
          workspaceId: run.workspace.id,
          userId,
          state: "active",
          role: "collaborator",
          generation: 1,
          invitedBy: run.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          updatedAt: new Date(),
        })
        .execute();
    const pluginId = randomUUID();
    const install = () =>
      platform.plugins.install({
        id: pluginId,
        name: "removable",
        actorUserId: run.userId,
        workspaceId: run.workspace.id,
        source: {},
        digest: "one",
        manifest: { name: "removable" },
      });
    await install();
    expect(await platform.settings.otherDevices(member, [])).toEqual([]);
    const target = { kind: "plugin", pluginId } as const;
    for (const [userId, allowed] of [
      [run.userId, true],
      [member, false],
      [admin, true],
    ] as const) {
      expect((await platform.settings.detail(userId, target)).row.permissions.canRemove).toBe(
        allowed,
      );
    }
    const options = { platform: { store: platform } as unknown as IntegrationPlatformService };
    await expect(
      executeIntegrationAdministration(
        options,
        { userId: member, isAdministrator: false },
        { type: "plugin.remove", pluginId, idempotencyKey: "denied" },
        "denied",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const [userId, isAdministrator] of [
      [run.userId, false],
      [admin, true],
    ] as const) {
      await executeIntegrationAdministration(
        options,
        { userId, isAdministrator },
        { type: "plugin.remove", pluginId, idempotencyKey: randomUUID() },
        randomUUID(),
      );
      expect((await platform.plugins.list()).find((p) => p.id === pluginId)).toBeUndefined();
      if (!isAdministrator) await install();
    }
    await platform.plugins.install({
      id: pluginId,
      name: "deployment",
      actorUserId: run.userId,
      source: {},
      digest: "one",
      manifest: { name: "deployment" },
    });
    expect((await platform.settings.detail(run.userId, target)).row.permissions.canRemove).toBe(
      false,
    );
    await expect(
      platform.plugins.assertCanRemove(pluginId, { userId: run.userId, isAdministrator: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
