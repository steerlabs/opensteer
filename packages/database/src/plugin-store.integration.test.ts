import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { sql, type KyselyPlugin } from "kysely";
import { createIntegrationId } from "@opensteer/integration-core";
import { pluginsMigration } from "./migrations.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { testContinuationIdentity } from "./store.integration.test-support.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("plugin activation", (test) => {
  test("lists growing inventories with four queries and keeps Workspace filtering", async ({
    storeFixture: fixture,
  }) => {
    const run = await fixture.createRunFixture("plugin-query-count");
    let queries = 0;
    const counter: KyselyPlugin = {
      transformQuery({ node }) {
        queries += 1;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const platform = new IntegrationPlatformStore(fixture.database.withPlugin(counter));
    const install = async (name: string, workspaceId?: typeof run.workspace.id) => {
      await platform.plugins.install({
        id: randomUUID(),
        name,
        actorUserId: run.userId,
        ...(workspaceId ? { workspaceId } : {}),
        source: {},
        digest: name,
        manifest: { name },
      });
    };
    await install("first");
    queries = 0;
    expect(await platform.plugins.list()).toHaveLength(1);
    expect(queries).toBe(4);
    for (let index = 0; index < 12; index += 1) await install(`package-${index}`);
    await install("local", run.workspace.id);
    queries = 0;
    const rows = await platform.plugins.list(run.workspace.id);
    expect(rows).toHaveLength(14);
    expect(queries).toBe(4);
    expect(rows.every((row) => row.versions.length === 1)).toBe(true);
    expect(rows.find((row) => row.name === "local")?.activations).toHaveLength(1);
    const elsewhere = createId("workspace");
    queries = 0;
    expect(await platform.plugins.list(elsewhere)).toHaveLength(13);
    expect(queries).toBe(4);
  });
  test("Project creation and reconciliation preserve one conversation with Workspace authority", async ({
    storeFixture: fixture,
  }) => {
    const f = await fixture.createRunFixture("project-chat");
    const project = await createTestWorkspace(fixture.store, {
      backing: { ...f.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: f.userId,
      idempotencyKey: "chat-project",
      kind: "project",
      name: "Project",
      status: "ready",
    });
    expect(project.homeThreadId).toBeTruthy();
    const chat = await fixture.store.getThreadForOwner(project.homeThreadId!, f.userId);
    expect(chat).toMatchObject({
      workspaceId: project.id,
      role: "conversation",
      capabilityProfileId: "workspace",
      title: "Chat",
    });
    const turn = await fixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "Hello" }],
      idempotencyKey: "project-chat-run",
      requestedBy: f.userId,
      threadId: project.homeThreadId!,
    });
    await fixture.store.claimCommand(turn.command.id, "project-chat-dispatcher");
    await fixture.store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: f.harnessInstance.id,
      leaseTokenHash: "project-chat-lease",
      membershipGeneration: 1,
      runnerBootId: "project-chat-boot",
      runnerId: f.runnerId,
      runId: turn.run.id,
      threadId: project.homeThreadId!,
    });
    expect(await fixture.store.runCapabilityScope(turn.run.id)).toMatchObject({
      capabilityProfileId: "workspace",
      workspaceId: project.id,
    });
    await fixture.database
      .updateTable("workspaces")
      .set({ homeThreadId: null })
      .where("id", "=", project.id)
      .execute();
    // A pre-overhaul Project has no home pointer or chat-creation command.
    await fixture.database
      .deleteFrom("commands")
      .where("idempotencyKey", "=", `project-chat:${project.id}`)
      .execute();
    const first = (await fixture.store.listWorkspaces()).find((w) => w.id === project.id)!;
    const second = (await fixture.store.listWorkspaces()).find((w) => w.id === project.id)!;
    expect(first.homeThreadId).toBeTruthy();
    expect(second.homeThreadId).toBe(first.homeThreadId);
    expect(await fixture.store.getThreadForOwner(first.homeThreadId!, f.userId)).toMatchObject({
      role: "conversation",
      capabilityProfileId: "workspace",
    });
  });

  test("members list only available plugins without installation paths and only owners change activation", async ({
    storeFixture: fixture,
  }) => {
    const f = await fixture.createRunFixture("plugin-members");
    const project = await createTestWorkspace(fixture.store, {
      backing: { ...f.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: f.userId,
      idempotencyKey: "plugin-project",
      kind: "project",
      name: "Project",
      status: "ready",
    });
    const member = await fixture.store.createUser("Member");
    const outsider = await fixture.store.createUser("Outsider");
    await fixture.database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: project.id,
        userId: member,
        generation: 1,
        invitedBy: f.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
      })
      .execute();
    const plugins = new IntegrationPlatformStore(fixture.database).plugins;
    const deploymentId = randomUUID(),
      localId = randomUUID(),
      otherId = randomUUID();
    for (const [id, workspaceId] of [
      [deploymentId, undefined],
      [localId, project.id],
      [otherId, f.workspace.id],
    ] as const) {
      await plugins.install({
        id,
        name: id,
        actorUserId: f.userId,
        ...(workspaceId ? { workspaceId } : {}),
        source: { directory: "/private/install-source" },
        digest: "a".repeat(64),
        manifest: {
          name: id,
          skills: [{ path: "/private/skill-path" }],
          mcpServers: { path: "/private/server-path" },
        },
      });
    }
    await plugins.setActivation({
      pluginId: deploymentId,
      workspaceId: project.id,
      actorUserId: f.userId,
      active: true,
    });
    await plugins.setActivation({
      pluginId: deploymentId,
      workspaceId: f.workspace.id,
      actorUserId: f.userId,
      active: true,
    });
    const listed = await plugins.listForUser(member, project.id);
    expect(listed.map((p) => p.id).sort()).toEqual([deploymentId, localId].sort());
    expect(JSON.stringify(listed)).not.toContain("/private/");
    expect(listed.find((p) => p.id === deploymentId)?.activations).toEqual([
      { workspaceId: project.id },
    ]);
    await expect(plugins.listForUser(member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(plugins.listForUser(outsider, project.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      plugins.setActivation({
        pluginId: deploymentId,
        workspaceId: project.id,
        actorUserId: member,
        active: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await plugins.setActivation({
      pluginId: deploymentId,
      workspaceId: project.id,
      actorUserId: f.userId,
      active: false,
    });
    await fixture.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", outsider)
      .execute();
    expect(JSON.stringify(await plugins.listForUser(outsider))).toContain(
      "/private/install-source",
    );
  });
  test("installs without grants, refuses reserved names and serializes name clashes", async ({
    storeFixture: fixture,
  }) => {
    const database = fixture.database;
    const run = await fixture.createRunFixture("plugin-" + randomUUID());
    const store = new IntegrationPlatformStore(database);
    const make = (id: string, name: string) => ({
      id,
      name,
      actorUserId: run.userId,
      source: { directory: "/fixture" },
      digest: "a".repeat(64),
      manifest: { name, skills: [{ name: "example" }] },
    });
    await expect(store.plugins.install(make(randomUUID(), "opensteer"))).rejects.toThrow(
      "reserved",
    );
    const first = randomUUID(),
      second = randomUUID();
    await store.plugins.install(make(first, "example"));
    await store.plugins.install(make(second, "example"));
    expect(await store.plugins.current(run.workspace.id)).toEqual([]);
    expect(await fixture.database.selectFrom("integrationGrants").selectAll().execute()).toEqual(
      [],
    );
    const results = await Promise.allSettled(
      [first, second].map((pluginId) =>
        store.plugins.setActivation({
          pluginId,
          workspaceId: run.workspace.id,
          actorUserId: run.userId,
          active: true,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const active = await store.plugins.current(run.workspace.id);
    expect(active).toHaveLength(1);
    await store.plugins.setActivation({
      pluginId: active[0]!.id,
      workspaceId: run.workspace.id,
      actorUserId: run.userId,
      active: false,
    });
    expect(await store.plugins.current(run.workspace.id)).toEqual([]);
  });
  test("a workspace package auto-activates only in its Workspace", async ({
    storeFixture: fixture,
  }) => {
    const database = fixture.database;
    const run = await fixture.createRunFixture("plugin-" + randomUUID());
    const store = new IntegrationPlatformStore(database);
    const id = randomUUID();
    await store.plugins.install({
      id,
      name: "local",
      actorUserId: run.userId,
      workspaceId: run.workspace.id,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "local" },
    });
    expect(await store.plugins.current(run.workspace.id)).toEqual([
      expect.objectContaining({ id }),
    ]);
    expect(await store.plugins.list()).toEqual([
      expect.objectContaining({ scope: "workspace", workspaceId: run.workspace.id }),
    ]);
  });
  test("migrates installed packages and preserves MCP servers and grants", async ({
    storeFixture: fixture,
  }) => {
    const run = await fixture.createRunFixture("plugin-migration");
    const platform = new IntegrationPlatformStore(fixture.database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      actorUserId: run.userId,
      adapterSnapshot: null,
      requestId: randomUUID(),
      installation: {
        id: installationId,
        name: "legacy-package",
        title: "Legacy",
        description: "",
        version: "1",
        sourceKind: "plugin",
        trust: "administrator-approved",
        manifest: { name: "legacy-package" },
        provenance: { snapshotDigest: "a".repeat(64) },
        status: "active",
      },
      servers: [
        {
          id: serverId,
          name: "remote",
          transport: { type: "streamable-http", url: "https://example.test/mcp", headers: {} },
          connectionRequirement: { kind: "none" },
          catalog: { definitions: {}, tools: [] },
          status: "active",
          statusDetail: null,
        },
      ],
    });
    await platform.createGrant({
      access: "read",
      alias: "legacy",
      connectionId: null,
      createdBy: run.userId,
      installationId,
      isDefault: true,
      ownerUserId: run.userId,
      providerAuthorizations: {},
      workspaceId: run.workspace.id,
    });
    await fixture.database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE integration_installations DROP COLUMN plugin_id;
        DROP TABLE specialists; DROP TABLE plugin_activations; ALTER TABLE plugins DROP CONSTRAINT plugins_current_version;
        DROP TABLE plugin_versions; DROP TABLE plugins;
        CREATE TABLE integration_skills (id text, installation_id text, name text,description text,digest text,status text);
        `.execute(tx);
      await sql`INSERT INTO integration_skills VALUES ('skill',${installationId},'example','Example','digest','active')`.execute(
        tx,
      );
      await sql`UPDATE integration_installations SET source_kind='agent-plugin' WHERE id=${installationId}`.execute(
        tx,
      );
      await pluginsMigration.up(tx);
    });
    expect(await platform.plugins.current(run.workspace.id)).toEqual([
      expect.objectContaining({
        id: installationId,
        digest: "a".repeat(64),
        manifest: expect.objectContaining({
          skills: [expect.objectContaining({ name: "example" })],
        }),
      }),
    ]);
    expect(await platform.listServers(installationId)).toEqual([
      expect.objectContaining({ id: serverId }),
    ]);
    expect(
      await platform.listGrants({ ownerUserId: run.userId, workspaceId: run.workspace.id }),
    ).toHaveLength(1);
    expect(await platform.listInstallations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: installationId,
          sourceKind: "plugin",
          pluginId: installationId,
        }),
      ]),
    );
  });
});
