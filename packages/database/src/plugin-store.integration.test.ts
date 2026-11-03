import { sql } from "kysely";
import { createIntegrationId } from "@opensteer/integration-core";
import { pluginsMigration } from "./migrations.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("plugin activation", (test) => {
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
        DROP TABLE plugin_activations; ALTER TABLE plugins DROP CONSTRAINT plugins_current_version;
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
