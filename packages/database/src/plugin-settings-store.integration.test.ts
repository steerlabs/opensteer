import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { KyselyPlugin } from "kysely";
import { PluginSettingsStore, pluginTargetKey } from "./plugin-settings-store.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("plugin Settings authority", (test) => {
  test("overview is set based, membership scoped and never exposes source paths", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-viewer");
    const plugins = new IntegrationPlatformStore(f.database).plugins;
    let queries = 0;
    const counter: KyselyPlugin = {
      transformQuery({ node }) {
        queries++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const settings = new PluginSettingsStore(f.database.withPlugin(counter));
    const install = (name: string) =>
      plugins.install({
        id: randomUUID(),
        name,
        actorUserId: run.userId,
        workspaceId: run.workspace.id,
        source: { directory: "/private/plugin-source" },
        digest: name,
        manifest: { name, skills: [] },
      });
    await install("first");
    queries = 0;
    expect((await settings.overview(run.userId)).rows).toHaveLength(1);
    const small = queries;
    for (let i = 0; i < 15; i++) await install(`package-${i}`);
    queries = 0;
    const overview = await settings.overview(run.userId);
    expect(overview.rows).toHaveLength(16);
    expect(queries).toBe(small);
    expect(JSON.stringify(overview)).not.toContain("/private/plugin-source");
    const outsider = await f.store.createUser("outsider");
    expect((await settings.overview(outsider)).rows).toEqual([]);
  });

  test("Off preserves activation, owner management and idempotent results while filtering the Run plan", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-off");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "off-plugin",
      actorUserId: run.userId,
      workspaceId: run.workspace.id,
      source: { directory: "/private/source" },
      digest: "off",
      manifest: { name: "off-plugin" },
    });
    const target = { kind: "plugin" as const, pluginId };
    const command = {
      type: "settings.plugin.enabled.set" as const,
      target,
      expectedRevision: 0,
      enabled: false,
      idempotencyKey: "disable-plugin",
    };
    expect(await platform.settings.setEnabled(run.userId, command)).toMatchObject({
      placement: { enabled: false, revision: 1 },
    });
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toEqual([]);
    expect(await platform.plugins.current(run.workspace.id)).toHaveLength(1);
    expect(await platform.settings.detail(run.userId, target)).toMatchObject({
      sourceFolder: "/private/source",
      row: { permissions: { canUpdate: true }, placement: { enabled: false } },
    });
    expect(await platform.settings.setEnabled(run.userId, command)).toMatchObject({
      placement: { revision: 1 },
    });
    await expect(
      platform.settings.setEnabled(run.userId, { ...command, enabled: true }),
    ).rejects.toThrow();
    await platform.settings.setEnabled(run.userId, {
      ...command,
      enabled: true,
      expectedRevision: 1,
      idempotencyKey: "enable-plugin",
    });
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toHaveLength(1);
    expect(pluginTargetKey(target)).toBe(pluginTargetKey({ pluginId, kind: "plugin" }));
  });
  test("Main exclusion filters an explicit package activation without removing it", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-main");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "main-plugin",
      actorUserId: run.userId,
      source: {},
      digest: "main",
      manifest: { name: "main-plugin" },
    });
    await platform.plugins.setActivation({
      pluginId,
      workspaceId: run.workspace.id,
      actorUserId: run.userId,
      active: true,
    });
    const target = { kind: "plugin" as const, pluginId };
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: 0,
        idempotencyKey: "exclude-main",
        mainIncluded: false,
        projects: [],
        personalEverywhere: null,
      },
      {},
    );
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toEqual([]);
    expect(await platform.plugins.current(run.workspace.id)).toHaveLength(1);
  });

  test("Personal Everywhere grants future Projects under explicit package consent; server refuses", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-future", {
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      workspaceBacking: "local-directory",
    });
    const platform = new IntegrationPlatformStore(f.database);
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "future-plugin",
      actorUserId: run.userId,
      source: {},
      digest: "future",
      manifest: { name: "future-plugin" },
    });
    const target = { kind: "plugin" as const, pluginId };
    const command = {
      type: "settings.plugin.placement.set" as const,
      target,
      expectedRevision: 0,
      idempotencyKey: "everywhere",
      mainIncluded: true,
      projects: [],
      personalEverywhere: { accounts: [] },
    };
    await platform.settings.setPlacement(run.userId, command, {});
    const project = await createTestWorkspace(f.store, {
      backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: run.userId,
      idempotencyKey: "future-project",
      kind: "project",
      name: "Future",
      status: "ready",
    });
    expect(await platform.plugins.current(project.id, run.userId)).toHaveLength(1);
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    await expect(
      platform.settings.setPlacement(
        run.userId,
        {
          ...command,
          expectedRevision: 1,
          idempotencyKey: "server-everywhere",
          projects: [{ workspaceId: project.id, accounts: [] }],
        },
        {},
      ),
    ).rejects.toThrow("explicit consent");
  });
});
