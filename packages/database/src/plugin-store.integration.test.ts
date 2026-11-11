import { randomUUID } from "node:crypto";
import type { KyselyPlugin } from "kysely";
import { expect } from "vitest";
import { PluginStore } from "./plugin-store.js";
import { PluginSettingsStore } from "./plugin-settings-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("personal plugin packages", (test) => {
  test("updates package versions without changing the owner's Off setting", async ({
    storeFixture: f,
  }) => {
    const owner = await f.createRunFixture("plugin-update");
    const plugins = new PluginStore(f.database),
      settings = new PluginSettingsStore(f.database);
    const pluginId = randomUUID();
    await plugins.install({
      id: pluginId,
      name: "mine",
      actorUserId: owner.userId,
      source: {},
      digest: "old",
      manifest: { name: "mine" },
    });
    await settings.setEnabled(owner.userId, {
      type: "settings.plugin.enabled.set",
      target: { kind: "plugin", pluginId },
      enabled: false,
      expectedRevision: 0,
      idempotencyKey: "off",
    });
    await plugins.update({ pluginId, digest: "new", manifest: { name: "mine" } });
    expect((await plugins.list())[0]!.versions).toHaveLength(2);
    expect(await plugins.current(owner.userId)).toEqual([]);
    await expect(
      plugins.update({ pluginId, digest: "renamed", manifest: { name: "changed" } }),
    ).rejects.toThrow("keep its name");
    expect((await plugins.list())[0]!.versions).toHaveLength(2);
  });

  test("reads growing inventories with a fixed number of queries", async ({ storeFixture: f }) => {
    const owner = await f.createRunFixture("plugin-query-count");
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
    const plugins = new PluginStore(f.database.withPlugin(counter));
    const install = (name: string) =>
      plugins.install({
        id: randomUUID(),
        name,
        actorUserId: owner.userId,
        source: {},
        digest: name,
        manifest: { name },
      });
    await install("first");
    queries = 0;
    expect(await plugins.list()).toHaveLength(1);
    const baseline = queries;
    for (let i = 0; i < 12; i++) await install(`package-${i}`);
    queries = 0;
    expect(await plugins.list()).toHaveLength(13);
    expect(queries).toBe(baseline);
  });

  test("reserves Opensteer's name and requires the personal owner", async ({ storeFixture: f }) => {
    const owner = await f.createRunFixture("plugin-owner");
    const plugins = new PluginStore(f.database);
    const outsider = await f.store.createUser("Other person");
    const install = (name: string, actorUserId = owner.userId) =>
      plugins.install({
        id: randomUUID(),
        name,
        actorUserId,
        source: {},
        digest: name,
        manifest: { name },
      });
    await expect(install("opensteer")).rejects.toThrow("reserved");
    await expect(install("private", outsider)).rejects.toMatchObject({ code: "forbidden" });
    await install("example");
    expect(await f.database.selectFrom("integrationGrants").selectAll().execute()).toEqual([]);
    await expect(plugins.listForUser(outsider)).rejects.toMatchObject({ code: "forbidden" });
  });
});
