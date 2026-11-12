import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  PluginSettingsStore,
  projectLooseSkillRows,
  type AgentHomeSkillInventory,
} from "./plugin-settings-store.js";
import { PluginStore } from "./plugin-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("personal plugin settings", (test) => {
  test("keeps Off durable, replays its receipt and rejects stale or changed retries", async ({
    storeFixture: f,
  }) => {
    const owner = await f.createRunFixture("settings-revision");
    const pluginId = randomUUID();
    const plugins = new PluginStore(f.database),
      settings = new PluginSettingsStore(f.database);
    await plugins.install({
      id: pluginId,
      name: "private",
      actorUserId: owner.userId,
      source: { directory: "/private/plugin" },
      digest: "first",
      manifest: { name: "private" },
    });
    const command = {
      type: "settings.plugin.enabled.set",
      target: { kind: "plugin", pluginId },
      enabled: false,
      expectedRevision: 0,
      idempotencyKey: "disable",
    } as const;
    const disabled = await settings.setEnabled(owner.userId, command);
    expect(await settings.setEnabled(owner.userId, command)).toEqual(disabled);
    await expect(
      settings.setEnabled(owner.userId, { ...command, enabled: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      settings.setEnabled(owner.userId, { ...command, enabled: true, idempotencyKey: "stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await plugins.current(owner.userId)).toEqual([]);
    await settings.setEnabled(owner.userId, {
      ...command,
      enabled: true,
      expectedRevision: 1,
      idempotencyKey: "enable",
    });
    expect(await plugins.current(owner.userId)).toMatchObject([{ id: pluginId }]);
    const outsider = await f.store.createUser("Other person");
    await expect(settings.overview(outsider)).rejects.toMatchObject({ code: "forbidden" });
    await expect(settings.detail(outsider, command.target)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      settings.setEnabled(outsider, { ...command, idempotencyKey: "other" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("lists Agent home skills and applies one personal skill switch", async ({
    storeFixture: f,
  }) => {
    const owner = await f.createRunFixture("settings-skills");
    const skill = { fullName: "notes", description: "Local notes", digest: "a".repeat(64) };
    const inventory: AgentHomeSkillInventory = {
      observedAt: new Date().toISOString(),
      scanStatus: "complete",
      stale: false,
      skills: [skill],
    };
    const settings = new PluginSettingsStore(f.database, async () => inventory);
    expect(projectLooseSkillRows(inventory, [])).toMatchObject([
      { target: { kind: "skill", fullName: "notes" }, issues: [] },
    ]);
    expect((await settings.overview(owner.userId)).rows).toHaveLength(1);
    await settings.setEnabled(owner.userId, {
      type: "settings.plugin.enabled.set",
      target: { kind: "skill", fullName: "notes" },
      enabled: false,
      expectedRevision: 0,
      idempotencyKey: "skill-off",
    });
    expect(await settings.skillPolicy(owner.userId)).toEqual({
      revision: 1,
      disabledFullNames: ["notes"],
    });
  });
});
